//! Validated export packages (SAD section 10), as the TypeScript export module builds them: write
//! the data files the profile plans, read each back through a separate reader and compare it with
//! the output view by row count, header, types and per-column digests, assemble the package with
//! its README, manifest, audit log, issues and checksums, re-open the package and verify everything
//! again, and only then offer it. A package that fails any check is deleted, never offered.
//!
//! The native engine writes the Excel, CSV and Parquet profiles; the profile list is the same JSON
//! file as the TypeScript engine's.

use crate::canonical::{canonical_json, canonical_number, json_string, sha256_hex};
use crate::csv::{TableLayout, TableReader};
use crate::digest::{Cell, ColumnDigest, cell_at, read_back_cell};
use crate::encoding::TextDecoder;
use crate::error::{EngineError, Result};
use crate::import::{quote_ident, quote_text};
use crate::parse::Kind;
use crate::stream::each_batch;
use crate::units::REGISTRY_JSON;
use crate::xlsx::writer::{
    Column as SheetColumn, EXCEL_MAX_CELL_CHARS, EXCEL_MAX_DATA_ROWS, SheetWriter, write_book,
};
use crate::zip::{Entry, ZipWriter, read_entries, read_entry};
use duckdb::Connection;
use duckdb::arrow::array::{AsArray, RecordBatch};
use duckdb::arrow::datatypes::Int64Type;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub const PROFILES_JSON: &str = include_str!("../../../src/export/profiles.json");
/// Profiles this engine writes; the others are listed as not available yet.
const NATIVE_PROFILES: [&str; 3] = ["excel", "csv", "parquet"];
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
                json!({
                    "profile": p,
                    "available": false,
                    "reason": "The native engine does not write GeoJSON files yet.",
                    "fix": "Export as Excel, CSV or Parquet instead.",
                    "substitutions": [],
                })
            }
        })
        .collect()
}

pub fn native_profile(id: &str) -> bool {
    NATIVE_PROFILES.contains(&id)
}

/// The profile statuses of one dataset (profileStatuses): the Excel profile lists the
/// substitutions the dataset needs.
pub fn profile_statuses_for(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    rows: u64,
) -> Result<Vec<Value>> {
    let mut statuses = profile_statuses();
    for s in &mut statuses {
        if s["profile"]["id"] == "excel" {
            s["substitutions"] =
                json!(plan_export(conn, view, columns, rows, "excel")?.substitutions);
        }
    }
    Ok(statuses)
}

// ---------------------------------------------------------------------------------------------
// The plan (plan.ts)

/// What a data file of a package is.
#[derive(Clone, Copy, PartialEq, Debug)]
enum DataKind {
    Csv,
    Parquet,
    Xlsx,
}

/// A data file a profile writes: its path in the package and the columns of the view it holds.
struct DataFile {
    path: &'static str,
    kind: DataKind,
    columns: Vec<usize>,
}

/// What an export writes: its data files and the format-limit substitutions (TW-EXP-002) it needs.
struct Plan {
    substitutions: Vec<Value>,
    files: Vec<DataFile>,
}

/// Text columns holding a value longer than an Excel cell holds, counted in UTF-16 units as
/// JavaScript counts them. A value that long has more UTF-8 bytes than that, which DuckDB counts.
fn long_text_columns(conn: &Connection, view: &str, columns: &[OutColumn]) -> Result<Vec<usize>> {
    let mut out = Vec::new();
    for (j, c) in columns.iter().enumerate() {
        if c.kind != Kind::String {
            continue;
        }
        let col = quote_ident(&c.id);
        let sql = format!("SELECT {col} FROM {view} WHERE strlen({col}) > {EXCEL_MAX_CELL_CHARS}");
        let mut long = false;
        each_batch(conn, &sql, |batch| {
            let a = batch.column(0);
            long = long
                || (0..batch.num_rows()).any(|i| {
                    matches!(cell_at(a, i, Kind::String), Cell::Text(t) if t.encode_utf16().count() > EXCEL_MAX_CELL_CHARS)
                });
            Ok(())
        })?;
        if long {
            out.push(j);
        }
    }
    Ok(out)
}

/// The data files a profile writes and the substitutions it needs (planExport).
fn plan_export(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    rows: u64,
    profile: &str,
) -> Result<Plan> {
    let all: Vec<usize> = (0..columns.len()).collect();
    let single = |path, kind| Plan {
        substitutions: Vec::new(),
        files: vec![DataFile {
            path,
            kind,
            columns: (0..columns.len()).collect(),
        }],
    };
    if profile == "csv" {
        return Ok(single("data.csv", DataKind::Csv));
    }
    if profile != "excel" {
        return Ok(single("data.parquet", DataKind::Parquet));
    }
    if rows > EXCEL_MAX_DATA_ROWS {
        return Ok(Plan {
            substitutions: vec![json!({
                "ruleId": "TW-EXP-002",
                "what": format!("{rows} data rows"),
                "why": format!("An Excel sheet holds at most {EXCEL_MAX_DATA_ROWS} data rows below its header."),
                "instead": "The data is delivered as data.csv in the package; the workbook keeps the Report and Log sheets and a notice.",
            })],
            files: vec![
                DataFile {
                    path: "data.csv",
                    kind: DataKind::Csv,
                    columns: all,
                },
                DataFile {
                    path: "data.xlsx",
                    kind: DataKind::Xlsx,
                    columns: Vec::new(),
                },
            ],
        });
    }
    let long = long_text_columns(conn, view, columns)?;
    if long.is_empty() {
        return Ok(single("data.xlsx", DataKind::Xlsx));
    }
    let names: Vec<&str> = long.iter().map(|&j| columns[j].name.as_str()).collect();
    Ok(Plan {
        substitutions: vec![json!({
            "ruleId": "TW-EXP-002",
            "what": format!("the column{} {}", if long.len() > 1 { "s" } else { "" }, names.join(", ")),
            "why": format!("Some values are longer than the {EXCEL_MAX_CELL_CHARS} characters an Excel cell can hold."),
            "instead": "These columns are delivered in data-long-text.csv in the package, row for row with the Data sheet.",
        })],
        files: vec![
            DataFile {
                path: "data.xlsx",
                kind: DataKind::Xlsx,
                columns: all.into_iter().filter(|j| !long.contains(j)).collect(),
            },
            DataFile {
                path: "data-long-text.csv",
                kind: DataKind::Csv,
                columns: long,
            },
        ],
    })
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
    /// Rows in the output view: the dataset's rows less the excluded ones.
    pub row_count: u64,
    pub excluded_rows: u64,
    /// The steps the output view went through, and each described as it was applied.
    pub steps: Vec<Value>,
    pub step_descriptions: Vec<String>,
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
    /// Whether reading the view in row order needs ORDER BY: a view that joins cell edits can
    /// return rows out of order.
    pub ordered: bool,
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
    // Columns are handed out one at a time, text first (the slowest to read), so no worker idles
    // while another still has a queue of columns.
    let mut order: Vec<usize> = (0..columns.len()).collect();
    order.sort_by_key(|&j| columns[j].kind != Kind::String);
    let next = AtomicUsize::new(0);
    let mut results: Vec<Option<Result<T>>> = (0..columns.len()).map(|_| None).collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = conns
            .into_iter()
            .map(|c| {
                let (per_column, order, next) = (&per_column, &order, &next);
                s.spawn(move || {
                    let mut done = Vec::new();
                    while let Some(&j) = order.get(next.fetch_add(1, Ordering::Relaxed)) {
                        done.push((j, per_column(&c, &columns[j])));
                    }
                    done
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

fn order_by(ordered: bool) -> &'static str {
    if ordered { " ORDER BY __rid" } else { "" }
}

/// Streams one column of the view in row order.
fn scan_column(
    conn: &Connection,
    view: &str,
    ordered: bool,
    c: &OutColumn,
    mut f: impl FnMut(Cell),
) -> Result<()> {
    let sql = format!(
        "SELECT __rid, {} FROM {view}{}",
        quote_ident(&c.id),
        order_by(ordered)
    );
    let mut last: i64 = -1;
    each_batch(conn, &sql, |batch| {
        let rids = batch.column(0).as_primitive::<Int64Type>();
        let values = batch.column(1);
        for i in 0..batch.num_rows() {
            // The working file is written in row order and read back in it; excluded rows leave
            // gaps, but a row out of order would mean the digest compares the wrong rows.
            if rids.value(i) <= last {
                return Err(EngineError::internal(format!(
                    "The working table is out of row order after row {last} of column {}.",
                    c.id
                )));
            }
            last = rids.value(i);
            f(cell_at(values, i, c.kind));
        }
        Ok(())
    })
}

/**
 * The digest the TypeScript viewDigest gives a view without steps (SAD section 9.4):
 * the SHA-256 of the canonical JSON of its row count and each column's name, unit, type and value
 * digest. A project file records it, and opening the project compares it after replay.
 */
pub fn dataset_digest(
    conn: &Connection,
    view: &str,
    ordered: bool,
    columns: &[OutColumn],
    rows: u64,
    threads: usize,
) -> Result<String> {
    let digests = per_column(conn, columns, threads, |conn, c| {
        let mut d = ColumnDigest::default();
        scan_column(conn, view, ordered, c, |cell| d.push(&cell))?;
        Ok(d.finish())
    })?;
    let summary = json!({
        "rowCount": rows,
        "columns": columns
            .iter()
            .zip(&digests)
            .map(|(c, sha)| json!({ "name": c.name, "unit": c.unit, "type": c.typ, "sha256": sha }))
            .collect::<Vec<_>>(),
    });
    Ok(sha256_hex(canonical_json(&summary).as_bytes()))
}

fn view_digests(conn: &Connection, input: &ExportInput) -> Result<Vec<ColumnDigests>> {
    per_column(conn, &input.columns, input.threads, |conn, c| {
        let mut exported = ColumnDigest::default();
        let mut view = (c.kind == Kind::String).then(ColumnDigest::default);
        scan_column(conn, &input.view, input.ordered, c, |cell| {
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
    if formula_start(&text) {
        format!("'{text}")
    } else {
        text
    }
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
                fields[j] = if neutralize && *kind == Kind::String {
                    neutralize_formula(text)
                } else {
                    text
                };
            }
            csv_record(&fields, false, out);
        }
    }
}

fn write_csv(
    conn: &Connection,
    input: &ExportInput,
    cols: &[usize],
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let columns: Vec<&OutColumn> = cols.iter().map(|&j| &input.columns[j]).collect();
    let mut out = BufWriter::with_capacity(1 << 20, File::create(path)?);
    let header: Vec<String> = columns.iter().map(|c| c.header()).collect();
    let mut head = Vec::new();
    csv_record(&header, true, &mut head);
    out.write_all(&head)?;
    let kinds: Vec<Kind> = columns.iter().map(|c| c.kind).collect();
    let select: Vec<String> = columns.iter().map(|c| quote_ident(&c.id)).collect();
    let sql = format!(
        "SELECT {} FROM {}{}",
        select.join(", "),
        input.view,
        order_by(input.ordered)
    );
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
    each_batch(conn, &sql, |batch| {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        rows += batch.num_rows();
        group.push(batch);
        if rows >= 65_536 * workers {
            flush(&mut group, &mut out)?;
            rows = 0;
        }
        Ok(())
    })?;
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
        "SET TimeZone = 'UTC'; COPY (SELECT {} FROM {}{}) TO {} (FORMAT parquet, COMPRESSION snappy)",
        select.join(", "),
        input.view,
        order_by(input.ordered),
        quote_text(&path.to_string_lossy())
    ))
    .or_else(|_| {
        // A build without time zone support keeps TIMESTAMPTZ in UTC anyway.
        conn.execute_batch(&format!(
            "COPY (SELECT {} FROM {}{}) TO {} (FORMAT parquet, COMPRESSION snappy)",
            select.join(", "),
            input.view,
            order_by(input.ordered),
            quote_text(&path.to_string_lossy())
        ))
    })?;
    Ok(())
}

/// The Report sheet: sources, rule packs, steps, assumptions, open issues, substitutions and the
/// digest of every column of the view (reportRows).
fn report_rows(
    input: &ExportInput,
    plan: &Plan,
    digests: &[ColumnDigests],
) -> Vec<(String, String)> {
    let open = open_issues(&input.issues);
    let mut rows: Vec<(String, String)> = vec![
        (
            "Project".into(),
            format!(
                "{} ({})",
                text(&input.project["name"]),
                text(&input.project["id"])
            ),
        ),
        (
            "Dataset".into(),
            format!(
                "{} ({}), {} rows",
                input.dataset_name, input.dataset_id, input.row_count
            ),
        ),
        (
            "Export".into(),
            format!(
                "{}, profile {}, created {} by {}",
                input.export_id, input.profile, input.at, input.owner
            ),
        ),
    ];
    for s in &input.sources {
        rows.push((
            "Source".into(),
            format!(
                "{}, {} bytes, SHA-256 {}",
                text(&s["name"]),
                text(&s["size"]),
                text(&s["fileId"])
            ),
        ));
    }
    for r in &input.rule_packs {
        rows.push((
            "Rule pack".into(),
            format!(
                "{} {}, SHA-256 {}",
                text(&r["id"]),
                text(&r["version"]),
                text(&r["sha256"])
            ),
        ));
    }
    rows.push((
        "Unit registry".into(),
        format!(
            "{}, SHA-256 {}",
            registry_version(),
            sha256_hex(REGISTRY_JSON.as_bytes())
        ),
    ));
    for (i, d) in input.step_descriptions.iter().enumerate() {
        rows.push((format!("Step {}", i + 1), d.clone()));
    }
    rows.push(("Excluded rows".into(), input.excluded_rows.to_string()));
    for a in &input.assumptions {
        rows.push((
            "Assumption".into(),
            format!(
                "{} {} = {} ({})",
                a["columnId"].as_str().unwrap_or("dataset"),
                text(&a["property"]),
                stringify(&a["value"]),
                text(&a["confidence"])
            ),
        ));
    }
    rows.push((
        "Open issues".into(),
        format!(
            "errors {}, warnings {}, notes {}",
            open["error"], open["warning"], open["note"]
        ),
    ));
    for s in &plan.substitutions {
        rows.push((
            text(&s["ruleId"]),
            format!(
                "{}. {} {}",
                text(&s["what"]),
                text(&s["why"]),
                text(&s["instead"])
            ),
        ));
    }
    for (c, d) in input.columns.iter().zip(digests) {
        rows.push((format!("Column digest {}", c.header()), d.exported.clone()));
    }
    rows
}

/// One audit entry as a row of the Log sheet (logSheet); JSON members are written in sorted order.
fn log_row(e: &Value) -> Vec<Cell> {
    let actor = &e["actor"];
    let who = if actor["kind"] == "user" {
        format!("{} ({})", text(&actor["name"]), text(&actor["role"]))
    } else {
        format!("system: {}", text(&actor["component"]))
    };
    let json_of = |k: &str| e.get(k).map_or(Cell::Null, |v| Cell::Text(stringify(v)));
    vec![
        Cell::Num(e["seq"].as_f64().unwrap_or(0.0)),
        crate::time::millis_from_iso(e["at"].as_str().unwrap_or(""))
            .map_or(Cell::Null, Cell::DateTime),
        Cell::Text(who),
        Cell::Text(text(&e["action"])),
        json_of("target"),
        json_of("old"),
        json_of("new"),
        e["reason"]
            .as_str()
            .map_or(Cell::Null, |r| Cell::Text(r.to_string())),
        e.get("method")
            .and_then(|m| m["formula"].as_str())
            .map_or(Cell::Null, |f| Cell::Text(f.to_string())),
        Cell::Text(text(&e["hash"])),
    ]
}

/// Writes the workbook of the Excel profile: a Data sheet of the columns given (none when the
/// data goes to a CSV file instead), the Report sheet and the Log sheet.
fn write_xlsx(
    conn: &Connection,
    input: &ExportInput,
    plan: &Plan,
    cols: &[usize],
    digests: &[ColumnDigests],
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let parts = path.with_extension("parts");
    std::fs::create_dir_all(&parts)?;
    let mut sheets = Vec::new();
    if !cols.is_empty() {
        let columns: Vec<SheetColumn> = cols
            .iter()
            .map(|&j| SheetColumn {
                header: input.columns[j].header(),
                kind: input.columns[j].kind,
                width: None,
            })
            .collect();
        let mut sheet = SheetWriter::create(&parts.join("data.xml"), "Data", columns, true, true)?;
        let kinds: Vec<Kind> = cols.iter().map(|&j| input.columns[j].kind).collect();
        let select: Vec<String> = cols
            .iter()
            .map(|&j| quote_ident(&input.columns[j].id))
            .collect();
        let sql = format!(
            "SELECT {} FROM {}{}",
            select.join(", "),
            input.view,
            order_by(input.ordered)
        );
        let mut row = vec![Cell::Null; cols.len()];
        each_batch(conn, &sql, |batch| {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            for i in 0..batch.num_rows() {
                for (j, kind) in kinds.iter().enumerate() {
                    row[j] = cell_at(batch.column(j), i, *kind);
                }
                sheet.row(&row)?;
            }
            Ok(())
        })?;
        sheets.push(sheet.finish()?);
    }
    let text_column = |header: &str, width: f64| SheetColumn {
        header: header.into(),
        kind: Kind::String,
        width: Some(width),
    };
    let mut report = SheetWriter::create(
        &parts.join("report.xml"),
        "Report",
        vec![text_column("Item", 28.0), text_column("Value", 100.0)],
        true,
        false,
    )?;
    for (item, value) in report_rows(input, plan, digests) {
        report.row(&[Cell::Text(item), Cell::Text(value)])?;
    }
    sheets.push(report.finish()?);
    let column = |header: &str, kind| SheetColumn {
        header: header.into(),
        kind,
        width: None,
    };
    let mut log = SheetWriter::create(
        &parts.join("log.xml"),
        "Log",
        vec![
            column("Seq", Kind::Integer),
            column("Time (UTC)", Kind::DateTime),
            column("Actor", Kind::String),
            column("Action", Kind::String),
            column("Target", Kind::String),
            column("Old", Kind::String),
            column("New", Kind::String),
            column("Reason", Kind::String),
            column("Method", Kind::String),
            column("Hash", Kind::String),
        ],
        true,
        true,
    )?;
    for e in &input.audit {
        log.row(&log_row(e))?;
    }
    sheets.push(log.finish()?);
    write_book(
        path,
        &sheets,
        &input.at,
        &input.owner,
        Some(&input.dataset_name),
    )?;
    std::fs::remove_dir_all(&parts)?;
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
        if let Some(u) = unit.strip_suffix(']')
            && !u.is_empty()
            && !u.contains(['[', ']'])
        {
            return (h[..open].to_string(), Some(u.to_string()));
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
        let sql = format!("SELECT {} FROM read_parquet({p})", quote_ident(&names[j]));
        let mut d = ColumnDigest::default();
        let mut exact = true;
        each_batch(conn, &sql, |batch| {
            // Once a value no cell holds exactly turns up, the column cannot match.
            if !exact {
                return Ok(());
            }
            let a = batch.column(0);
            for i in 0..batch.num_rows() {
                match read_back_cell(a, i, c.kind) {
                    Some(cell) => d.push(&cell),
                    None => {
                        exact = false;
                        break;
                    }
                }
            }
            Ok(())
        })?;
        Ok(exact.then(|| d.finish()))
    })?;
    checks.push(values_check(expected, &digests, file));
    Ok(checks)
}

/// A workbook cell re-typed by the column's type (retypeXlsx); None when it does not fit.
fn retype_xlsx(v: &crate::parse::Raw, kind: Kind) -> Option<Cell> {
    use crate::parse::Raw;
    Some(match (kind, v) {
        (_, Raw::Null) => Cell::Null,
        (Kind::Number | Kind::Integer, Raw::Number(n)) => Cell::Num(*n),
        (Kind::Boolean, Raw::Bool(b)) => Cell::Bool(*b),
        (Kind::Date, Raw::Date(d)) => Cell::DateText(d.clone()),
        (Kind::Date, Raw::DateTime(t)) if t.ends_with("T00:00:00.000Z") => {
            Cell::DateText(t[..10].to_string())
        }
        (Kind::DateTime, Raw::DateTime(t)) => Cell::DateTimeText(t.clone()),
        (Kind::DateTime, Raw::Date(d)) => Cell::DateTimeText(format!("{d}T00:00:00.000Z")),
        (Kind::String, Raw::Text(t)) => Cell::Text(t.clone()),
        _ => return None,
    })
}

/// A header cell as JavaScript's String() writes it.
fn header_text(v: &crate::parse::Raw) -> String {
    use crate::parse::Raw;
    match v {
        Raw::Text(t) => t.clone(),
        Raw::Number(_) | Raw::Bool(_) | Raw::Null => v.text(),
        Raw::Date(_) | Raw::DateTime(_) | Raw::Error(_) => "[object Object]".into(),
    }
}

/// Opens a workbook the export wrote with the product reader and checks its sheets, the Data
/// sheet's header, rows, storage types and values, and its frozen header and filter (readXlsx).
fn read_back_xlsx(
    path: &Path,
    expected: &Expected,
    file: &str,
    expect_data: bool,
    expected_log_rows: u64,
) -> Vec<Value> {
    let mut book = match crate::xlsx::open(path) {
        Ok(b) => b,
        Err(e) => {
            return vec![check(
                "RB-OPEN",
                false,
                format!("The workbook does not open: {}", e.message),
                Some(file),
            )];
        }
    };
    let mut checks = vec![check(
        "RB-OPEN",
        true,
        "The workbook opens.".into(),
        Some(file),
    )];
    let names: Vec<String> = book.sheets.iter().map(|(n, _)| n.clone()).collect();
    let mut required: Vec<&str> = Vec::new();
    if expect_data {
        required.push("Data");
    }
    required.extend(["Report", "Log"]);
    let mut problems: Vec<String> = required
        .iter()
        .filter(|n| !names.iter().any(|m| m == *n))
        .map(|n| format!("the {n} sheet is missing"))
        .collect();
    let mut read = |name: &str, problems: &mut Vec<String>| match book.read_sheet(name) {
        Ok(s) => Some(s),
        Err(e) => {
            problems.push(format!("the {name} sheet cannot be read: {}", e.message));
            None
        }
    };
    if names.iter().any(|n| n == "Log")
        && let Some(log) = read("Log", &mut problems)
    {
        let entries = log.rows.iter().filter(|r| r.r > 0).count() as u64;
        if entries != expected_log_rows {
            problems.push(format!(
                "the Log sheet has {entries} entries instead of {expected_log_rows}"
            ));
        }
    }
    if expect_data
        && names.iter().any(|n| n == "Data")
        && let Some(sheet) = read("Data", &mut problems)
    {
        let width = expected.columns.len();
        if sheet.frozen != Some((1, 0)) {
            problems.push("the header is not frozen at A2".into());
        }
        let covered = sheet.auto_filter.is_some_and(|f| {
            f.sr == 0
                && f.sc == 0
                && f.ec as i64 == width as i64 - 1
                && f.er as u64 == expected.rows
        });
        if !covered {
            problems.push("the filter does not cover the header and every data row".into());
        }
        if !sheet.merges.is_empty() {
            problems.push(format!(
                "the Data sheet has {} merged ranges",
                sheet.merges.len()
            ));
        }
        let header: Vec<String> = sheet
            .rows
            .iter()
            .find(|r| r.r == 0)
            .map(|r| r.cells.iter().map(|c| header_text(&c.v)).collect())
            .unwrap_or_default();
        checks.push(header_check(expected, &header, file));
        // Rows without cells are left out by the reader and come back empty.
        let last = sheet.rows.iter().map(|r| r.r).max().unwrap_or(0) as usize;
        let mut dense: Vec<Vec<Option<&crate::xlsx::Cell>>> = vec![vec![None; width]; last];
        let mut extra = 0u64;
        for row in sheet.rows.iter().filter(|r| r.r > 0) {
            for cell in &row.cells {
                match dense[row.r as usize - 1].get_mut(cell.c as usize) {
                    Some(slot) => *slot = Some(cell),
                    None => extra += 1,
                }
            }
        }
        let data_rows = dense.len() as u64;
        checks.push(rows_check(
            if data_rows <= expected.rows {
                expected.rows
            } else {
                data_rows
            },
            expected.rows,
            file,
        ));
        if extra > 0 {
            problems.push(format!("{extra} cells lie outside the data columns"));
        }
        let mut wrong: Vec<String> = Vec::new();
        for (j, col) in expected.columns.iter().enumerate() {
            let numeric = matches!(col.kind, Kind::Number | Kind::Integer);
            let date = matches!(col.kind, Kind::Date | Kind::DateTime);
            for (i, row) in dense.iter().enumerate() {
                let Some(cell) = row[j] else { continue };
                if matches!(cell.v, crate::parse::Raw::Null) {
                    continue;
                }
                let bad_number =
                    numeric && (cell.t != "n" || !matches!(cell.v, crate::parse::Raw::Number(_)));
                if bad_number || (date && !cell.is_date) {
                    wrong.push(format!("{} row {}", col.header(), i + 2));
                }
            }
        }
        checks.push(if wrong.is_empty() {
            check(
                "RB-XLSX-TYPES",
                true,
                "Numbers are stored as numbers and dates carry date formats.".into(),
                Some(file),
            )
        } else {
            check(
                "RB-XLSX-TYPES",
                false,
                format!(
                    "Cells with the wrong storage type: {}{}.",
                    wrong[..wrong.len().min(5)].join(", "),
                    if wrong.len() > 5 { ", …" } else { "" }
                ),
                Some(file),
            )
        });
        let null = crate::parse::Raw::Null;
        let got: Vec<Option<String>> = expected
            .columns
            .iter()
            .enumerate()
            .map(|(j, col)| {
                let mut d = ColumnDigest::default();
                for i in 0..expected.rows as usize {
                    let v = dense.get(i).and_then(|row| row[j]).map_or(&null, |c| &c.v);
                    d.push(&retype_xlsx(v, col.kind)?);
                }
                Some(d.finish())
            })
            .collect();
        checks.push(values_check(expected, &got, file));
    }
    let data_note = if expect_data {
        "; header frozen at A2; filter over the data; no merged cells"
    } else {
        ""
    };
    checks.push(if problems.is_empty() {
        check(
            "RB-XLSX-STRUCTURE",
            true,
            format!("Sheets {} present{data_note}.", required.join(", ")),
            Some(file),
        )
    } else {
        check(
            "RB-XLSX-STRUCTURE",
            false,
            format!("Workbook structure problems: {}.", problems.join("; ")),
            Some(file),
        )
    });
    checks
}

/// Reads one data file back with the product reader of its format.
fn read_back(
    conn: &Connection,
    input: &ExportInput,
    kind: DataKind,
    path: &Path,
    expected: &Expected,
    file: &str,
) -> Result<Vec<Value>> {
    match kind {
        DataKind::Csv => read_back_csv(path, expected, file, input.threads, input.neutralize),
        DataKind::Parquet => read_back_parquet(conn, path, expected, file, input.threads),
        DataKind::Xlsx => Ok(read_back_xlsx(
            path,
            expected,
            file,
            !expected.columns.is_empty(),
            input.audit.len() as u64,
        )),
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
fn render_readme(m: &Value, steps: &[String]) -> String {
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
    lines.push(format!("STEPS ({})", steps.len()));
    if steps.is_empty() {
        lines.push("  none".into());
    }
    lines.extend(
        steps
            .iter()
            .enumerate()
            .map(|(i, d)| format!("  {}. {d}", i + 1)),
    );
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

fn verify_package(zip: &Path, manifest: &Value, data: &[(String, PathBuf)]) -> Result<Vec<Value>> {
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
                        // Data files are extracted while they are checked, for the inside read-back.
                        let actual = match data.iter().find(|(p, _)| p == path) {
                            Some((_, to)) => {
                                let mut out = BufWriter::with_capacity(1 << 20, File::create(to)?);
                                let sha = read_entry(zip, e, &mut |b| Ok(out.write_all(b)?));
                                out.flush()?;
                                sha
                            }
                            None => read_entry(zip, e, &mut |_| Ok(())),
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
    let plan = plan_export(
        conn,
        &input.view,
        &input.columns,
        input.row_count,
        &input.profile,
    )?;
    let tmp = input.workdir.join(format!("export-{}", input.export_id));
    std::fs::create_dir_all(&tmp)?;
    let cleanup = scopeguard(tmp.clone());

    step("Writing", 0, progress)?;
    let digests = view_digests(conn, input)?;
    // Each data file with the columns it holds and their digests over exported values.
    let shapes: Vec<(Vec<OutColumn>, Vec<String>)> = plan
        .files
        .iter()
        .map(|f| {
            (
                f.columns
                    .iter()
                    .map(|&j| input.columns[j].clone())
                    .collect(),
                f.columns
                    .iter()
                    .map(|&j| digests[j].exported.clone())
                    .collect(),
            )
        })
        .collect();
    for f in &plan.files {
        let path = tmp.join(f.path);
        match f.kind {
            DataKind::Csv => write_csv(conn, input, &f.columns, &path, cancel)?,
            DataKind::Parquet => write_parquet(conn, input, &path)?,
            DataKind::Xlsx => write_xlsx(conn, input, &plan, &f.columns, &digests, &path, cancel)?,
        }
    }

    step("Reading back", 1, progress)?;
    let expected_of = |k: usize| Expected {
        rows: input.row_count,
        columns: &shapes[k].0,
        digests: shapes[k].1.clone(),
    };
    let mut data_checks: Vec<Value> = Vec::new();
    for (k, f) in plan.files.iter().enumerate() {
        data_checks.extend(read_back(
            conn,
            input,
            f.kind,
            &tmp.join(f.path),
            &expected_of(k),
            f.path,
        )?);
    }

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
    let mut data_files: Vec<(String, String, u64)> = Vec::new();
    for f in &plan.files {
        let (sha, size) = file_sha256(&tmp.join(f.path))?;
        data_files.push((f.path.to_string(), sha, size));
    }
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
        "steps": input.steps,
        "excludedRows": input.excluded_rows,
        "openIssues": open_issues(&input.issues),
        "assumptions": input.assumptions,
        "substitutions": plan.substitutions,
        "options": { "neutralizeFormulas": input.neutralize },
        "validation": { "ok": data_ok, "checks": data_checks },
        "auditHead": input.audit_head,
        "files": [],
    });
    let readme = render_readme(&manifest, &input.step_descriptions);
    let mut files: Vec<Value> = data_files
        .iter()
        .map(|(path, sha, size)| entry(path, *size, sha, "data"))
        .collect();
    files.extend([
        entry(
            "README.txt",
            readme.len() as u64,
            &sha256_hex(readme.as_bytes()),
            "readme",
        ),
        entry(
            "audit.jsonl",
            audit_text.len() as u64,
            &sha256_hex(audit_text.as_bytes()),
            "audit",
        ),
        entry(
            "issues.csv",
            issues_bytes.len() as u64,
            &sha256_hex(&issues_bytes),
            "issues",
        ),
    ]);
    manifest["files"] = json!(files);
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
    sums.extend(
        data_files
            .iter()
            .map(|(p, sha, _)| (p.clone(), sha.clone())),
    );
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
    entries.extend(data_files.iter().map(|(p, _, _)| (p.clone(), None)));
    entries.push(("CHECKSUMS.sha256".into(), Some(checksums.into_bytes())));
    for (path, bytes) in sorted_paths(entries) {
        match bytes {
            Some(b) => zip.add_bytes(&path, &b)?,
            None => {
                let copied = zip.add_file(&path, &tmp.join(&path), &mut |_| {})?;
                let written = data_files
                    .iter()
                    .find(|(p, _, _)| *p == path)
                    .map(|(_, sha, _)| sha);
                if written != Some(&copied) {
                    return Err(EngineError::internal(format!(
                        "{path} changed while it was packaged."
                    )));
                }
            }
        }
    }
    zip.finish()?;
    for (path, _, _) in &data_files {
        std::fs::remove_file(tmp.join(path))?;
    }

    step("Verifying the package", 3, progress)?;
    let extracted: Vec<(String, PathBuf)> = plan
        .files
        .iter()
        .map(|f| (f.path.to_string(), tmp.join(format!("inside-{}", f.path))))
        .collect();
    let package_checks = verify_package(&package_path, &manifest, &extracted)?;
    let mut inside = Vec::new();
    for (k, (f, (_, path))) in plan.files.iter().zip(&extracted).enumerate() {
        if path.exists() {
            let name = format!("package:{}", f.path);
            inside.extend(read_back(
                conn,
                input,
                f.kind,
                path,
                &expected_of(k),
                &name,
            )?);
            let _ = std::fs::remove_file(path);
        }
    }
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
    fn plans_excel_substitutions_for_rows_and_text_beyond_its_limits() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE v (c0 VARCHAR, c1 DOUBLE); INSERT INTO v VALUES ('{}', 1), ('short', 2);",
            "é".repeat(16_384)
        ))
        .unwrap();
        let column = |id: &str, name: &str, kind| OutColumn {
            id: id.into(),
            name: name.into(),
            unit: None,
            typ: if kind == Kind::String {
                "string"
            } else {
                "number"
            }
            .into(),
            kind,
        };
        let columns = [
            column("c0", "note", Kind::String),
            column("c1", "rate", Kind::Number),
        ];
        let files = |p: &Plan| {
            p.files
                .iter()
                .map(|f| (f.path, f.kind, f.columns.clone()))
                .collect::<Vec<_>>()
        };
        // 16,384 two-byte characters are 32,768 bytes but only 16,384 UTF-16 units: they fit.
        let fits = plan_export(&conn, "v", &columns, 2, "excel").unwrap();
        assert!(fits.substitutions.is_empty());
        assert_eq!(files(&fits), [("data.xlsx", DataKind::Xlsx, vec![0, 1])]);
        conn.execute_batch(&format!(
            "INSERT INTO v VALUES ('{}', 3)",
            "x".repeat(32_768)
        ))
        .unwrap();
        let long = plan_export(&conn, "v", &columns, 3, "excel").unwrap();
        assert_eq!(long.substitutions[0]["what"], "the column note");
        assert_eq!(
            files(&long),
            [
                ("data.xlsx", DataKind::Xlsx, vec![1]),
                ("data-long-text.csv", DataKind::Csv, vec![0])
            ]
        );
        let many = plan_export(&conn, "v", &columns, 1_048_576, "excel").unwrap();
        assert_eq!(many.substitutions[0]["what"], "1048576 data rows");
        assert_eq!(
            many.substitutions[0]["why"],
            "An Excel sheet holds at most 1048575 data rows below its header."
        );
        assert_eq!(
            files(&many),
            [
                ("data.csv", DataKind::Csv, vec![0, 1]),
                ("data.xlsx", DataKind::Xlsx, vec![])
            ]
        );
    }

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
