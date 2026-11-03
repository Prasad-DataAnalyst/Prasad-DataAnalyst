//! Parquet import (src/formats/parquet/import.ts), read through DuckDB's Parquet reader. The
//! columns are the top-level fields of the file's schema, in file order, and each value becomes
//! the raw field the TypeScript reader makes of it (hyparquet with Tracewell's parsers):
//!
//! - numbers, booleans and text as they are; an integer beyond 2^53, a NaN or an infinity as text;
//! - a DATE as a date cell; a decimal as its unscaled value times 10^-scale;
//! - a timestamp as a date-time cell when it is a whole millisecond, else as ISO text with every
//!   stored digit; an instant (a legacy TIMESTAMP_MILLIS or _MICROS, or a TIMESTAMP adjusted to
//!   UTC) as ISO text ending in 'Z', so detection sees its zone;
//! - bytes without an annotation as UTF-8 text, fixed-length ones as hexadecimal text ('0x...');
//! - lists, maps, structs and JSON values as JSON text, written as JSON.stringify writes it.

use crate::error::{EngineError, Result};
use crate::import::{quote_ident, quote_text};
use crate::parse::Raw;
use duckdb::Connection;
use duckdb::types::{TimeUnit, ValueRef};
use serde_json::{Value, json};
use std::path::Path;

/// A JavaScript Date's range, in milliseconds either side of the epoch.
const MAX_DATE_MS: f64 = 8.64e15;
const MS_PER_DAY: i64 = 86_400_000;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Unit {
    Millis,
    Micros,
    Nanos,
}

impl Unit {
    /// Stored units to the millisecond, and the digits of a second's fraction.
    fn per_ms(self) -> (i64, usize) {
        match self {
            Unit::Millis => (1, 3),
            Unit::Micros => (1000, 6),
            Unit::Nanos => (1_000_000, 9),
        }
    }
}

/// How a top-level column is read.
#[derive(Clone, Debug)]
enum Read {
    Plain,
    /// A timestamp in its stored unit; `utc` says whether it is an instant (Some(true)), a local
    /// time (Some(false)) or neither (None, an INT96).
    Timestamp {
        unit: Unit,
        utc: Option<bool>,
    },
    /// A list, map or struct, read as DuckDB's JSON of it.
    Nested,
    /// A JSON value, kept as JSON text (or as the text, number or boolean it is).
    Json,
    /// Bytes without an annotation: UTF-8 text, or hexadecimal when of fixed length.
    Bytes {
        fixed: bool,
    },
}

/// What the footer says: the columns, how each is read, and the row and row-group counts.
pub struct Meta {
    pub names: Vec<String>,
    pub rows: u64,
    pub row_groups: u64,
    /// Columns that hold lists, maps or structs.
    pub nested: Vec<String>,
    reads: Vec<Read>,
}

fn not_parquet(reason: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The file could not be read as Parquet: {reason}"),
        "Check that the file is a complete Parquet file (it ends with the PAR1 marker), or write it again from the system that produced it.",
    )
}

fn text_of(v: ValueRef) -> Option<String> {
    match v {
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    }
}

fn int_of(v: ValueRef) -> Option<i64> {
    match v {
        ValueRef::BigInt(n) => Some(n),
        ValueRef::Int(n) => Some(n as i64),
        ValueRef::UBigInt(n) => i64::try_from(n).ok(),
        ValueRef::HugeInt(n) => i64::try_from(n).ok(),
        _ => None,
    }
}

/// The timestamp unit a logical type names ('TimestampType(isAdjustedToUTC=1, unit=TimeUnit(
/// MILLIS=<null>, MICROS=MicroSeconds(), NANOS=<null>))'), and whether it is adjusted to UTC.
fn logical_timestamp(logical: &str) -> Option<(Unit, bool)> {
    let rest = logical.strip_prefix("TimestampType(")?;
    let utc = rest.contains("isAdjustedToUTC=1") || rest.contains("isAdjustedToUTC=true");
    let unit = if rest.contains("MILLIS=MilliSeconds") {
        Unit::Millis
    } else if rest.contains("NANOS=NanoSeconds") {
        Unit::Nanos
    } else {
        Unit::Micros
    };
    Some((unit, utc))
}

/// Reads the footer: the top-level fields of the schema and how each is read.
pub fn metadata(conn: &Connection, path: &Path) -> Result<Meta> {
    let file = quote_text(&path.to_string_lossy());
    let mut schema: Vec<(String, String, i64, String, String)> = Vec::new();
    {
        let mut st = conn
            .prepare(&format!(
                "SELECT name, type, num_children, converted_type, logical_type FROM parquet_schema({file})"
            ))
            .map_err(not_parquet)?;
        let mut rows = st.query([]).map_err(not_parquet)?;
        while let Some(r) = rows.next().map_err(not_parquet)? {
            let get = |i: usize| r.get_ref(i).ok().and_then(text_of).unwrap_or_default();
            let children = r.get_ref(2).ok().and_then(int_of).unwrap_or(0);
            schema.push((get(0), get(1), children, get(3), get(4)));
        }
    }
    let (rows, row_groups) = conn
        .query_row(
            &format!("SELECT num_rows, num_row_groups FROM parquet_file_metadata({file})"),
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(not_parquet)?;
    // The schema lists the tree depth first; the root's direct children are the columns.
    let Some((_, _, top, _, _)) = schema.first().cloned() else {
        return Err(not_parquet("the file has no schema"));
    };
    let mut names = Vec::new();
    let mut nested = Vec::new();
    let mut reads = Vec::new();
    let mut i = 1;
    for _ in 0..top {
        let Some((name, typ, children, converted, logical)) = schema.get(i).cloned() else {
            break;
        };
        // Skip this field's subtree: its children, their children and so on.
        let mut pending = children;
        i += 1;
        while pending > 0 && i < schema.len() {
            pending += schema[i].2 - 1;
            i += 1;
        }
        let read = if children > 0 {
            nested.push(name.clone());
            Read::Nested
        } else if converted == "TIMESTAMP_MILLIS" || converted == "TIMESTAMP_MICROS" {
            let unit = if converted == "TIMESTAMP_MILLIS" {
                Unit::Millis
            } else {
                Unit::Micros
            };
            Read::Timestamp {
                unit,
                utc: Some(true),
            }
        } else if converted == "JSON" || logical.starts_with("JsonType") {
            Read::Json
        } else if let Some((unit, utc)) = logical_timestamp(&logical) {
            Read::Timestamp {
                unit,
                utc: Some(utc),
            }
        } else if typ == "INT96" {
            Read::Timestamp {
                unit: Unit::Nanos,
                utc: None,
            }
        } else if converted.is_empty()
            && logical.is_empty()
            && (typ == "BYTE_ARRAY" || typ == "FIXED_LEN_BYTE_ARRAY")
        {
            Read::Bytes {
                fixed: typ == "FIXED_LEN_BYTE_ARRAY",
            }
        } else {
            Read::Plain
        };
        names.push(name);
        reads.push(read);
    }
    Ok(Meta {
        names,
        rows: rows.max(0) as u64,
        row_groups: row_groups.max(0) as u64,
        nested,
        reads,
    })
}

/// The detections a Parquet file's footer gives (sniff): its columns, its row count and the
/// columns kept as JSON text.
pub fn detections(m: &Meta) -> Vec<(String, Value)> {
    let det = crate::detect::det;
    let mut out = vec![
        (
            "columns".to_string(),
            det(
                json!(m.names),
                "high",
                "parquet-schema",
                format!("The file's schema lists {} columns.", m.names.len()),
                false,
            ),
        ),
        (
            "rowCount".to_string(),
            det(
                json!(m.rows),
                "high",
                "parquet-footer",
                format!(
                    "The file's footer states {} rows in {} row groups.",
                    crate::csv::format_count(m.rows),
                    crate::csv::format_count(m.row_groups)
                ),
                false,
            ),
        ),
    ];
    if !m.nested.is_empty() {
        let list: Vec<String> = m.nested.iter().map(|k| format!("\"{k}\"")).collect();
        out.push((
            "nestedColumns".to_string(),
            det(
                json!(m.nested),
                "high",
                "json-text",
                format!(
                    "The columns {} hold lists, maps or structs; they are kept as JSON text in text columns.",
                    list.join(", ")
                ),
                false,
            ),
        ));
    }
    out
}

/// A finite number as itself, anything else as the text JavaScript writes for it.
fn number(n: f64) -> Raw {
    if n.is_finite() {
        // As stored: a negative zero stays one, as in the TypeScript reader.
        Raw::Number(n)
    } else if n.is_nan() {
        Raw::Text("NaN".into())
    } else if n > 0.0 {
        Raw::Text("Infinity".into())
    } else {
        Raw::Text("-Infinity".into())
    }
}

/// An integer as a number while it is exact, else as its digits.
fn integer(n: i128) -> Raw {
    if n.unsigned_abs() <= 9_007_199_254_740_991 {
        Raw::Number(n as f64)
    } else {
        Raw::Text(n.to_string())
    }
}

/// A date stored as days since the epoch (date()).
fn date(days: i64) -> Raw {
    if (days as f64 * MS_PER_DAY as f64).abs() > MAX_DATE_MS {
        return Raw::Text(days.to_string());
    }
    Raw::Date(crate::time::date_text(days))
}

/// A timestamp of `v` stored units (timestamp()): a date-time cell when it is a whole millisecond,
/// else ISO text keeping every stored digit of the fraction.
fn timestamp(v: i64, unit: Unit) -> Raw {
    let (per_ms, digits) = unit.per_ms();
    let per_second = per_ms as i128 * 1000;
    let v = v as i128;
    let seconds = v.div_euclid(per_second);
    let rest = v.rem_euclid(per_second);
    if (seconds as f64).abs() * 1000.0 > MAX_DATE_MS {
        return Raw::Text(v.to_string());
    }
    if rest % per_ms as i128 == 0 {
        return Raw::DateTime(crate::time::iso_from_millis((v / per_ms as i128) as i64));
    }
    let whole = crate::time::iso_from_millis((seconds * 1000) as i64);
    Raw::Text(format!(
        "{}.{:0digits$}Z",
        &whole[..whole.len().min(19)],
        rest
    ))
}

/// A timestamp field as its column's zone makes it (zoned()): ISO text with 'Z' for instants,
/// a date-time cell or zone-less text for local times.
fn zoned(f: Raw, utc: bool) -> Raw {
    match f {
        Raw::DateTime(t) if utc => Raw::Text(t),
        Raw::Text(t) if !utc && is_fraction_text(&t) => Raw::Text(t[..t.len() - 1].to_string()),
        other => other,
    }
}

/// ISO text with a fraction finer than a millisecond: 'YYYY-MM-DDT...Z' (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/).
fn is_fraction_text(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() > 11
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && b[10] == b'T'
        && b.last() == Some(&b'Z')
        && !b[11..b.len() - 1].is_empty()
        && b[11..b.len() - 1]
            .iter()
            .all(|c| c.is_ascii_digit() || *c == b':' || *c == b'.')
}

/// A stored integer in the column's unit, from the unit DuckDB hands it over in.
fn in_unit(v: i64, from: TimeUnit, to: Unit) -> i64 {
    let scale = |u: TimeUnit| -> i64 {
        match u {
            TimeUnit::Second => 1_000_000_000,
            TimeUnit::Millisecond => 1_000_000,
            TimeUnit::Microsecond => 1000,
            TimeUnit::Nanosecond => 1,
        }
    };
    let target = match to {
        Unit::Millis => 1_000_000,
        Unit::Micros => 1000,
        Unit::Nanos => 1,
    };
    let from = scale(from);
    if from >= target {
        v.saturating_mul(from / target)
    } else {
        v.div_euclid(target / from)
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// JSON text as JSON.stringify writes the value JSON.parse reads from it: no white space, numbers
/// in their shortest form, strings escaped as JavaScript escapes them, keys in their written order.
pub fn json_text(src: &str) -> Option<String> {
    let mut out = String::with_capacity(src.len());
    let b = src.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b'"' => {
                let start = i;
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                let token = src.get(start..=i)?;
                let text: String = serde_json::from_str(token).ok()?;
                out.push_str(&serde_json::to_string(&text).ok()?);
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                while i < b.len() && matches!(b[i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                {
                    i += 1;
                }
                let n: f64 = src[start..i].parse().ok()?;
                out.push_str(&crate::canonical::canonical_number(n));
            }
            _ => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    Some(out)
}

/// One value of a column as the raw field the TypeScript reader makes of it.
fn raw_of(v: ValueRef, read: &Read) -> Raw {
    let field = match v {
        ValueRef::Null => Raw::Null,
        ValueRef::Boolean(b) => Raw::Bool(b),
        ValueRef::TinyInt(n) => Raw::Number(n as f64),
        ValueRef::SmallInt(n) => Raw::Number(n as f64),
        ValueRef::Int(n) => Raw::Number(n as f64),
        ValueRef::UTinyInt(n) => Raw::Number(n as f64),
        ValueRef::USmallInt(n) => Raw::Number(n as f64),
        ValueRef::UInt(n) => Raw::Number(n as f64),
        ValueRef::BigInt(n) => integer(n as i128),
        ValueRef::UBigInt(n) => integer(n as i128),
        ValueRef::HugeInt(n) => integer(n),
        ValueRef::UHugeInt(n) => {
            i128::try_from(n).map_or_else(|_| Raw::Text(n.to_string()), integer)
        }
        ValueRef::Float(x) => number(x as f64),
        ValueRef::Double(x) => number(x),
        // As the TypeScript reader: the unscaled value times 10 ** -scale.
        ValueRef::Decimal(d) => number(d.value() as f64 * 10f64.powi(-(d.scale() as i32))),
        ValueRef::Date32(days) => date(days as i64),
        ValueRef::Timestamp(from, t) => match read {
            Read::Timestamp { unit, .. } => timestamp(in_unit(t, from, *unit), *unit),
            _ => timestamp(in_unit(t, from, Unit::Micros), Unit::Micros),
        },
        ValueRef::Time64(_, t) => Raw::Number(t as f64),
        ValueRef::Text(t) => {
            let text = String::from_utf8_lossy(t).into_owned();
            match read {
                Read::Json | Read::Nested => match serde_json::from_str::<Value>(&text) {
                    Ok(Value::String(s)) if matches!(read, Read::Json) => Raw::Text(s),
                    Ok(Value::Number(n)) if matches!(read, Read::Json) => {
                        number(n.as_f64().unwrap_or(f64::NAN))
                    }
                    Ok(Value::Bool(b)) if matches!(read, Read::Json) => Raw::Bool(b),
                    Ok(Value::Null) => Raw::Null,
                    _ => Raw::Text(json_text(&text).unwrap_or(text)),
                },
                _ => Raw::Text(text),
            }
        }
        ValueRef::Blob(bytes) => match read {
            Read::Bytes { fixed: true } => Raw::Text(hex(bytes)),
            _ => Raw::Text(String::from_utf8_lossy(bytes).into_owned()),
        },
        _ => Raw::Null,
    };
    match read {
        Read::Timestamp { utc: Some(utc), .. } => zoned(field, *utc),
        _ => field,
    }
}

/// The query reading the columns of `path` with each row's 0-based row number, optionally only one row.
fn select(path: &Path, m: &Meta, only: Option<u64>, limit: Option<u64>) -> String {
    let mut columns = vec!["file_row_number".to_string()];
    columns.extend(m.names.iter().zip(&m.reads).map(|(name, read)| match read {
        Read::Nested => format!("to_json({})::VARCHAR", quote_ident(name)),
        Read::Json => format!("{}::VARCHAR", quote_ident(name)),
        _ => quote_ident(name),
    }));
    let mut sql = format!(
        "SELECT {} FROM read_parquet({}, file_row_number=true)",
        columns.join(", "),
        quote_text(&path.to_string_lossy())
    );
    if let Some(at) = only {
        sql.push_str(&format!(" WHERE file_row_number = {at}"));
    }
    if let Some(n) = limit {
        sql.push_str(&format!(" LIMIT {n}"));
    }
    sql
}

/// Runs a query of `select` and hands each row on, until `row` returns false.
fn each_row(
    conn: &Connection,
    sql: &str,
    m: &Meta,
    row: &mut dyn FnMut(u64, Vec<Raw>) -> Result<bool>,
) -> Result<()> {
    let mut st = conn.prepare(sql).map_err(not_parquet)?;
    let mut rows = st.query([]).map_err(not_parquet)?;
    while let Some(r) = rows.next().map_err(not_parquet)? {
        let at = r.get_ref(0).ok().and_then(int_of).unwrap_or(0).max(0) as u64;
        let fields = m
            .reads
            .iter()
            .enumerate()
            .map(|(j, read)| raw_of(r.get_ref(j + 1).unwrap_or(ValueRef::Null), read))
            .collect();
        if !row(at, fields)? {
            break;
        }
    }
    Ok(())
}

/// Reads the rows of `path` in file order, each with its 0-based row number, calling `row` until
/// it returns false; `limit` stops after that many rows.
pub fn read_rows(
    conn: &Connection,
    path: &Path,
    m: &Meta,
    limit: Option<u64>,
    row: &mut dyn FnMut(u64, Vec<Raw>) -> Result<bool>,
) -> Result<()> {
    each_row(conn, &select(path, m, None, limit), m, row)
}

/// The fields of row `at` (0-based), or None when the file has no such row.
pub fn read_row(conn: &Connection, path: &Path, at: u64) -> Result<Option<Vec<Raw>>> {
    let m = metadata(conn, path)?;
    let mut found = None;
    each_row(
        conn,
        &select(path, &m, Some(at), None),
        &m,
        &mut |_, fields| {
            found = Some(fields);
            Ok(false)
        },
    )?;
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_json_as_json_stringify_does() {
        assert_eq!(
            json_text("{ \"z\": 1.0, \"a\": [1e2, \"\\u0041\\/\"] }").as_deref(),
            Some("{\"z\":1,\"a\":[100,\"A/\"]}")
        );
        assert_eq!(
            json_text("[true, null, -0.5]").as_deref(),
            Some("[true,null,-0.5]")
        );
    }

    #[test]
    fn keeps_every_stored_digit_of_a_timestamp() {
        assert_eq!(
            timestamp(1_577_836_800_123, Unit::Millis),
            Raw::DateTime("2020-01-01T00:00:00.123Z".into())
        );
        assert_eq!(
            timestamp(1_577_836_800_123_456, Unit::Micros),
            Raw::Text("2020-01-01T00:00:00.123456Z".into())
        );
        assert_eq!(
            timestamp(5, Unit::Nanos),
            Raw::Text("1970-01-01T00:00:00.000000005Z".into())
        );
        assert_eq!(
            timestamp(-1, Unit::Micros),
            Raw::Text("1969-12-31T23:59:59.999999Z".into())
        );
        assert_eq!(
            zoned(timestamp(5, Unit::Nanos), false),
            Raw::Text("1970-01-01T00:00:00.000000005".into())
        );
        assert_eq!(
            zoned(timestamp(0, Unit::Millis), true),
            Raw::Text("1970-01-01T00:00:00.000Z".into())
        );
    }

    #[test]
    fn keeps_what_no_number_holds_exactly_as_text() {
        assert_eq!(
            integer(9_007_199_254_740_993),
            Raw::Text("9007199254740993".into())
        );
        assert_eq!(integer(-5), Raw::Number(-5.0));
        assert_eq!(number(f64::NAN), Raw::Text("NaN".into()));
        assert_eq!(number(f64::NEG_INFINITY), Raw::Text("-Infinity".into()));
        assert_eq!(hex(&[0, 255]), "0x00ff");
    }
}
