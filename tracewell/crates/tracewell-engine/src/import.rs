//! CSV import under a reviewed plan (an ImportSpec). Three stages run at once:
//! - a reader thread hashes the original bytes, decodes them and cuts them into rows exactly as
//!   the TypeScript reader does (csv.rs);
//! - worker threads parse each slice of rows with the ported cell parser into typed Arrow batches;
//! - an appender thread writes the batches to a staging database file.
//!
//! Each typed value goes to the rows table. The source text of a value that failed to parse, and
//! the null marker a value matched, go to a side table of exceptions (row id, column, raw text,
//! marker), which is small for any file worth importing. Both tables become Parquet working files
//! (FR-IMP-09), which DuckDB queries without loading them into memory, and the staging file is
//! deleted.

use crate::csv::{Note, RowBatch, TableLayout, TableReader};
use crate::encoding::TextDecoder;
use crate::error::{EngineError, Result};
use crate::parse::{Cell, ColumnParser, DateFormat, Kind, Parsed};
use duckdb::Connection;
use duckdb::arrow::array::{
    ArrayRef, BooleanBuilder, Float64Builder, Int32Builder, Int64Builder, StringBuilder,
};
use duckdb::arrow::datatypes::{DataType, Field, Schema};
use duckdb::arrow::record_batch::RecordBatch;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;

/// Rows per batch, as the TypeScript reader's BATCH_ROWS.
const BATCH_ROWS: usize = 65_536;
const READ_BYTES: usize = 4 << 20;
pub const EXCEPTIONS_SUFFIX: &str = "__exc";
const EXCEPTIONS_DDL: &str = "rid BIGINT, col VARCHAR, raw VARCHAR, marker VARCHAR";

pub struct ColumnSpec {
    pub id: String,
    pub kind: Kind,
    pub parser: ColumnParser,
}

pub struct CsvPlan {
    pub encoding: String,
    pub bom_length: u64,
    pub delimiter: u8,
    pub skip_lines: u64,
    pub header_rows: usize,
    pub columns: Vec<ColumnSpec>,
}

pub struct Imported {
    /// The rows view; the exceptions view is the same name with EXCEPTIONS_SUFFIX.
    pub view: String,
    pub row_count: u64,
    pub notes: Vec<Note>,
    pub sha256: String,
    pub size: u64,
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn kind_of(t: &str) -> Result<Kind> {
    Ok(match t {
        "string" => Kind::String,
        "integer" => Kind::Integer,
        "number" => Kind::Number,
        "boolean" => Kind::Boolean,
        "date" => Kind::Date,
        "datetime" => Kind::DateTime,
        other => {
            return Err(EngineError::unsupported(format!(
                "{other} columns in CSV files"
            )));
        }
    })
}

fn date_format(t: Option<&str>) -> DateFormat {
    match t {
        Some("dmy") => DateFormat::Dmy,
        Some("mdy") => DateFormat::Mdy,
        Some("ymd-slash") => DateFormat::YmdSlash,
        Some("excel-serial") => DateFormat::ExcelSerial,
        _ => DateFormat::Iso,
    }
}

/// The CSV plan of an ImportSpec, or why this engine cannot follow it yet.
pub fn csv_plan(spec: &Value) -> Result<CsvPlan> {
    let options = &spec["options"];
    let format = text(options, "format").unwrap_or("");
    if format != "csv" && format != "tsv" {
        return Err(EngineError::unsupported(format!(
            "{} files",
            format.to_uppercase()
        )));
    }
    let csv = &options["csv"];
    let encoding = text(csv, "encoding").unwrap_or("utf-8").to_string();
    let bom_length = csv["bomLength"].as_u64().unwrap_or(0);
    TextDecoder::new(&encoding, bom_length)?;
    let delimiter = match text(csv, "delimiter").unwrap_or(",") {
        "," => b',',
        ";" => b';',
        "\t" => b'\t',
        "|" => b'|',
        other => {
            return Err(EngineError::invalid(
                format!("The CSV delimiter {other:?} is not one of , ; tab or |."),
                "Choose one of the listed delimiters in the import settings.",
            ));
        }
    };
    if text(csv, "quote").unwrap_or("\"") != "\"" {
        return Err(EngineError::unsupported("CSV quotes other than \""));
    }
    let decimal = text(csv, "decimalSeparator")
        .unwrap_or(".")
        .chars()
        .next()
        .unwrap_or('.');
    let thousands = text(csv, "thousandsSeparator").unwrap_or("").to_string();
    let mut columns = Vec::new();
    for c in spec["columns"].as_array().into_iter().flatten() {
        let kind = kind_of(c["type"]["value"].as_str().unwrap_or("string"))?;
        let markers = c["nullMarkers"]["value"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m.as_str().map(String::from))
            .collect();
        let col_decimal = c["decimalSeparator"]["value"]
            .as_str()
            .and_then(|s| s.chars().next())
            .unwrap_or(decimal);
        let fmt = date_format(c["dateFormat"]["value"].as_str());
        columns.push(ColumnSpec {
            id: c["id"].as_str().unwrap_or_default().to_string(),
            kind,
            parser: ColumnParser::new(kind, markers, col_decimal, thousands.clone(), fmt),
        });
    }
    Ok(CsvPlan {
        encoding,
        bom_length,
        delimiter,
        skip_lines: csv["skipLines"].as_u64().unwrap_or(0),
        header_rows: csv["headerRows"].as_u64().unwrap_or(1) as usize,
        columns,
    })
}

pub fn sql_type(kind: Kind) -> &'static str {
    match kind {
        Kind::String => "VARCHAR",
        Kind::Integer | Kind::Number => "DOUBLE",
        Kind::Boolean => "BOOLEAN",
        Kind::Date => "INTEGER",
        Kind::DateTime => "BIGINT",
    }
}

fn arrow_type(kind: Kind) -> DataType {
    match kind {
        Kind::String => DataType::Utf8,
        Kind::Integer | Kind::Number => DataType::Float64,
        Kind::Boolean => DataType::Boolean,
        Kind::Date => DataType::Int32,
        Kind::DateTime => DataType::Int64,
    }
}

pub fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

pub fn quote_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

enum Values {
    Text(StringBuilder),
    Num(Float64Builder),
    Bool(BooleanBuilder),
    Day(Int32Builder),
    Ms(Int64Builder),
}

impl Values {
    fn new(kind: Kind, rows: usize) -> Self {
        match kind {
            Kind::String => Values::Text(StringBuilder::with_capacity(rows, rows * 8)),
            Kind::Integer | Kind::Number => Values::Num(Float64Builder::with_capacity(rows)),
            Kind::Boolean => Values::Bool(BooleanBuilder::with_capacity(rows)),
            Kind::Date => Values::Day(Int32Builder::with_capacity(rows)),
            Kind::DateTime => Values::Ms(Int64Builder::with_capacity(rows)),
        }
    }

    fn push(&mut self, cell: Option<&Cell>) {
        match (self, cell) {
            (Values::Text(b), Some(Cell::Text(s))) => b.append_value(s),
            (Values::Num(b), Some(Cell::Number(n))) => b.append_value(*n),
            (Values::Bool(b), Some(Cell::Bool(x))) => b.append_value(*x),
            (Values::Day(b), Some(Cell::Date(d))) => b.append_value(*d as i32),
            (Values::Ms(b), Some(Cell::DateTime(t))) => b.append_value(*t),
            (Values::Text(b), _) => b.append_null(),
            (Values::Num(b), _) => b.append_null(),
            (Values::Bool(b), _) => b.append_null(),
            (Values::Day(b), _) => b.append_null(),
            (Values::Ms(b), _) => b.append_null(),
        }
    }

    fn finish(self) -> ArrayRef {
        match self {
            Values::Text(mut b) => Arc::new(b.finish()),
            Values::Num(mut b) => Arc::new(b.finish()),
            Values::Bool(mut b) => Arc::new(b.finish()),
            Values::Day(mut b) => Arc::new(b.finish()),
            Values::Ms(mut b) => Arc::new(b.finish()),
        }
    }
}

/// The rows table: row id, source line, then each column's typed value.
fn table_schema(plan: &CsvPlan) -> (Vec<String>, Arc<Schema>) {
    let mut ddl = vec!["__rid BIGINT".to_string(), "__loc BIGINT".to_string()];
    let mut fields = vec![
        Field::new("__rid", DataType::Int64, false),
        Field::new("__loc", DataType::Int64, false),
    ];
    for c in &plan.columns {
        ddl.push(format!("{} {}", quote_ident(&c.id), sql_type(c.kind)));
        fields.push(Field::new(&c.id, arrow_type(c.kind), true));
    }
    (ddl, Arc::new(Schema::new(fields)))
}

fn exceptions_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("rid", DataType::Int64, false),
        Field::new("col", DataType::Utf8, false),
        Field::new("raw", DataType::Utf8, true),
        Field::new("marker", DataType::Utf8, true),
    ]))
}

/// The exceptions found while parsing a slice of rows.
#[derive(Default)]
struct Exceptions {
    rid: Vec<i64>,
    col: Vec<String>,
    raw: Vec<Option<String>>,
    marker: Vec<Option<String>>,
}

impl Exceptions {
    fn push(&mut self, rid: i64, col: &str, raw: Option<String>, marker: Option<String>) {
        self.rid.push(rid);
        self.col.push(col.to_string());
        self.raw.push(raw);
        self.marker.push(marker);
    }

    fn batch(self) -> Result<Option<RecordBatch>> {
        if self.rid.is_empty() {
            return Ok(None);
        }
        let arrays: Vec<ArrayRef> = vec![
            Arc::new(duckdb::arrow::array::Int64Array::from(self.rid)),
            Arc::new(duckdb::arrow::array::StringArray::from(self.col)),
            Arc::new(duckdb::arrow::array::StringArray::from(self.raw)),
            Arc::new(duckdb::arrow::array::StringArray::from(self.marker)),
        ];
        RecordBatch::try_new(exceptions_schema(), arrays)
            .map(Some)
            .map_err(|e| EngineError::internal(e.to_string()))
    }
}

/// A slice of parsed rows and its exceptions.
type Parsed2 = (RecordBatch, Option<RecordBatch>);

/// Parses rows `from..to` of a batch into a typed record batch whose first row id is `rid`, and
/// the exceptions of those rows.
fn parse_rows(
    batch: &RowBatch,
    from: usize,
    to: usize,
    rid: i64,
    plan: &CsvPlan,
    schema: &Arc<Schema>,
) -> Result<Parsed2> {
    let n = to - from;
    let mut rids = Int64Builder::with_capacity(n);
    let mut locs = Int64Builder::with_capacity(n);
    for i in from..to {
        rids.append_value(rid + (i - from) as i64);
        locs.append_value(batch.locs[i]);
    }
    let mut arrays: Vec<ArrayRef> = vec![Arc::new(rids.finish()), Arc::new(locs.finish())];
    let mut exceptions = Exceptions::default();
    for (j, c) in plan.columns.iter().enumerate() {
        let mut values = Values::new(c.kind, n);
        for i in from..to {
            // A column past the file's own width (the plan has more columns) is missing in every row.
            let bytes = if j < batch.width {
                batch.cell(i, j)
            } else {
                None
            };
            let field = bytes.map(String::from_utf8_lossy);
            let row = rid + (i - from) as i64;
            match c.parser.parse(field.as_deref()) {
                Parsed::Value(cell, marker) => {
                    values.push(Some(&cell));
                    if marker.is_some() {
                        exceptions.push(row, &c.id, None, marker);
                    }
                }
                Parsed::Failed(text) => {
                    values.push(None);
                    exceptions.push(row, &c.id, Some(text), None);
                }
            }
        }
        arrays.push(values.finish());
    }
    let rows = RecordBatch::try_new(schema.clone(), arrays)
        .map_err(|e| EngineError::internal(e.to_string()))?;
    Ok((rows, exceptions.batch()?))
}

fn cancelled() -> EngineError {
    EngineError::new(
        "CANCELLED",
        "The import was cancelled.",
        "Start the import again when you are ready.",
    )
}

/// Reads, hashes and cuts the file into row batches, sending each on. Returns the notes, the
/// SHA-256 and the size.
fn read_file(
    path: &Path,
    plan: &CsvPlan,
    send: &dyn Fn(RowBatch) -> bool,
    cancel: &AtomicBool,
    bytes_read: &AtomicU64,
) -> Result<(Vec<Note>, String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut decoder = TextDecoder::new(&plan.encoding, plan.bom_length)?;
    let mut table = TableReader::new(&TableLayout {
        delimiter: plan.delimiter,
        skip_lines: plan.skip_lines,
        header_rows: plan.header_rows,
        batch_rows: BATCH_ROWS,
        keep_blank: false,
    });
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; READ_BYTES];
    let mut utf8 = Vec::with_capacity(READ_BYTES * 3);
    let mut size = 0u64;
    let forward = |table: &mut TableReader| -> Result<()> {
        for b in table.take_batches() {
            if !send(b) {
                return Err(cancelled());
            }
        }
        Ok(())
    };
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        size += n as u64;
        bytes_read.store(size, Ordering::Relaxed);
        utf8.clear();
        decoder.decode(&buf[..n], &mut utf8);
        table.push(&utf8)?;
        forward(&mut table)?;
    }
    utf8.clear();
    decoder.finish(&mut utf8);
    table.push(&utf8)?;
    table.finish()?;
    forward(&mut table)?;
    let digest = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((std::mem::take(&mut table.notes), digest, size))
}

/// Imports `path` as dataset `id`, calling `progress` with the bytes read so far.
#[allow(clippy::too_many_arguments)]
pub fn import_csv(
    conn: &Connection,
    path: &Path,
    plan: &CsvPlan,
    id: &str,
    workdir: &Path,
    threads: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<Imported> {
    let stage_file = workdir.join(format!("{id}.stage.duckdb"));
    let stage = format!("stage_{id}");
    let _ = std::fs::remove_file(&stage_file);
    let (ddl, schema) = table_schema(plan);
    conn.execute_batch(&format!(
        "ATTACH {file} AS {db}; CREATE TABLE {db}.rows ({cols}); CREATE TABLE {db}.exc ({EXCEPTIONS_DDL});",
        file = quote_text(&stage_file.to_string_lossy()),
        db = quote_ident(&stage),
        cols = ddl.join(", ")
    ))?;
    let outcome = load(conn, path, plan, &stage, &schema, threads, cancel, progress);
    let finished = outcome.and_then(|(notes, sha256, size, rows)| {
        let parquet = workdir.join(format!("{id}.parquet"));
        let exc = workdir.join(format!("{id}{EXCEPTIONS_SUFFIX}.parquet"));
        conn.execute_batch(&format!(
            "COPY {db}.rows TO {file} (FORMAT parquet, COMPRESSION zstd); \
             COPY (SELECT * FROM {db}.exc ORDER BY rid, col) TO {exc} (FORMAT parquet, COMPRESSION zstd); \
             CREATE OR REPLACE VIEW {view} AS SELECT * FROM read_parquet({file}); \
             CREATE OR REPLACE VIEW {exc_view} AS SELECT * FROM read_parquet({exc});",
            db = quote_ident(&stage),
            file = quote_text(&parquet.to_string_lossy()),
            exc = quote_text(&exc.to_string_lossy()),
            view = quote_ident(id),
            exc_view = quote_ident(&format!("{id}{EXCEPTIONS_SUFFIX}")),
        ))?;
        Ok(Imported {
            view: id.to_string(),
            row_count: rows,
            notes,
            sha256,
            size,
        })
    });
    let detached = conn.execute_batch(&format!("DETACH {}", quote_ident(&stage)));
    let _ = std::fs::remove_file(&stage_file);
    let _ = std::fs::remove_file(workdir.join(format!("{id}.stage.duckdb.wal")));
    let imported = finished?;
    detached?;
    Ok(imported)
}

/// Runs the three stages and returns the notes, SHA-256, size and row count.
#[allow(clippy::too_many_arguments)]
fn load(
    conn: &Connection,
    path: &Path,
    plan: &CsvPlan,
    stage: &str,
    schema: &Arc<Schema>,
    threads: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(Vec<Note>, String, u64, u64)> {
    let workers = threads.max(1);
    let bytes_read = &AtomicU64::new(0);
    let failed = &AtomicBool::new(false);
    let (row_tx, row_rx) = sync_channel::<RowBatch>(4);
    let (typed_tx, typed_rx) = sync_channel::<Parsed2>(workers * 2);
    let writer = conn.try_clone()?;
    let exc_writer = conn.try_clone()?;
    let stop = move |e: EngineError| {
        failed.store(true, Ordering::Relaxed);
        e
    };
    std::thread::scope(|s| -> Result<(Vec<Note>, String, u64, u64)> {
        let reader = s.spawn(move || {
            let out = {
                let send = |b: RowBatch| row_tx.send(b).is_ok();
                read_file(path, plan, &send, cancel, bytes_read)
            };
            drop(row_tx);
            out.map_err(stop)
        });
        let appender = s.spawn(move || -> Result<()> {
            let mut rows = writer.appender_to_catalog_and_db("rows", stage, "main")?;
            let mut exc = exc_writer.appender_to_catalog_and_db("exc", stage, "main")?;
            for (b, e) in typed_rx {
                rows.append_record_batch(b)?;
                if let Some(e) = e {
                    exc.append_record_batch(e)?;
                }
            }
            rows.flush()?;
            exc.flush()?;
            Ok(())
        });
        let mut rows: u64 = 0;
        let parsed = (|| -> Result<()> {
            for batch in row_rx {
                if cancel.load(Ordering::Relaxed) || failed.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                let n = batch.rows();
                let slice = n.div_ceil(workers).max(1);
                let base = rows as i64;
                let results: Vec<Result<Parsed2>> = std::thread::scope(|w| {
                    let handles: Vec<_> = (0..n)
                        .step_by(slice)
                        .map(|from| {
                            let batch = &batch;
                            w.spawn(move || {
                                parse_rows(
                                    batch,
                                    from,
                                    (from + slice).min(n),
                                    base + from as i64,
                                    plan,
                                    schema,
                                )
                            })
                        })
                        .collect();
                    handles
                        .into_iter()
                        .map(|h| {
                            h.join().unwrap_or_else(|_| {
                                Err(EngineError::internal("A parse worker stopped."))
                            })
                        })
                        .collect()
                });
                for r in results {
                    if typed_tx.send(r?).is_err() {
                        return Err(EngineError::internal("The appender stopped."));
                    }
                }
                rows += n as u64;
                progress(bytes_read.load(Ordering::Relaxed));
            }
            Ok(())
        })();
        drop(typed_tx);
        let parsed = parsed.map_err(stop);
        let appended = appender
            .join()
            .unwrap_or_else(|_| Err(EngineError::internal("The appender stopped.")));
        let read = reader
            .join()
            .unwrap_or_else(|_| Err(EngineError::internal("The reader stopped.")));
        // The first real failure explains the others (a stopped stage makes the rest stop too).
        let (notes, sha256, size) = match (read, parsed, appended) {
            (Err(e), _, _) if e.code != "CANCELLED" => return Err(e),
            (_, Err(e), _) if e.code != "CANCELLED" => return Err(e),
            (_, _, Err(e)) => return Err(e),
            (Err(e), _, _) | (_, Err(e), _) => return Err(e),
            (Ok(r), Ok(()), Ok(())) => r,
        };
        Ok((notes, sha256, size, rows))
    })
}
