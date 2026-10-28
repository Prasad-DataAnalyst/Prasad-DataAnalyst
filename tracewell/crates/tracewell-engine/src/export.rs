//! Validated export packages (SAD section 10), as the TypeScript export module builds them: write
//! the data file, read it back through a separate reader and compare it with the output view by
//! row count, header, Parquet types and per-column digests, assemble the package with its README,
//! manifest, audit log, issues and checksums, re-open the package and verify everything again,
//! and only then offer it. A package that fails any check is deleted, never offered.
//!
//! The native engine writes the CSV and Parquet profiles; the profile list is the same JSON file
//! as the TypeScript engine's.

use crate::canonical::{canonical_json, canonical_number, json_string, sha256_hex};
use crate::csv::{TableLayout, TableReader};
use crate::digest::{Cell, ColumnDigest, cell_at, read_back_cell};
use crate::encoding::TextDecoder;
use crate::error::{EngineError, Result};
use crate::import::{quote_ident, quote_text};
use crate::parse::Kind;
use crate::units::REGISTRY_JSON;
use crate::zip::{Entry, ZipWriter, read_entries, read_entry};
use duckdb::Connection;
use duckdb::arrow::array::{AsArray, RecordBatch};
use duckdb::arrow::datatypes::Int64Type;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const PROFILES_JSON: &str = include_str!("../../../src/export/profiles.json");
/// Profiles this engine writes; the others are listed as not available yet.
const NATIVE_PROFILES: [&str; 2] = ["csv", "parquet"];
/// A package up to this size is handed back as bytes when the request names no file.
pub const RETURN_BYTES_MAX: u64 = 256 << 20;
const READ_BYTES: usize = 4 << 20;

pub fn profiles() -> Vec<Value> {
    serde_json::from_str::<Value>(PROFILES_JSON)
        .ok()
        .and_then(|v| v["profiles"].as_array().cloned())
        .unwrap_or_default()
}

/// What listExportProfiles answers: every profile, those this engine cannot write yet with why.
pub fn profile_statuses() -> Vec<Value> {
    profiles()
        .into_iter()
        .map(|p| {
            let id = p["id"].as_str().unwrap_or("").to_string();
            if NATIVE_PROFILES.contains(&id.as_str()) {
                json!({ "profile": p, "available": true, "substitutions": [] })
            } else {
                let what = if id == "excel" {
                    "Excel workbooks"
                } else {
                    "GeoJSON files"
                };
                json!({
                    "profile": p,
                    "available": false,
                    "reason": format!("The native engine does not write {what} yet."),
                    "fix": "Export as CSV or Parquet instead.",
                    "substitutions": [],
                })
            }
        })
        .collect()
}

pub fn native_profile(id: &str) -> bool {
    NATIVE_PROFILES.contains(&id)
}

/// A column of the output view.
#[derive(Clone)]
pub struct OutColumn {
    pub id: String,
    pub name: String,
    pub unit: Option<String>,
    pub typ: String,
    pub kind: Kind,
}

impl OutColumn {
    /// 'Pressure [kPa]', or just the name when the column has no unit (headerFor).
    pub fn header(&self) -> String {
        match &self.unit {
            Some(u) => format!("{} [{u}]", self.name),
            None => self.name.clone(),
        }
    }
}

/// Everything an export needs, taken from the engine before the job starts.
pub struct ExportInput {
    pub export_id: String,
    pub base_name: String,
    pub profile: String,
    pub at: String,
    pub app_version: String,
    pub owner: String,
    pub project: Value,
    pub dataset_id: String,
    pub dataset_name: String,
    pub view: String,
    pub row_count: u64,
    pub columns: Vec<OutColumn>,
    pub sources: Vec<Value>,
    pub rule_packs: Vec<Value>,
    pub assumptions: Vec<Value>,
    pub issues: Vec<Value>,
    pub audit: Vec<Value>,
    pub audit_head: Value,
    pub workdir: PathBuf,
    pub target: Option<PathBuf>,
    pub threads: usize,
    /// CSV data files: an apostrophe in front of text a spreadsheet would run as a formula.
    pub neutralize: bool,
}

pub struct ExportOutcome {
    pub result: Value,
    /// The package's bytes, when they are handed back rather than left in a file.
    pub bytes: Option<Vec<u8>>,
    pub record: Option<Value>,
}

fn check(id: &str, ok: bool, detail: String, file: Option<&str>) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("ok".into(), json!(ok));
    m.insert("detail".into(), json!(detail));
    if let Some(f) = file {
        m.insert("file".into(), json!(f));
    }
    Value::Object(m)
}

fn cancelled() -> EngineError {
    EngineError::new(
        "CANCELLED",
        "The export was cancelled.",
        "Start the export again when you are ready.",
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn file_sha256(path: &Path) -> Result<(String, u64)> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; READ_BYTES];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        size += n as u64;
    }
    Ok((hex(&h.finalize()), size))
}

// ---------------------------------------------------------------------------------------------
// Digests of the output view

/// The column's digest over exported values and over the view's own values (they differ only
/// where a text cell is empty, which an exported text file cannot tell from no value).
struct ColumnDigests {
    exported: String,
    view: String,
}

/// Runs `per_column` for each column on up to `threads` threads, each with its own connection.
fn per_column<T: Send>(
    conn: &Connection,
    columns: &[OutColumn],
    threads: usize,
    per_column: impl Fn(&Connection, &OutColumn) -> Result<T> + Sync,
) -> Result<Vec<T>> {
    let workers = threads.clamp(1, columns.len().max(1));
    let conns: Vec<Connection> = (0..workers)
        .map(|_| conn.try_clone())
        .collect::<std::result::Result<_, _>>()?;
    let mut results: Vec<Option<Result<T>>> = (0..columns.len()).map(|_| None).collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = conns
            .into_iter()
            .enumerate()
            .map(|(w, c)| {
                let per_column = &per_column;
                s.spawn(move || {
                    (w..columns.len())
                        .step_by(workers)
                        .map(|j| (j, per_column(&c, &columns[j])))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for h in handles {
            for (j, r) in h.join().unwrap_or_default() {
                results[j] = Some(r);
            }
        }
    });
    results
        .into_iter()
        .map(|r| r.unwrap_or_else(|| Err(EngineError::internal("A digest worker stopped."))))
        .collect()
}

/// Streams one column of the view in row order.
fn scan_column(
    conn: &Connection,
    view: &str,
    c: &OutColumn,
    mut f: impl FnMut(Cell),
) -> Result<()> {
    let mut stmt = conn.prepare(&format!("SELECT __rid, {} FROM {view}", quote_ident(&c.id)))?;
    let mut next: i64 = 0;
    for batch in stmt.query_arrow([])? {
        let rids = batch.column(0).as_primitive::<Int64Type>();
        let values = batch.column(1);
        for i in 0..batch.num_rows() {
            // The working file is written in row order and read back in it; a gap would mean the
            // digest compares the wrong rows.
            if rids.value(i) != next {
                return Err(EngineError::internal(format!(
                    "The working table is out of row order at row {next} of column {}.",
                    c.id
                )));
            }
            next += 1;
            f(cell_at(values, i, c.kind));
        }
    }
    Ok(())
}

fn view_digests(conn: &Connection, input: &ExportInput) -> Result<Vec<ColumnDigests>> {
    per_column(conn, &input.columns, input.threads, |conn, c| {
        let mut exported = ColumnDigest::default();
        let mut view = (c.kind == Kind::String).then(ColumnDigest::default);
        scan_column(conn, &input.view, c, |cell| {
            if let Some(v) = view.as_mut() {
                v.push(&cell);
            }
            exported.push(&cell.exportable());
        })?;
        let exported = exported.finish();
        Ok(ColumnDigests {
            view: view.map_or_else(|| exported.clone(), ColumnDigest::finish),
            exported,
        })
    })
}

// ---------------------------------------------------------------------------------------------
// Writers

/// A CSV field as RFC 4180 writes it: quoted, quotes doubled, when it holds a comma, quote, CR or LF.
fn csv_field(field: &str, out: &mut Vec<u8>) {
    if field
        .bytes()
        .any(|b| matches!(b, b',' | b'"' | b'\r' | b'\n'))
    {
        out.push(b'"');
        out.extend_from_slice(field.replace('"', "\"\"").as_bytes());
        out.push(b'"');
    } else {
        out.extend_from_slice(field.as_bytes());
    }
}

/// One CSV record with CRLF, as the TypeScript writer writes it: a lone empty field is quoted so
/// the line is not blank, and a leading U+FEFF in the first record is quoted so it is not taken
/// for a byte-order mark.
fn csv_record(fields: &[String], first: bool, out: &mut Vec<u8>) {
    if fields.len() == 1 && fields[0].is_empty() {
        out.extend_from_slice(b"\"\"\r\n");
        return;
    }
    for (j, f) in fields.iter().enumerate() {
        if j > 0 {
            out.push(b',');
        }
        if first && j == 0 && f.starts_with('\u{feff}') {
            out.push(b'"');
            out.extend_from_slice(f.replace('"', "\"\"").as_bytes());
            out.push(b'"');
        } else {
            csv_field(f, out);
        }
    }
    out.extend_from_slice(b"\r\n");
}

pub fn csv_bytes(header: &[String], rows: &[Vec<String>]) -> Vec<u8> {
    let mut out = Vec::new();
    csv_record(header, true, &mut out);
    for r in rows {
        csv_record(r, false, &mut out);
    }
    out
}

/// Whether text would run as a formula in a spreadsheet, after any apostrophes already added.
fn formula_start(text: &str) -> bool {
    matches!(
        text.trim_start_matches('\'').chars().next(),
        Some('=' | '+' | '-' | '@' | '\t' | '\r')
    )
}

/// One more apostrophe in front of formula text (values.ts neutralizeFormula).
fn neutralize_formula(text: String) -> String {
    if formula_start(&text) { format!("'{text}") } else { text }
}

/// The inverse of neutralize_formula (values.ts restoreFormula).
fn restore_formula(text: &str) -> &str {
    match text.strip_prefix('\'') {
        Some(rest) if formula_start(rest) => rest,
        _ => text,
    }
}

/// Formats a group of batches as CSV text, in row order.
fn format_rows(batches: &[RecordBatch], kinds: &[Kind], neutralize: bool, out: &mut Vec<u8>) {
    let mut fields = vec![String::new(); kinds.len()];
    for b in batches {
        for i in 0..b.num_rows() {
            for (j, kind) in kinds.iter().enumerate() {
                let text = cell_at(b.column(j), i, *kind).text();
                fields[j] = if neutralize && *kind == Kind::String { neutralize_formula(text) } else { text };
            }
            csv_record(&fields, false, out);
        }
    }
}

fn write_csv(
    conn: &Connection,
    input: &ExportInput,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut out = BufWriter::with_capacity(1 << 20, File::create(path)?);
    let header: Vec<String> = input.columns.iter().map(OutColumn::header).collect();
    let mut head = Vec::new();
    csv_record(&header, true, &mut head);
    out.write_all(&head)?;
    let kinds: Vec<Kind> = input.columns.iter().map(|c| c.kind).collect();
    let select: Vec<String> = input.columns.iter().map(|c| quote_ident(&c.id)).collect();
    let mut stmt = conn.prepare(&format!("SELECT {} FROM {}", select.join(", "), input.view))?;
    let workers = input.threads.max(1);
    let mut group: Vec<RecordBatch> = Vec::new();
    let flush = |group: &mut Vec<RecordBatch>, out: &mut BufWriter<File>| -> Result<()> {
        // Batches are formatted on several threads, a share each, and written in order.
        let share = group.len().div_ceil(workers).max(1);
        let texts: Vec<Vec<u8>> = std::thread::scope(|s| {
            let handles: Vec<_> = group
                .chunks(share)
                .map(|part| {
                    let kinds = &kinds;
                    s.spawn(move || {
                        let mut buf = Vec::new();
                        format_rows(part, kinds, input.neutralize, &mut buf);
                        buf
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        });
        for t in texts {
            out.write_all(&t)?;
        }
        group.clear();
        Ok(())
    };
    let mut rows = 0usize;
    for batch in stmt.query_arrow([])? {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        rows += batch.num_rows();
        group.push(batch);
        if rows >= 65_536 * workers {
            flush(&mut group, &mut out)?;
            rows = 0;
        }
    }
    flush(&mut group, &mut out)?;
    out.flush()?;
    Ok(())
}

/// Writes the Parquet data file. Exports use Snappy, the codec every Parquet reader supports;
/// the working files use ZSTD, which only DuckDB reads.
fn write_parquet(conn: &Connection, input: &ExportInput, path: &Path) -> Result<()> {
    let select: Vec<String> = input
        .columns
        .iter()
        .map(|c| {
            let v = quote_ident(&c.id);
            let expr = match c.kind {
                Kind::String => format!("NULLIF({v}, '')"),
                Kind::Number | Kind::Boolean => v,
                Kind::Integer => format!("CAST({v} AS BIGINT)"),
                Kind::Date => format!("CAST(DATE '1970-01-01' + {v} AS DATE)"),
                Kind::DateTime => format!("CAST(make_timestamp({v} * 1000) AS TIMESTAMPTZ)"),
            };
            format!("{expr} AS {}", quote_ident(&c.header()))
        })
        .collect();
    conn.execute_batch(&format!(
        "SET TimeZone = 'UTC'; COPY (SELECT {} FROM {}) TO {} (FORMAT parquet, COMPRESSION snappy)",
        select.join(", "),
        input.view,
        quote_text(&path.to_string_lossy())
    ))
    .or_else(|_| {
        // A build without time zone support keeps TIMESTAMPTZ in UTC anyway.
        conn.execute_batch(&format!(
            "COPY (SELECT {} FROM {}) TO {} (FORMAT parquet, COMPRESSION snappy)",
            select.join(", "),
            input.view,
            quote_text(&path.to_string_lossy())
        ))
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Read-back (a separate code path from the writers)

/// Expected shape: the output view's row count and each column's header, type and digest.
pub struct Expected<'a> {
    pub rows: u64,
    pub columns: &'a [OutColumn],
    pub digests: Vec<String>,
}

/// 'Pressure [kPa]' → ('Pressure', Some('kPa')): only a trailing ' [unit]' is read as the unit.
fn parse_header(h: &str) -> (String, Option<String>) {
    if let Some(open) = h.rfind(" [") {
        let unit = &h[open + 2..];
        if let Some(u) = unit.strip_suffix(']') {
            if !u.is_empty() && !u.contains(['[', ']']) {
                return (h[..open].to_string(), Some(u.to_string()));
            }
        }
    }
    (h.to_string(), None)
}

fn header_check(expected: &Expected, actual: &[String], file: &str) -> Value {
    let want: Vec<String> = expected.columns.iter().map(OutColumn::header).collect();
    let ok = actual.len() == want.len()
        && actual
            .iter()
            .zip(expected.columns)
            .zip(&want)
            .all(|((h, col), w)| {
                let (name, unit) = parse_header(h);
                h == w && name == col.name && unit == col.unit
            });
    if ok {
        check(
            "RB-HEADER",
            true,
            "One header row with the expected names, order and units.".into(),
            Some(file),
        )
    } else {
        check(
            "RB-HEADER",
            false,
            format!(
                "The header reads {} instead of {}.",
                json!(actual),
                json!(want)
            ),
            Some(file),
        )
    }
}

fn rows_check(actual: u64, expected: u64, file: &str) -> Value {
    if actual == expected {
        check(
            "RB-ROWS",
            true,
            format!("{actual} data rows, as in the output view."),
            Some(file),
        )
    } else {
        check(
            "RB-ROWS",
            false,
            format!("The file holds {actual} data rows; the output view has {expected}."),
            Some(file),
        )
    }
}

fn values_check(expected: &Expected, digests: &[Option<String>], file: &str) -> Value {
    let bad: Vec<String> = expected
        .columns
        .iter()
        .enumerate()
        .filter(|(j, _)| digests.get(*j).cloned().flatten().as_ref() != Some(&expected.digests[*j]))
        .map(|(_, c)| c.header())
        .collect();
    if bad.is_empty() {
        check(
            "RB-VALUES",
            true,
            format!(
                "All {} columns match the output view exactly.",
                expected.columns.len()
            ),
            Some(file),
        )
    } else {
        check(
            "RB-VALUES",
            false,
            format!(
                "These columns differ from the output view: {}.",
                bad.join(", ")
            ),
            Some(file),
        )
    }
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// ^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$
fn is_number_text(t: &str) -> bool {
    let t = t.strip_prefix('-').unwrap_or(t);
    let (mantissa, exp) = match t.find('e') {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let (int, frac) = match mantissa.find('.') {
        Some(i) => (&mantissa[..i], Some(&mantissa[i + 1..])),
        None => (mantissa, None),
    };
    let int_ok = int == "0" || (all_digits(int) && !int.starts_with('0'));
    let frac_ok = frac.is_none_or(all_digits);
    let exp_ok = exp.is_none_or(|e| all_digits(e.strip_prefix(['+', '-']).unwrap_or(e)));
    int_ok && frac_ok && exp_ok
}

fn is_date_text(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0..4, 5..7, 8..10]
            .iter()
            .all(|r| b[r.clone()].iter().all(u8::is_ascii_digit))
}

fn is_datetime_text(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 24
        && is_date_text(&t[..10])
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && [11..13, 14..16, 17..19, 20..23]
            .iter()
            .all(|r| b[r.clone()].iter().all(u8::is_ascii_digit))
}

/// Re-types text read back from a file with the manifest's column type (retypeText). Dates and
/// date-times keep their text, so the digest compares exactly what the file says.
fn retype_text(text: &str, kind: Kind) -> Option<Cell> {
    if text.is_empty() {
        return Some(Cell::Null);
    }
    match kind {
        Kind::String => Some(Cell::Text(text.to_string())),
        Kind::Number | Kind::Integer => is_number_text(text)
            .then(|| text.parse().ok().map(Cell::Num))
            .flatten(),
        Kind::Boolean => match text {
            "true" => Some(Cell::Bool(true)),
            "false" => Some(Cell::Bool(false)),
            _ => None,
        },
        Kind::Date => is_date_text(text).then(|| Cell::DateText(text.to_string())),
        Kind::DateTime => is_datetime_text(text).then(|| Cell::DateTimeText(text.to_string())),
    }
}

/// Reads a CSV file back: RB-OPEN, RB-CSV-ENCODING, RB-HEADER, RB-ROWS and RB-VALUES (readCsv).
fn read_back_csv(
    path: &Path,
    expected: &Expected,
    file: &str,
    threads: usize,
    neutralized: bool,
) -> Result<Vec<Value>> {
    let mut f = File::open(path)?;
    let mut head = [0u8; 3];
    let got = f.read(&mut head)?;
    let has_bom = got == 3 && head == [0xef, 0xbb, 0xbf];
    drop(f);
    let mut f = File::open(path)?;
    let mut decoder = TextDecoder::new("utf-8", if has_bom { 3 } else { 0 })?;
    let mut table = TableReader::new(&TableLayout {
        delimiter: b',',
        skip_lines: 0,
        header_rows: 1,
        batch_rows: 65_536,
        keep_blank: true,
    });
    let width = expected.columns.len();
    let mut digests: Vec<ColumnDigest> = (0..width).map(|_| ColumnDigest::default()).collect();
    let mut untyped = vec![false; width];
    let mut rows = 0u64;
    let mut buf = vec![0u8; READ_BYTES];
    let mut text = Vec::with_capacity(READ_BYTES);
    let mut carry: Vec<u8> = Vec::new();
    // Each batch's columns are re-typed and hashed on several threads, a share of columns each.
    let share = width.div_ceil(threads.max(1)).max(1);
    let consume = |table: &mut TableReader,
                   digests: &mut Vec<ColumnDigest>,
                   untyped: &mut Vec<bool>,
                   rows: &mut u64| {
        for b in table.take_batches() {
            *rows += b.rows() as u64;
            std::thread::scope(|s| {
                for ((cols, ds), bad) in expected
                    .columns
                    .chunks(share)
                    .zip(digests.chunks_mut(share))
                    .zip(untyped.chunks_mut(share))
                    .enumerate()
                    .map(|(k, ((c, d), u))| {
                        (
                            (
                                c.iter()
                                    .enumerate()
                                    .map(move |(j, col)| (k * share + j, col)),
                                d,
                            ),
                            u,
                        )
                    })
                {
                    let b = &b;
                    s.spawn(move || {
                        for ((j, col), (d, u)) in cols.zip(ds.iter_mut().zip(bad.iter_mut())) {
                            for i in 0..b.rows() {
                                let field = if j < b.width { b.cell(i, j) } else { None };
                                let text = field.map(String::from_utf8_lossy);
                                let mut text = text.as_deref().unwrap_or("");
                                if neutralized && col.kind == Kind::String {
                                    text = restore_formula(text);
                                }
                                match retype_text(text, col.kind) {
                                    Some(c) => d.push(&c),
                                    None => *u = true,
                                }
                            }
                        }
                    });
                }
            });
        }
    };
    let opened = (|| -> Result<()> {
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            // Strict UTF-8, as the TypeScript read-back decodes with fatal set; a sequence cut by
            // the end of a read is completed by the next one.
            carry.extend_from_slice(&buf[..n]);
            let valid = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(e) => {
                    return Err(EngineError::new(
                        "PARSE_FAILED",
                        format!("The file is not valid UTF-8: {e}"),
                        "",
                    ));
                }
            };
            text.clear();
            decoder.decode(&carry[..valid], &mut text);
            carry.drain(..valid);
            table.push(&text)?;
            consume(&mut table, &mut digests, &mut untyped, &mut rows);
        }
        if !carry.is_empty() {
            return Err(EngineError::new(
                "PARSE_FAILED",
                "The file is not valid UTF-8: it ends inside a character.",
                "",
            ));
        }
        table.finish()?;
        consume(&mut table, &mut digests, &mut untyped, &mut rows);
        Ok(())
    })();
    if let Err(e) = opened {
        let detail = if e.message.starts_with("The file is not valid UTF-8") {
            e.message
        } else {
            format!("The file does not parse as CSV: {}", e.message)
        };
        return Ok(vec![check("RB-OPEN", false, detail, Some(file))]);
    }
    let mut checks = vec![check(
        "RB-OPEN",
        true,
        "The file parses as RFC 4180 CSV.".into(),
        Some(file),
    )];
    let ragged = table.mismatched;
    checks.push(if !has_bom && ragged == 0 {
        check(
            "RB-CSV-ENCODING",
            true,
            "UTF-8 without a byte-order mark; every row has the same number of fields.".into(),
            Some(file),
        )
    } else {
        let mut parts = Vec::new();
        if has_bom {
            parts.push("The file starts with a byte-order mark.".to_string());
        }
        if ragged > 0 {
            parts.push(format!("{ragged} rows have a different number of fields."));
        }
        check("RB-CSV-ENCODING", false, parts.join(" "), Some(file))
    });
    let header: Vec<String> = table.header().map(<[String]>::to_vec).unwrap_or_default();
    checks.push(header_check(expected, &header, file));
    checks.push(rows_check(rows, expected.rows, file));
    let got: Vec<Option<String>> = digests
        .into_iter()
        .zip(untyped)
        .map(|(d, bad)| (!bad).then(|| d.finish()))
        .collect();
    checks.push(values_check(expected, &got, file));
    Ok(checks)
}

/// Annotations read-back accepts per logical type, as PARQUET_TYPES in formats-parquet.
fn parquet_accepts(kind: Kind) -> (&'static str, &'static [&'static str]) {
    match kind {
        Kind::String => ("BYTE_ARRAY", &["UTF8", "STRING"]),
        Kind::Number => ("DOUBLE", &[""]),
        Kind::Integer => ("INT64", &["", "INT_64"]),
        Kind::Boolean => ("BOOLEAN", &[""]),
        Kind::Date => ("INT32", &["DATE"]),
        Kind::DateTime => ("INT64", &["TIMESTAMP_MICROS", "TIMESTAMP(MICROS, UTC)"]),
    }
}

/// Reads a Parquet file back: RB-OPEN, RB-PARQUET-TYPES, RB-HEADER, RB-ROWS and RB-VALUES.
fn read_back_parquet(
    conn: &Connection,
    path: &Path,
    expected: &Expected,
    file: &str,
    threads: usize,
) -> Result<Vec<Value>> {
    let p = quote_text(&path.to_string_lossy());
    let schema: std::result::Result<Vec<(String, String, String)>, duckdb::Error> = (|| {
        let mut stmt = conn.prepare(&format!(
            "SELECT name, coalesce(type, ''), coalesce(converted_type, '') FROM parquet_schema({p}) WHERE num_children IS NULL OR num_children = 0"
        ))?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    })();
    let schema = match schema {
        Ok(s) => s,
        Err(e) => {
            return Ok(vec![check(
                "RB-OPEN",
                false,
                format!("The file does not open as Apache Parquet: {e}"),
                Some(file),
            )]);
        }
    };
    let mut checks = vec![check(
        "RB-OPEN",
        true,
        "The file opens as Apache Parquet.".into(),
        Some(file),
    )];
    let wrong: Vec<String> = expected
        .columns
        .iter()
        .zip(&schema)
        .filter(|(c, (_, physical, annotation))| {
            let (want, accepted) = parquet_accepts(c.kind);
            physical != want || !accepted.contains(&annotation.as_str())
        })
        .map(|(c, (_, physical, annotation))| {
            format!(
                "{} is {physical}{}",
                c.header(),
                if annotation.is_empty() {
                    String::new()
                } else {
                    format!(" {annotation}")
                }
            )
        })
        .collect();
    checks.push(if wrong.is_empty() {
        check(
            "RB-PARQUET-TYPES",
            true,
            "Every column has the Parquet type of its logical type.".into(),
            Some(file),
        )
    } else {
        check(
            "RB-PARQUET-TYPES",
            false,
            format!(
                "These columns have the wrong Parquet type: {}.",
                wrong.join("; ")
            ),
            Some(file),
        )
    });
    let names: Vec<String> = schema.iter().map(|(n, _, _)| n.clone()).collect();
    checks.push(header_check(expected, &names, file));
    let rows: i64 = conn.query_row(
        &format!("SELECT count(*) FROM read_parquet({p})"),
        [],
        |r| r.get(0),
    )?;
    checks.push(rows_check(rows as u64, expected.rows, file));
    let readable: Vec<OutColumn> = expected.columns.iter().take(names.len()).cloned().collect();
    let digests = per_column(conn, &readable, threads, |conn, c| {
        let j = readable.iter().position(|x| x.id == c.id).unwrap_or(0);
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM read_parquet({p})",
            quote_ident(&names[j])
        ))?;
        let mut d = ColumnDigest::default();
        for batch in stmt.query_arrow([])? {
            let a = batch.column(0);
            for i in 0..batch.num_rows() {
                match read_back_cell(a, i, c.kind) {
                    Some(cell) => d.push(&cell),
                    None => return Ok(None),
                }
            }
        }
        Ok(Some(d.finish()))
    })?;
    checks.push(values_check(expected, &digests, file));
    Ok(checks)
}

fn read_back(
    conn: &Connection,
    input: &ExportInput,
    path: &Path,
    expected: &Expected,
    file: &str,
) -> Result<Vec<Value>> {
    if input.profile == "csv" {
        read_back_csv(path, expected, file, input.threads, input.neutralize)
    } else {
        read_back_parquet(conn, path, expected, file, input.threads)
    }
}

// ---------------------------------------------------------------------------------------------
// Package text: README, issues and checksums

/// JSON as JavaScript's JSON.stringify writes it (numbers as JavaScript writes them).
fn json_stringify(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&canonical_number(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_stringify(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_string(k, out);
                out.push(':');
                json_stringify(x, out);
            }
            out.push('}');
        }
    }
}

fn stringify(v: &Value) -> String {
    let mut s = String::new();
    json_stringify(v, &mut s);
    s
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => stringify(other),
    }
}

/// README.txt (readme.ts renderReadme).
fn render_readme(m: &Value) -> String {
    let data: Vec<&Value> = m["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["role"] == "data")
        .collect();
    let checks = m["validation"]["checks"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let passed = checks.iter().filter(|c| c["ok"] == true).count();
    let list = |key: &str| m[key].as_array().cloned().unwrap_or_default();
    let (sources, packs, assumptions, substitutions) = (
        list("sources"),
        list("rulePacks"),
        list("assumptions"),
        list("substitutions"),
    );
    let ds = &m["dataset"];
    let mut lines = vec![
        format!("Tracewell export: {}", text(&ds["name"])),
        format!(
            "Project: {} ({})",
            text(&m["project"]["name"]),
            text(&m["project"]["id"])
        ),
        format!("Export ID: {}", text(&m["exportId"])),
        format!(
            "Created: {} by Tracewell {} (owner: {})",
            text(&m["createdAt"]),
            text(&m["appVersion"]),
            text(&m["owner"])
        ),
        format!("Profile: {}", text(&m["profile"])),
        format!(
            "Rows: {}{}",
            text(&ds["rowCount"]),
            if ds["partial"] == true {
                " (PARTIAL: the import stopped at the memory budget)"
            } else {
                ""
            }
        ),
        format!("Excluded rows: {}", text(&m["excludedRows"])),
    ];
    if m["options"]["neutralizeFormulas"] == true {
        lines.push("Formulas: neutralised. Text starting with = + - @, a tab or a carriage return has a ' added in front,".into());
        lines.push("  so spreadsheet programs show it as text; remove the first apostrophe to get the original value.".into());
    }
    lines.extend([String::new(), "DATA FILES".into()]);
    lines.extend(data.iter().map(|f| {
        format!(
            "  {}  {} bytes  SHA-256 {}",
            text(&f["path"]),
            text(&f["size"]),
            text(&f["sha256"])
        )
    }));
    lines.push(String::new());
    lines.push("COLUMNS".into());
    lines.extend(ds["columns"].as_array().into_iter().flatten().map(|c| {
        format!(
            "  {}  ({})  SHA-256 of values {}",
            text(&c["header"]),
            text(&c["type"]),
            text(&c["sha256"])
        )
    }));
    lines.push(String::new());
    lines.push(format!("SOURCES ({})", sources.len()));
    if sources.is_empty() {
        lines.push("  none".into());
    }
    lines.extend(sources.iter().map(|s| {
        format!(
            "  {}  {} bytes  SHA-256 {}",
            text(&s["name"]),
            text(&s["size"]),
            text(&s["fileId"])
        )
    }));
    lines.push(String::new());
    lines.push(format!("RULE PACKS ({})", packs.len()));
    if packs.is_empty() {
        lines.push("  none".into());
    }
    lines.extend(packs.iter().map(|r| {
        format!(
            "  {} {}  SHA-256 {}",
            text(&r["id"]),
            text(&r["version"]),
            text(&r["sha256"])
        )
    }));
    lines.push(format!(
        "UNIT REGISTRY: {}  SHA-256 {}",
        text(&m["unitRegistry"]["version"]),
        text(&m["unitRegistry"]["sha256"])
    ));
    lines.push(String::new());
    lines.push("STEPS (0)".into());
    lines.push("  none".into());
    lines.push(String::new());
    lines.push(format!("ASSUMPTIONS ({})", assumptions.len()));
    if assumptions.is_empty() {
        lines.push("  none".into());
    }
    lines.extend(assumptions.iter().map(|a| {
        format!(
            "  {} {} = {} ({}): {}",
            a["columnId"].as_str().unwrap_or("dataset"),
            text(&a["property"]),
            stringify(&a["value"]),
            text(&a["confidence"]),
            text(&a["evidence"])
        )
    }));
    lines.push(String::new());
    lines.push("OPEN WARNINGS".into());
    let open = &m["openIssues"];
    lines.push(format!(
        "  errors {}, warnings {}, notes {} (details in issues.csv)",
        text(&open["error"]),
        text(&open["warning"]),
        text(&open["note"])
    ));
    lines.push(String::new());
    lines.push(format!("SUBSTITUTIONS ({})", substitutions.len()));
    if substitutions.is_empty() {
        lines.push("  none".into());
    }
    lines.push(String::new());
    lines.push("VALIDATION".into());
    lines.push(format!(
        "  {}: {passed} of {} read-back checks passed before the package was assembled.",
        if m["validation"]["ok"] == true {
            "Passed"
        } else {
            "FAILED"
        },
        checks.len()
    ));
    lines.extend(checks.iter().map(|c| {
        format!(
            "  [{}] {}{}: {}",
            if c["ok"] == true { "ok" } else { "FAILED" },
            text(&c["id"]),
            c["file"]
                .as_str()
                .map_or(String::new(), |f| format!(" {f}")),
            text(&c["detail"])
        )
    }));
    lines.extend(
        [
            "",
            "HOW TO VERIFY",
            "  1. Extract the package into an empty folder.",
            "  2. Run:  sha256sum -c CHECKSUMS.sha256   (every line must end in OK)",
            "  3. manifest.json holds the SHA-256 of every column; audit.jsonl holds the full history,",
            "     each entry linked to the one before it by its SHA-256 hash.",
            "",
        ]
        .map(String::from),
    );
    lines.join("\n")
}

/// issues.csv (readme.ts issuesCsv).
fn issues_csv(issues: &[Value]) -> Vec<u8> {
    let header: Vec<String> = [
        "issue_id", "rule_id", "severity", "status", "dataset", "columns", "title", "message",
        "flagged", "open", "accepted", "excluded", "fixed",
    ]
    .map(String::from)
    .to_vec();
    let rows: Vec<Vec<String>> = issues
        .iter()
        .map(|i| {
            let cols: Vec<String> = i["columns"]
                .as_array()
                .into_iter()
                .flatten()
                .map(text)
                .collect();
            vec![
                text(&i["id"]),
                text(&i["ruleId"]),
                text(&i["severity"]),
                text(&i["status"]),
                text(&i["datasetId"]),
                cols.join(" "),
                text(&i["title"]),
                text(&i["message"]),
                text(&i["counts"]["flagged"]),
                text(&i["counts"]["open"]),
                text(&i["counts"]["accepted"]),
                text(&i["counts"]["excluded"]),
                text(&i["counts"]["fixed"]),
            ]
        })
        .collect();
    csv_bytes(&header, &rows)
}

/// Paths in Unicode code point order (paths.ts comparePaths).
fn sorted_paths<T>(mut items: Vec<(String, T)>) -> Vec<(String, T)> {
    items.sort_by(|a, b| a.0.chars().cmp(b.0.chars()));
    items
}

/// A file name that every file system accepts (build.ts safeBase).
fn safe_base(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches('.');
    if trimmed.is_empty() {
        return "export".into();
    }
    let mut out = String::new();
    let mut units = 0;
    for c in trimmed.chars() {
        units += c.len_utf16();
        if units > 80 {
            break;
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Package verification

fn verify_package(
    zip: &Path,
    manifest: &Value,
    data_path: &str,
    extract_to: &Path,
) -> Result<Vec<Value>> {
    let entries = match read_entries(zip) {
        Ok(e) => e,
        Err(e) => {
            return Ok(vec![check(
                "RB-PKG-CHECKSUMS",
                false,
                format!("The package does not open: {}", e.message),
                None,
            )]);
        }
    };
    let find = |name: &str| entries.iter().find(|e| e.name == name);
    let small = |e: &Entry| -> Result<Vec<u8>> {
        let mut out = Vec::new();
        read_entry(zip, e, &mut |b| {
            out.extend_from_slice(b);
            Ok(())
        })?;
        Ok(out)
    };
    let mut problems: Vec<String> = Vec::new();
    match find("CHECKSUMS.sha256").map(small) {
        Some(Ok(bytes)) => {
            let sums: Vec<(String, String)> = String::from_utf8_lossy(&bytes)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| {
                    l.split_once("  ")
                        .map(|(h, p)| (h.to_lowercase(), p.trim_start_matches('*').to_string()))
                })
                .collect();
            for (sha, path) in &sums {
                match find(path) {
                    None => problems.push(format!("{path} is listed but missing")),
                    Some(e) => {
                        // The data file is extracted while it is checked, for the inside read-back.
                        let actual = if *path == data_path {
                            let mut out =
                                BufWriter::with_capacity(1 << 20, File::create(extract_to)?);
                            let sha = read_entry(zip, e, &mut |b| Ok(out.write_all(b)?));
                            out.flush()?;
                            sha
                        } else {
                            read_entry(zip, e, &mut |_| Ok(()))
                        };
                        match actual {
                            Ok(a) if a == *sha => {}
                            Ok(_) => problems.push(format!("{path} does not match its checksum")),
                            Err(err) => {
                                problems.push(format!("{path} cannot be read: {}", err.message))
                            }
                        }
                    }
                }
            }
            for e in &entries {
                if e.name != "CHECKSUMS.sha256" && !sums.iter().any(|(_, p)| *p == e.name) {
                    problems.push(format!("{} is not listed", e.name));
                }
            }
        }
        Some(Err(e)) => problems.push(format!("CHECKSUMS.sha256 cannot be read: {}", e.message)),
        None => problems.push("CHECKSUMS.sha256 cannot be read: it is missing".into()),
    }
    let mut checks = vec![if problems.is_empty() {
        check(
            "RB-PKG-CHECKSUMS",
            true,
            "Every package entry matches CHECKSUMS.sha256 (sha256sum -c compatible).".into(),
            None,
        )
    } else {
        check(
            "RB-PKG-CHECKSUMS",
            false,
            format!("Checksum problems: {}.", problems.join("; ")),
            None,
        )
    }];
    let mut contents: Vec<String> = Vec::new();
    match find("manifest.json").map(small) {
        Some(Ok(bytes)) => {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(m) => {
                    let ok = m["format"] == "tracewell-export"
                        && m["formatVersion"] == "0.1"
                        && m["files"].is_array()
                        && m["dataset"]["columns"].is_array()
                        && m["validation"]["checks"].is_array()
                        && m == *manifest;
                    if !ok {
                        contents.push("manifest.json does not validate (it differs from the manifest written)".into());
                    }
                }
                Err(e) => contents.push(format!("manifest.json cannot be read: {e}")),
            }
        }
        _ => contents.push("manifest.json cannot be read: it is missing".into()),
    }
    match find("README.txt").map(small) {
        Some(Ok(bytes)) => {
            let readme = String::from_utf8_lossy(&bytes);
            for s in manifest["sources"].as_array().into_iter().flatten() {
                if !readme.contains(&text(&s["fileId"])) {
                    contents.push(format!(
                        "the README does not list {} and its SHA-256",
                        text(&s["name"])
                    ));
                }
            }
            for r in manifest["rulePacks"].as_array().into_iter().flatten() {
                if !readme.contains(&format!("{} {}", text(&r["id"]), text(&r["version"]))) {
                    contents.push(format!(
                        "the README does not list the rule pack {}",
                        text(&r["id"])
                    ));
                }
            }
            if !readme.contains("OPEN WARNINGS") {
                contents.push("the README does not list the open warnings".into());
            }
        }
        _ => contents.push("README.txt cannot be read: it is missing".into()),
    }
    for f in manifest["files"].as_array().into_iter().flatten() {
        if find(&text(&f["path"])).is_none() {
            contents.push(format!("{} is missing", text(&f["path"])));
        }
    }
    checks.push(if contents.is_empty() {
        check(
            "RB-PKG-CONTENTS",
            true,
            "The manifest validates and the README lists every source with its checksum, the rule packs and the open warnings.".into(),
            None,
        )
    } else {
        check("RB-PKG-CONTENTS", false, format!("Package contents problems: {}.", contents.join("; ")), None)
    });
    Ok(checks)
}

// ---------------------------------------------------------------------------------------------
// The pipeline

fn open_issues(issues: &[Value]) -> Value {
    let (mut e, mut w, mut n) = (0, 0, 0);
    for i in issues.iter().filter(|i| i["status"] != "resolved") {
        match i["severity"].as_str() {
            Some("error") => e += 1,
            Some("warning") => w += 1,
            _ => n += 1,
        }
    }
    json!({ "error": e, "warning": w, "note": n })
}

/// Builds, verifies and delivers one export package (buildExport).
pub fn build_export(
    conn: &Connection,
    input: &ExportInput,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<ExportOutcome> {
    let step = |phase: &str, done: u64, progress: &mut dyn FnMut(&str, u64)| -> Result<()> {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        progress(phase, done);
        Ok(())
    };
    let ext = if input.profile == "csv" {
        "csv"
    } else {
        "parquet"
    };
    let data_name = format!("data.{ext}");
    let tmp = input.workdir.join(format!("export-{}", input.export_id));
    std::fs::create_dir_all(&tmp)?;
    let cleanup = scopeguard(tmp.clone());

    step("Writing", 0, progress)?;
    let digests = view_digests(conn, input)?;
    let data_path = tmp.join(&data_name);
    if input.profile == "csv" {
        write_csv(conn, input, &data_path, cancel)?;
    } else {
        write_parquet(conn, input, &data_path)?;
    }

    step("Reading back", 1, progress)?;
    let expected = Expected {
        rows: input.row_count,
        columns: &input.columns,
        digests: digests.iter().map(|d| d.exported.clone()).collect(),
    };
    let data_checks = read_back(conn, input, &data_path, &expected, &data_name)?;

    let columns: Vec<Value> = input
        .columns
        .iter()
        .zip(&digests)
        .map(|(c, d)| {
            json!({ "id": c.id, "name": c.name, "header": c.header(), "type": c.typ, "unit": c.unit, "sha256": d.exported })
        })
        .collect();
    let summary = json!({
        "rowCount": input.row_count,
        "columns": input.columns.iter().zip(&digests).map(|(c, d)| json!({ "name": c.name, "unit": c.unit, "type": c.typ, "sha256": d.view })).collect::<Vec<_>>(),
    });
    let view_digest = sha256_hex(canonical_json(&summary).as_bytes());
    let audit_text: String = input
        .audit
        .iter()
        .map(|e| format!("{}\n", canonical_json(e)))
        .collect();
    let issues_bytes = issues_csv(&input.issues);
    let (data_sha, data_size) = file_sha256(&data_path)?;
    let entry = |path: &str, size: u64, sha: &str, role: &str| json!({ "path": path, "size": size, "sha256": sha, "role": role });
    let data_ok = !data_checks.is_empty() && data_checks.iter().all(|c| c["ok"] == true);
    let mut manifest = json!({
        "format": "tracewell-export",
        "formatVersion": "0.1",
        "exportId": input.export_id,
        "createdAt": input.at,
        "appVersion": input.app_version,
        "owner": input.owner,
        "profile": input.profile,
        "project": input.project,
        "dataset": {
            "id": input.dataset_id,
            "name": input.dataset_name,
            "rowCount": input.row_count,
            "partial": false,
            "columns": columns,
            "viewDigest": view_digest,
        },
        "sources": input.sources,
        "rulePacks": input.rule_packs,
        "unitRegistry": { "version": registry_version(), "sha256": sha256_hex(REGISTRY_JSON.as_bytes()) },
        "steps": [],
        "excludedRows": 0,
        "openIssues": open_issues(&input.issues),
        "assumptions": input.assumptions,
        "substitutions": [],
        "options": { "neutralizeFormulas": input.neutralize },
        "validation": { "ok": data_ok, "checks": data_checks },
        "auditHead": input.audit_head,
        "files": [],
    });
    let readme = render_readme(&manifest);
    manifest["files"] = json!([
        entry(&data_name, data_size, &data_sha, "data"),
        entry(
            "README.txt",
            readme.len() as u64,
            &sha256_hex(readme.as_bytes()),
            "readme"
        ),
        entry(
            "audit.jsonl",
            audit_text.len() as u64,
            &sha256_hex(audit_text.as_bytes()),
            "audit"
        ),
        entry(
            "issues.csv",
            issues_bytes.len() as u64,
            &sha256_hex(&issues_bytes),
            "issues"
        ),
    ]);
    let manifest_text = format!("{}\n", canonical_json(&manifest));

    step("Packaging", 2, progress)?;
    let small: Vec<(String, Vec<u8>)> = vec![
        ("README.txt".into(), readme.into_bytes()),
        ("audit.jsonl".into(), audit_text.into_bytes()),
        ("issues.csv".into(), issues_bytes),
        ("manifest.json".into(), manifest_text.into_bytes()),
    ];
    let mut sums: Vec<(String, String)> = small
        .iter()
        .map(|(p, b)| (p.clone(), sha256_hex(b)))
        .collect();
    sums.push((data_name.clone(), data_sha.clone()));
    let checksums: String = sorted_paths(sums)
        .iter()
        .map(|(p, s)| format!("{s}  {p}\n"))
        .collect();
    let package_name = format!("{}-{}.zip", safe_base(&input.base_name), input.export_id);
    let package_path = match &input.target {
        Some(p) => p.clone(),
        None => tmp.join(&package_name),
    };
    let mut zip = ZipWriter::create(&package_path)?;
    let mut entries: Vec<(String, Option<Vec<u8>>)> =
        small.into_iter().map(|(p, b)| (p, Some(b))).collect();
    entries.push((data_name.clone(), None));
    entries.push(("CHECKSUMS.sha256".into(), Some(checksums.into_bytes())));
    for (path, bytes) in sorted_paths(entries) {
        match bytes {
            Some(b) => zip.add_bytes(&path, &b)?,
            None => {
                let copied = zip.add_file(&path, &data_path, &mut |_| {})?;
                if copied != data_sha {
                    return Err(EngineError::internal(format!(
                        "{path} changed while it was packaged."
                    )));
                }
            }
        }
    }
    zip.finish()?;
    std::fs::remove_file(&data_path)?;

    step("Verifying the package", 3, progress)?;
    let extracted = tmp.join(format!("inside-{data_name}"));
    let package_checks = verify_package(&package_path, &manifest, &data_name, &extracted)?;
    let inside_name = format!("package:{data_name}");
    let inside = if extracted.exists() {
        read_back(conn, input, &extracted, &expected, &inside_name)?
    } else {
        Vec::new()
    };
    let _ = std::fs::remove_file(&extracted);
    let mut checks = manifest["validation"]["checks"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    checks.extend(package_checks);
    checks.extend(inside);
    let ok = checks.iter().all(|c| c["ok"] == true);
    progress("Done", 4);

    let (package_sha, size) = file_sha256(&package_path)?;
    let mut result = json!({
        "exportId": input.export_id,
        "ok": ok,
        "packageName": package_name,
        "packageSha256": if ok { json!(package_sha) } else { Value::Null },
        "size": if ok { size } else { 0 },
        "manifest": manifest,
        "validation": { "ok": ok, "checks": checks },
    });
    if !ok {
        let _ = std::fs::remove_file(&package_path);
        drop(cleanup);
        return Ok(ExportOutcome {
            result,
            bytes: None,
            record: None,
        });
    }
    let record = json!({
        "exportId": input.export_id,
        "profile": input.profile,
        "datasetId": input.dataset_id,
        "packageName": package_name,
        "packageSha256": package_sha,
        "createdAt": input.at,
        "ok": true,
    });
    let bytes = match &input.target {
        Some(p) => {
            result["path"] = json!(p.to_string_lossy());
            None
        }
        None if size <= RETURN_BYTES_MAX => Some(std::fs::read(&package_path)?),
        None => {
            // Too large to hand over in memory: the package stays in the work folder.
            let kept = input.workdir.join(&package_name);
            std::fs::rename(&package_path, &kept)?;
            result["path"] = json!(kept.to_string_lossy());
            None
        }
    };
    drop(cleanup);
    Ok(ExportOutcome {
        result,
        bytes,
        record: Some(record),
    })
}

/// The registry's version ('2026.1'), from the same file the TypeScript engine reads.
fn registry_version() -> String {
    serde_json::from_str::<Value>(REGISTRY_JSON)
        .ok()
        .and_then(|v| v["version"].as_str().map(String::from))
        .unwrap_or_default()
}

/// Deletes the export's work folder when the job ends, however it ends.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scopeguard(dir: PathBuf) -> TempDir {
    TempDir(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_csv_records_as_the_typescript_writer() {
        let mut out = Vec::new();
        csv_record(
            &[
                "a,b".into(),
                "say \"hi\"".into(),
                "x\ny".into(),
                "plain".into(),
            ],
            false,
            &mut out,
        );
        csv_record(&[String::new()], false, &mut out);
        csv_record(&["\u{feff}x".into(), "y".into()], true, &mut out);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\"a,b\",\"say \"\"hi\"\"\",\"x\ny\",plain\r\n\"\"\r\n\"\u{feff}x\",y\r\n"
        );
    }

    #[test]
    fn neutralizes_formulas_reversibly() {
        for (text, written) in [
            ("=SUM(A1)", "'=SUM(A1)"),
            ("+1", "'+1"),
            ("-x", "'-x"),
            ("@cmd", "'@cmd"),
            ("\tx", "'\tx"),
            ("'=x", "''=x"),
            ("plain", "plain"),
            ("'quoted", "'quoted"),
            ("", ""),
        ] {
            assert_eq!(neutralize_formula(text.into()), written, "{text:?}");
            assert_eq!(restore_formula(written), text, "{written:?}");
        }
    }

    #[test]
    fn retypes_text_as_retype_text_does() {
        assert_eq!(retype_text("", Kind::Number), Some(Cell::Null));
        assert_eq!(retype_text("1e+21", Kind::Number), Some(Cell::Num(1e21)));
        assert_eq!(
            retype_text("0.30000000000000004", Kind::Number),
            Some(Cell::Num(0.1 + 0.2))
        );
        for bad in ["01", "1.", ".5", "+1", "1E5", "1,5"] {
            assert_eq!(retype_text(bad, Kind::Number), None, "{bad}");
        }
        assert_eq!(
            retype_text("2026-01-01", Kind::Date),
            Some(Cell::DateText("2026-01-01".into()))
        );
        assert_eq!(retype_text("2026-01-01T00:00:00Z", Kind::DateTime), None);
        assert_eq!(retype_text("True", Kind::Boolean), None);
    }

    #[test]
    fn reads_units_from_headers_and_makes_safe_names() {
        assert_eq!(
            parse_header("Pressure [kPa]"),
            ("Pressure".into(), Some("kPa".into()))
        );
        assert_eq!(parse_header("Choke"), ("Choke".into(), None));
        // As build.ts: the trailing dot goes after the trim, so the space before it stays.
        assert_eq!(safe_base("  well: daily/2026 . "), "well_ daily_2026 ");
        assert_eq!(safe_base("..."), "export");
    }
}
