//! Import under a plan (an ImportSpec). Three stages run at once:
//! - a reader thread hashes the original bytes and cuts them into rows exactly as the TypeScript
//!   reader does: delimited text decoded and tokenized (csv.rs), or Parquet rows as typed fields
//!   (parquet.rs);
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
use crate::parse::{Cell, ColumnParser, DateFormat, Kind, Parsed, Raw};
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

/// How an original is read.
pub enum Reading {
    Csv {
        encoding: String,
        bom_length: u64,
        delimiter: u8,
        skip_lines: u64,
        header_rows: usize,
    },
    Parquet,
    /// JSON records laid out as an array, under a member, or one per line.
    Json(crate::json::Layout),
    /// A table of a workbook sheet, as the format options choose it.
    Xlsx(Value),
}

/// What an import does: how the file is read, and how each column is parsed.
pub struct ImportPlan {
    pub reading: Reading,
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

/// The parser of one column plan (makeParser): its type, null markers, decimal separator and date
/// format, with the file's decimal and thousands separators as defaults.
pub fn column_parser(c: &Value, decimal: char, thousands: &str) -> Result<ColumnParser> {
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
    Ok(ColumnParser::new(
        kind,
        markers,
        col_decimal,
        thousands.to_string(),
        fmt,
    ))
}

fn plan_columns(spec: &Value, decimal: char, thousands: &str) -> Result<Vec<ColumnSpec>> {
    let mut columns = Vec::new();
    for c in spec["columns"].as_array().into_iter().flatten() {
        let parser = column_parser(c, decimal, thousands)?;
        columns.push(ColumnSpec {
            id: c["id"].as_str().unwrap_or_default().to_string(),
            kind: parser.kind,
            parser,
        });
    }
    Ok(columns)
}

/// The plan of an ImportSpec, or why this engine cannot follow it yet.
pub fn import_plan(spec: &Value) -> Result<ImportPlan> {
    let options = &spec["options"];
    let format = text(options, "format").unwrap_or("");
    if format == "parquet" {
        return Ok(ImportPlan {
            reading: Reading::Parquet,
            columns: plan_columns(spec, '.', "")?,
        });
    }
    if format == "json" {
        return Ok(ImportPlan {
            reading: Reading::Json(crate::json::Layout::of_options(&options["json"])),
            columns: plan_columns(spec, '.', "")?,
        });
    }
    if format == "xlsx" {
        return Ok(ImportPlan {
            reading: Reading::Xlsx(options.clone()),
            columns: plan_columns(spec, '.', "")?,
        });
    }
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
    Ok(ImportPlan {
        reading: Reading::Csv {
            encoding,
            bom_length,
            delimiter,
            skip_lines: csv["skipLines"].as_u64().unwrap_or(0),
            header_rows: csv["headerRows"].as_u64().unwrap_or(1) as usize,
        },
        columns: plan_columns(spec, decimal, &thousands)?,
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
fn table_schema(plan: &ImportPlan) -> (Vec<String>, Arc<Schema>) {
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

/// Rows a reader hands on: delimited text, or typed fields.
pub enum Batch {
    Text(RowBatch),
    Typed(TypedBatch),
}

/// Rows of typed fields, each with its source locator.
#[derive(Default)]
pub struct TypedBatch {
    pub rows: Vec<Vec<Raw>>,
    pub locs: Vec<i64>,
}

impl Batch {
    fn rows(&self) -> usize {
        match self {
            Batch::Text(b) => b.rows(),
            Batch::Typed(b) => b.locs.len(),
        }
    }

    fn loc(&self, i: usize) -> i64 {
        match self {
            Batch::Text(b) => b.locs[i],
            Batch::Typed(b) => b.locs[i],
        }
    }

    /// Field `j` of row `i` under `parser`.
    fn parse(&self, i: usize, j: usize, parser: &ColumnParser) -> Parsed {
        match self {
            // A column past the file's own width (the plan has more columns) is missing in every row.
            Batch::Text(b) => {
                let bytes = if j < b.width { b.cell(i, j) } else { None };
                let field = bytes.map(String::from_utf8_lossy);
                parser.parse(field.as_deref())
            }
            Batch::Typed(b) => parser.parse_raw(b.rows[i].get(j).unwrap_or(&Raw::Null)),
        }
    }
}

/// A slice of parsed rows and its exceptions.
type Parsed2 = (RecordBatch, Option<RecordBatch>);

/// Parses rows `from..to` of a batch into a typed record batch whose first row id is `rid`, and
/// the exceptions of those rows.
fn parse_rows(
    batch: &Batch,
    from: usize,
    to: usize,
    rid: i64,
    plan: &ImportPlan,
    schema: &Arc<Schema>,
) -> Result<Parsed2> {
    let n = to - from;
    let mut rids = Int64Builder::with_capacity(n);
    let mut locs = Int64Builder::with_capacity(n);
    for i in from..to {
        rids.append_value(rid + (i - from) as i64);
        locs.append_value(batch.loc(i));
    }
    let mut arrays: Vec<ArrayRef> = vec![Arc::new(rids.finish()), Arc::new(locs.finish())];
    let mut exceptions = Exceptions::default();
    for (j, c) in plan.columns.iter().enumerate() {
        let mut values = Values::new(c.kind, n);
        for i in from..to {
            let row = rid + (i - from) as i64;
            match batch.parse(i, j, &c.parser) {
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
    plan: &ImportPlan,
    send: &dyn Fn(Batch) -> bool,
    cancel: &AtomicBool,
    bytes_read: &AtomicU64,
) -> Result<(Vec<Note>, String, u64)> {
    let Reading::Csv {
        encoding,
        bom_length,
        delimiter,
        skip_lines,
        header_rows,
    } = &plan.reading
    else {
        return Err(EngineError::internal("The file is not delimited text."));
    };
    let mut file = std::fs::File::open(path)?;
    let mut decoder = TextDecoder::new(encoding, *bom_length)?;
    let mut table = TableReader::new(&TableLayout {
        delimiter: *delimiter,
        skip_lines: *skip_lines,
        header_rows: *header_rows,
        batch_rows: BATCH_ROWS,
        keep_blank: false,
    });
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; READ_BYTES];
    let mut utf8 = Vec::with_capacity(READ_BYTES * 3);
    let mut size = 0u64;
    let forward = |table: &mut TableReader| -> Result<()> {
        for b in table.take_batches() {
            if !send(Batch::Text(b)) {
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

/// Hashes a Parquet file, then reads its rows as typed fields, a batch at a time. Returns the
/// notes (none: the footer says everything a reader could), the SHA-256 and the size.
fn read_parquet(
    conn: &Connection,
    path: &Path,
    send: &dyn Fn(Batch) -> bool,
    cancel: &AtomicBool,
    bytes_read: &AtomicU64,
) -> Result<(Vec<Note>, String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; READ_BYTES];
    let mut size = 0u64;
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
    }
    let digest = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let meta = crate::parquet::metadata(conn, path)?;
    let mut batch = TypedBatch::default();
    crate::parquet::read_rows(conn, path, &meta, None, &mut |loc, fields| {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        batch.rows.push(fields);
        batch.locs.push(loc as i64);
        if batch.locs.len() == BATCH_ROWS && !send(Batch::Typed(std::mem::take(&mut batch))) {
            return Err(cancelled());
        }
        Ok(true)
    })?;
    if !batch.locs.is_empty() && !send(Batch::Typed(batch)) {
        return Err(cancelled());
    }
    Ok((Vec::new(), digest, size))
}

/// Hashes and decodes a JSON file and reads its records as rows of typed fields, a batch at a time
/// (json/importer.ts read). The encoding is the one its first MiB shows, as the sniff decided.
pub fn read_json(
    path: &Path,
    layout: &crate::json::Layout,
    send: &mut dyn FnMut(u64, Vec<Raw>) -> Result<()>,
    cancel: &AtomicBool,
    bytes_read: &AtomicU64,
) -> Result<(Vec<Note>, String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut head = Vec::new();
    (&mut file).take(1 << 20).read_to_end(&mut head)?;
    let e = crate::sniff::sniff_encoding(&head);
    let mut decoder = TextDecoder::new(e.value, e.bom_length)?;
    let mut records = crate::json::Records::new(layout);
    let mut columns = crate::json::RecordColumns::default();
    let mut take = |loc: u64, v: crate::json::J| -> Result<()> {
        let fields = columns.row_of(&crate::json::members(v));
        send(loc, fields)
    };
    let mut hash = Sha256::new();
    hash.update(&head);
    let mut size = head.len() as u64;
    let mut utf8 = Vec::with_capacity(READ_BYTES * 3);
    decoder.decode(&head, &mut utf8);
    records.push(&utf8, &mut take)?;
    let mut buf = vec![0u8; READ_BYTES];
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
        records.push(&utf8, &mut take)?;
    }
    utf8.clear();
    decoder.finish(&mut utf8);
    records.push(&utf8, &mut take)?;
    records.finish(&mut take)?;
    let digest = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((Vec::new(), digest, size))
}

/// Hashes a workbook and reads the rows of the table its options choose, a batch at a time
/// (xlsx/importer.ts read), with the notes on what was not imported or was joined.
fn read_xlsx(
    path: &Path,
    options: &Value,
    send: &dyn Fn(Batch) -> bool,
    cancel: &AtomicBool,
    bytes_read: &AtomicU64,
) -> Result<(Vec<Note>, String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; READ_BYTES];
    let mut size = 0u64;
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
    }
    bytes_read.store(size, Ordering::Relaxed);
    let digest = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let mut batch = TypedBatch::default();
    let mut stopped = false;
    let notes = crate::xlsx::read(path, options, &mut |loc, fields| {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        batch.rows.push(fields);
        batch.locs.push(loc as i64);
        if batch.locs.len() == BATCH_ROWS && !send(Batch::Typed(std::mem::take(&mut batch))) {
            stopped = true;
            return Ok(false);
        }
        Ok(true)
    })?;
    if stopped || (!batch.locs.is_empty() && !send(Batch::Typed(batch))) {
        return Err(cancelled());
    }
    Ok((notes, digest, size))
}

/// The text of one field of an original file, read again under the import's plan (lineage.ts
/// sourceText): field `index` of the record that starts on line `loc`, or None when the record has
/// no such field. Reading stops at that record.
pub fn field_text(
    source: &crate::project::OriginalSource,
    plan: &ImportPlan,
    loc: i64,
    index: usize,
) -> Result<Option<String>> {
    use std::io::{Seek, SeekFrom};
    let mut input: Box<dyn Read> = match source {
        crate::project::OriginalSource::File(path) => Box::new(std::fs::File::open(path)?),
        crate::project::OriginalSource::Entry {
            archive,
            offset,
            size,
        } => {
            let mut f = std::fs::File::open(archive)?;
            f.seek(SeekFrom::Start(*offset))?;
            Box::new(f.take(*size))
        }
    };
    let Reading::Csv {
        encoding,
        bom_length,
        delimiter,
        skip_lines,
        header_rows,
    } = &plan.reading
    else {
        return Err(EngineError::internal("The file is not delimited text."));
    };
    let mut decoder = TextDecoder::new(encoding, *bom_length)?;
    let mut table = TableReader::new(&TableLayout {
        delimiter: *delimiter,
        skip_lines: *skip_lines,
        header_rows: *header_rows,
        batch_rows: 1024,
        keep_blank: false,
    });
    let find = |table: &mut TableReader| -> Option<Option<String>> {
        for b in table.take_batches() {
            if let Some(row) = (0..b.rows()).find(|&r| b.locs[r] == loc) {
                return Some(
                    (index < b.width)
                        .then(|| b.cell(row, index))
                        .flatten()
                        .map(|t| String::from_utf8_lossy(t).into_owned()),
                );
            }
        }
        None
    };
    let mut buf = vec![0u8; 1 << 16];
    let mut utf8 = Vec::with_capacity(3 << 16);
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        utf8.clear();
        decoder.decode(&buf[..n], &mut utf8);
        table.push(&utf8)?;
        if let Some(found) = find(&mut table) {
            return Ok(found);
        }
    }
    utf8.clear();
    decoder.finish(&mut utf8);
    table.push(&utf8)?;
    table.finish()?;
    Ok(find(&mut table).flatten())
}

/// Imports `path` as dataset `id`, calling `progress` with the bytes read so far.
#[allow(clippy::too_many_arguments)]
pub fn import_source(
    conn: &Connection,
    path: &Path,
    plan: &ImportPlan,
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
    plan: &ImportPlan,
    stage: &str,
    schema: &Arc<Schema>,
    threads: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(Vec<Note>, String, u64, u64)> {
    let workers = threads.max(1);
    let bytes_read = &AtomicU64::new(0);
    let failed = &AtomicBool::new(false);
    let (row_tx, row_rx) = sync_channel::<Batch>(4);
    let reader_conn = conn.try_clone()?;
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
                let send = |b: Batch| row_tx.send(b).is_ok();
                match &plan.reading {
                    Reading::Csv { .. } => read_file(path, plan, &send, cancel, bytes_read),
                    Reading::Parquet => read_parquet(&reader_conn, path, &send, cancel, bytes_read),
                    Reading::Xlsx(options) => read_xlsx(path, options, &send, cancel, bytes_read),
                    Reading::Json(layout) => {
                        let mut batch = TypedBatch::default();
                        let read = read_json(
                            path,
                            layout,
                            &mut |loc, fields| {
                                batch.rows.push(fields);
                                batch.locs.push(loc as i64);
                                if batch.locs.len() == BATCH_ROWS
                                    && !send(Batch::Typed(std::mem::take(&mut batch)))
                                {
                                    return Err(cancelled());
                                }
                                Ok(())
                            },
                            cancel,
                            bytes_read,
                        );
                        match read {
                            Ok(r) if batch.locs.is_empty() || send(Batch::Typed(batch)) => Ok(r),
                            Ok(_) => Err(cancelled()),
                            Err(e) => Err(e),
                        }
                    }
                }
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
