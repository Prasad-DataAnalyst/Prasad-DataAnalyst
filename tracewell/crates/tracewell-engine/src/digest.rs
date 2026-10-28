//! Column digests (SAD section 9.4, normative), computed from Arrow arrays: for each cell, the
//! UTF-8 byte length of its canonical encoding in ASCII decimal, ':', then the encoding itself.
//! The canonical encoding is canonical.rs canonical_cell, written here straight from typed values.

use crate::canonical::{canonical_number, write_canonical_number};
use crate::parse::Kind;
use crate::time::{date_text, iso_from_millis};
use duckdb::arrow::array::{Array, ArrayRef, AsArray};
use duckdb::arrow::datatypes::{DataType, Float64Type, Int32Type, Int64Type, TimeUnit};
use sha2::{Digest, Sha256};

/// A cell as the digest and the text writers see it.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Null,
    Num(f64),
    Bool(bool),
    Text(String),
    /// Days since 1970-01-01.
    Date(i64),
    /// Milliseconds since 1970-01-01T00:00:00Z.
    DateTime(i64),
    /// A date read back from text, kept as written ('YYYY-MM-DD').
    DateText(String),
    /// A date-time read back from text, kept as written.
    DateTimeText(String),
}

impl Cell {
    /// The canonical cell encoding (canonical_cell).
    pub fn canonical(&self, out: &mut String) {
        match self {
            Cell::Null => out.push_str("\u{0}N"),
            Cell::Num(x) => {
                out.push_str("n:");
                write_canonical_number(*x, out);
            }
            Cell::Bool(b) => out.push_str(if *b { "b:1" } else { "b:0" }),
            Cell::Text(s) => {
                out.push_str("s:");
                out.push_str(s);
            }
            Cell::Date(d) => {
                out.push_str("d:");
                out.push_str(&date_text(*d));
            }
            Cell::DateTime(t) => {
                out.push_str("t:");
                out.push_str(&iso_from_millis(*t));
            }
            Cell::DateText(d) => {
                out.push_str("d:");
                out.push_str(d);
            }
            Cell::DateTimeText(t) => {
                out.push_str("t:");
                out.push_str(t);
            }
        }
    }

    /// The text an exported text file holds for the cell (values.ts textOf).
    pub fn text(&self) -> String {
        match self {
            Cell::Null => String::new(),
            Cell::Num(x) => canonical_number(*x),
            Cell::Bool(b) => if *b { "true" } else { "false" }.into(),
            Cell::Text(s) => s.clone(),
            Cell::Date(d) => date_text(*d),
            Cell::DateTime(t) => iso_from_millis(*t),
            Cell::DateText(s) | Cell::DateTimeText(s) => s.clone(),
        }
    }

    /// Exported text cannot tell an empty string from no value, so both count as no value.
    pub fn exportable(self) -> Cell {
        match self {
            Cell::Text(s) if s.is_empty() => Cell::Null,
            other => other,
        }
    }
}

/// Row `i` of an array holding a column of `kind`, as the working tables store it.
pub fn cell_at(a: &ArrayRef, i: usize, kind: Kind) -> Cell {
    if a.is_null(i) {
        return Cell::Null;
    }
    match (kind, a.data_type()) {
        (Kind::Number | Kind::Integer, DataType::Float64) => {
            Cell::Num(a.as_primitive::<Float64Type>().value(i))
        }
        (Kind::Boolean, DataType::Boolean) => Cell::Bool(a.as_boolean().value(i)),
        (Kind::Date, DataType::Int32) => Cell::Date(a.as_primitive::<Int32Type>().value(i) as i64),
        (Kind::DateTime, DataType::Int64) => Cell::DateTime(a.as_primitive::<Int64Type>().value(i)),
        (Kind::String, DataType::Utf8) => Cell::Text(a.as_string::<i32>().value(i).to_string()),
        (Kind::String, DataType::LargeUtf8) => {
            Cell::Text(a.as_string::<i64>().value(i).to_string())
        }
        (Kind::String, DataType::Utf8View) => Cell::Text(a.as_string_view().value(i).to_string()),
        _ => Cell::Null,
    }
}

/// A value read back from a typed file (Parquet), or None when no cell of `kind` holds it exactly.
pub fn read_back_cell(a: &ArrayRef, i: usize, kind: Kind) -> Option<Cell> {
    if a.is_null(i) {
        return Some(Cell::Null);
    }
    Some(match (kind, a.data_type()) {
        (Kind::Number, DataType::Float64) => Cell::Num(a.as_primitive::<Float64Type>().value(i)),
        (Kind::Integer, DataType::Int64) => {
            let v = a.as_primitive::<Int64Type>().value(i);
            if v.unsigned_abs() > 9_007_199_254_740_991 {
                return None;
            }
            Cell::Num(v as f64)
        }
        (Kind::Boolean, DataType::Boolean) => Cell::Bool(a.as_boolean().value(i)),
        (Kind::Date, DataType::Date32) => Cell::Date(
            a.as_primitive::<duckdb::arrow::datatypes::Date32Type>()
                .value(i) as i64,
        ),
        (Kind::DateTime, DataType::Timestamp(unit, _)) => {
            let raw = match unit {
                TimeUnit::Second => {
                    a.as_primitive::<duckdb::arrow::datatypes::TimestampSecondType>()
                        .value(i)
                        * 1000
                }
                TimeUnit::Millisecond => a
                    .as_primitive::<duckdb::arrow::datatypes::TimestampMillisecondType>()
                    .value(i),
                TimeUnit::Microsecond => {
                    let us = a
                        .as_primitive::<duckdb::arrow::datatypes::TimestampMicrosecondType>()
                        .value(i);
                    if us % 1000 != 0 {
                        return None;
                    }
                    us / 1000
                }
                TimeUnit::Nanosecond => {
                    let ns = a
                        .as_primitive::<duckdb::arrow::datatypes::TimestampNanosecondType>()
                        .value(i);
                    if ns % 1_000_000 != 0 {
                        return None;
                    }
                    ns / 1_000_000
                }
            };
            Cell::DateTime(raw)
        }
        (Kind::String, DataType::Utf8) => Cell::Text(a.as_string::<i32>().value(i).to_string()),
        (Kind::String, DataType::LargeUtf8) => {
            Cell::Text(a.as_string::<i64>().value(i).to_string())
        }
        (Kind::String, DataType::Utf8View) => Cell::Text(a.as_string_view().value(i).to_string()),
        _ => return None,
    })
}

/// A column digest being computed, one cell at a time (columnDigest).
pub struct ColumnDigest {
    hash: Sha256,
    cell: String,
    block: Vec<u8>,
}

impl Default for ColumnDigest {
    fn default() -> Self {
        ColumnDigest {
            hash: Sha256::new(),
            cell: String::new(),
            block: Vec::with_capacity(1 << 16),
        }
    }
}

impl ColumnDigest {
    pub fn push(&mut self, c: &Cell) {
        use std::io::Write;
        self.cell.clear();
        c.canonical(&mut self.cell);
        let _ = write!(self.block, "{}:", self.cell.len());
        self.block.extend_from_slice(self.cell.as_bytes());
        if self.block.len() >= 1 << 16 {
            self.hash.update(&self.block);
            self.block.clear();
        }
    }

    pub fn finish(mut self) -> String {
        self.hash.update(&self.block);
        self.hash
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::{canonical_cell, sha256_hex};
    use serde_json::json;

    #[test]
    fn encodes_cells_as_canonical_cell_does() {
        let cases = [
            (Cell::Null, json!(null)),
            (Cell::Num(0.1 + 0.2), json!(0.30000000000000004)),
            (Cell::Bool(true), json!(true)),
            (Cell::Text("ü \"q\"".into()), json!("ü \"q\"")),
            (Cell::Date(-1), json!({ "date": "1969-12-31" })),
            (
                Cell::DateTime(1_700_000_000_123),
                json!({ "datetime": "2023-11-14T22:13:20.123Z" }),
            ),
        ];
        for (cell, value) in cases {
            let mut s = String::new();
            cell.canonical(&mut s);
            assert_eq!(s, canonical_cell(&value));
        }
    }

    #[test]
    fn digests_length_prefixed_cells() {
        let mut d = ColumnDigest::default();
        d.push(&Cell::Text("ab".into()));
        d.push(&Cell::Null);
        assert_eq!(d.finish(), sha256_hex("4:s:ab2:\u{0}N".as_bytes()));
    }
}
