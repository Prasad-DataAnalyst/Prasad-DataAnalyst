//! CSV import under a reviewed plan (an ImportSpec): DuckDB reads the file as text in Arrow
//! batches, every field is parsed in Rust exactly as the TypeScript engine parses it, and the typed
//! rows become a Parquet working file (FR-IMP-09) that DuckDB queries without loading it into memory.

use crate::error::{EngineError, Result};
use crate::parse::{Cell, ColumnParser, DateFormat, Kind, Parsed};
use duckdb::Connection;
use duckdb::arrow::array::cast::AsArray;
use duckdb::arrow::array::{
    Array, ArrayRef, BooleanBuilder, Float64Builder, Int32Builder, Int64Builder, StringBuilder,
    StringViewArray,
};
use duckdb::arrow::datatypes::{DataType, Field, Schema};
use duckdb::arrow::record_batch::RecordBatch;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct ColumnSpec {
    pub id: String,
    pub kind: Kind,
    pub parser: ColumnParser,
}

pub struct CsvPlan {
    pub encoding: String,
    pub bom_length: u64,
    pub delimiter: String,
    pub skip: u64,
    pub columns: Vec<ColumnSpec>,
}

pub struct Imported {
    pub view: String,
    pub row_count: u64,
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
    if !matches!(
        encoding.as_str(),
        "utf-8" | "windows-1252" | "utf-16le" | "utf-16be"
    ) {
        return Err(EngineError::unsupported(format!(
            "the {encoding} text encoding"
        )));
    }
    let decimal = text(csv, "decimalSeparator")
        .unwrap_or(".")
        .chars()
        .next()
        .unwrap_or('.');
    let thousands = text(csv, "thousandsSeparator").unwrap_or("").to_string();
    let skip = csv["skipLines"].as_u64().unwrap_or(0) + csv["headerRows"].as_u64().unwrap_or(1);
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
        bom_length: csv["bomLength"].as_u64().unwrap_or(0),
        delimiter: text(csv, "delimiter").unwrap_or(",").to_string(),
        skip,
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
    fn new(kind: Kind) -> Self {
        match kind {
            Kind::String => Values::Text(StringBuilder::new()),
            Kind::Integer | Kind::Number => Values::Num(Float64Builder::new()),
            Kind::Boolean => Values::Bool(BooleanBuilder::new()),
            Kind::Date => Values::Day(Int32Builder::new()),
            Kind::DateTime => Values::Ms(Int64Builder::new()),
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

/// The strings of one text column of a batch, whatever string layout DuckDB chose.
fn strings(a: &ArrayRef) -> Vec<Option<String>> {
    match a.data_type() {
        DataType::Utf8 => a
            .as_string::<i32>()
            .iter()
            .map(|x| x.map(String::from))
            .collect(),
        DataType::LargeUtf8 => a
            .as_string::<i64>()
            .iter()
            .map(|x| x.map(String::from))
            .collect(),
        DataType::Utf8View => a
            .as_any()
            .downcast_ref::<StringViewArray>()
            .map(|s| s.iter().map(|x| x.map(String::from)).collect())
            .unwrap_or_default(),
        _ => (0..a.len()).map(|_| None).collect(),
    }
}

/// Imports `path` as dataset `id`, calling `progress` with the rows read so far.
pub fn import_csv(
    conn: &Connection,
    path_in: &Path,
    plan: &CsvPlan,
    id: &str,
    workdir: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<Imported> {
    let staging = format!("{id}__load");
    let mut ddl = vec!["__rid BIGINT".to_string(), "__loc BIGINT".to_string()];
    let mut fields = vec![
        Field::new("__rid", DataType::Int64, false),
        Field::new("__loc", DataType::Int64, false),
    ];
    for c in &plan.columns {
        ddl.push(format!("{} {}", quote_ident(&c.id), sql_type(c.kind)));
        ddl.push(format!(
            "{} VARCHAR",
            quote_ident(&format!("{}__raw", c.id))
        ));
        ddl.push(format!(
            "{} VARCHAR",
            quote_ident(&format!("{}__marker", c.id))
        ));
        fields.push(Field::new(&c.id, arrow_type(c.kind), true));
        fields.push(Field::new(format!("{}__raw", c.id), DataType::Utf8, true));
        fields.push(Field::new(
            format!("{}__marker", c.id),
            DataType::Utf8,
            true,
        ));
    }
    let schema = Arc::new(Schema::new(fields));
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {0}; CREATE TABLE {0} ({1});",
        quote_ident(&staging),
        ddl.join(", ")
    ))?;

    let names: Vec<String> = plan
        .columns
        .iter()
        .map(|c| format!("{}: 'VARCHAR'", quote_text(&c.id)))
        .collect();
    let utf8 = crate::encoding::as_utf8(path_in, &plan.encoding, plan.bom_length, workdir, id)?;
    let path = utf8.as_path();
    let source = |parallel: bool| {
        format!(
            "SELECT * FROM read_csv({path}, delim = {delim}, quote = '\"', escape = '\"', header = false, skip = {skip}, \
             auto_detect = false, all_varchar = true, null_padding = true, strict_mode = false, parallel = {parallel}, \
             columns = {{{cols}}})",
            path = quote_text(&path.to_string_lossy()),
            delim = quote_text(&plan.delimiter),
            skip = plan.skip,
            cols = names.join(", "),
        )
    };
    let writer = conn.try_clone()?;
    // The parallel reader cannot pad short rows when quoted fields hold line breaks; such a file
    // is read again by the single-threaded reader.
    let rows = match load(
        conn,
        &writer,
        &source(true),
        &staging,
        plan,
        &schema,
        cancel,
        progress,
    ) {
        Err(e) if e.message.contains("Parameter Not Allowed") || e.message.contains("parallel") => {
            conn.execute_batch(&format!("DELETE FROM {}", quote_ident(&staging)))?;
            load(
                conn,
                &writer,
                &source(false),
                &staging,
                plan,
                &schema,
                cancel,
                progress,
            )?
        }
        other => other?,
    };
    let parquet = workdir.join(format!("{id}.parquet"));
    let view = id.to_string();
    conn.execute_batch(&format!(
        "COPY {load} TO {file} (FORMAT parquet, COMPRESSION zstd); DROP TABLE {load}; \
         CREATE OR REPLACE VIEW {view} AS SELECT * FROM read_parquet({file});",
        load = quote_ident(&staging),
        file = quote_text(&parquet.to_string_lossy()),
        view = quote_ident(&view),
    ))?;
    if utf8 != path_in {
        std::fs::remove_file(&utf8)?;
    }
    Ok(Imported {
        view,
        row_count: rows,
    })
}

/// Line breaks inside a field's text: LF, CR and CRLF each count once, as the TypeScript reader counts.
fn line_breaks(text: &str) -> i64 {
    let b = text.as_bytes();
    let mut n = 0;
    for (i, &c) in b.iter().enumerate() {
        if c == b'\n' && (i == 0 || b[i - 1] != b'\r') || c == b'\r' {
            n += 1;
        }
    }
    n
}

/// Streams the source query's text batches, parses them under the plan and appends typed rows.
#[allow(clippy::too_many_arguments)]
fn load(
    conn: &Connection,
    writer: &Connection,
    source: &str,
    table: &str,
    plan: &CsvPlan,
    schema: &Arc<Schema>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<u64> {
    let mut appender = writer.appender(table)?;
    let mut rid: i64 = 0;
    // The physical line of the next record: after the skipped lines and the header.
    let mut next_line: i64 = plan.skip as i64 + 1;
    let mut stmt = conn.prepare(source)?;
    for batch in stmt.query_arrow([])? {
        if cancel.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The import was cancelled.",
                "Run it again when you are ready.",
            ));
        }
        let n = batch.num_rows();
        let raw: Vec<Vec<Option<String>>> = (0..plan.columns.len())
            .map(|j| strings(batch.column(j)))
            .collect();
        let mut rids = Int64Builder::with_capacity(n);
        let mut locs = Int64Builder::with_capacity(n);
        for i in 0..n {
            rids.append_value(rid + i as i64);
            locs.append_value(next_line);
            next_line += 1 + raw
                .iter()
                .map(|col| col[i].as_deref().map_or(0, line_breaks))
                .sum::<i64>();
        }
        let mut arrays: Vec<ArrayRef> = vec![Arc::new(rids.finish()), Arc::new(locs.finish())];
        for (j, c) in plan.columns.iter().enumerate() {
            let mut values = Values::new(c.kind);
            let mut failed = StringBuilder::new();
            let mut markers = StringBuilder::new();
            for x in &raw[j] {
                match c.parser.parse(x.as_deref()) {
                    Parsed::Value(cell, marker) => {
                        values.push(Some(&cell));
                        failed.append_null();
                        match marker {
                            Some(m) => markers.append_value(m),
                            None => markers.append_null(),
                        }
                    }
                    Parsed::Failed(text) => {
                        values.push(None);
                        failed.append_value(text);
                        markers.append_null();
                    }
                }
            }
            arrays.push(values.finish());
            arrays.push(Arc::new(failed.finish()));
            arrays.push(Arc::new(markers.finish()));
        }
        let typed = RecordBatch::try_new(schema.clone(), arrays)
            .map_err(|e| EngineError::internal(e.to_string()))?;
        appender.append_record_batch(typed)?;
        rid += n as i64;
        progress(rid as u64);
    }
    appender.flush()?;
    Ok(rid as u64)
}
