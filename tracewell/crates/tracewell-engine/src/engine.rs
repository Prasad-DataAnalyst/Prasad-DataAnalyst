//! The native engine's state and protocol methods. Each change is an audit draft appended to the
//! hash-chained log, in the same format and with the same payloads as the TypeScript engine, so a
//! project's history means the same thing whichever engine wrote it.

use crate::audit::AuditLog;
use crate::canonical::sha256_hex;
use crate::checks::{CheckCtx, Col, summarize};
use crate::csv::Note;
use crate::error::{EngineError, Result};
use crate::framing::{Incoming, write_message};
use crate::import::{CsvPlan, EXCEPTIONS_SUFFIX, csv_plan, import_csv, quote_ident, quote_text};
use crate::issues::{
    IssueState, Listed, matches, merge_check_run, occurrence_state, open_rows, sort, to_issue,
};
use crate::parse::Kind;
use crate::rules::{Draft, RowSet, check_packs};
use crate::time::{Clock, IdSource, date_text, iso_from_millis};
use duckdb::Connection;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const ENGINE_NAME: &str = "tracewell-native";
pub const PROTOCOL_VERSION: &str = "0.3.0";
const ROW_WINDOW_MAX: u64 = 1000;
const DISTINCT_CAP: i64 = 10_000;

pub struct Dataset {
    pub id: String,
    pub name: String,
    pub spec: Value,
    pub view: String,
    pub row_count: u64,
    pub assumptions: Vec<Value>,
    pub columns: Vec<(String, Kind)>,
    /// The reader's notes on the file (ragged rows, multi-row header, assumed encoding).
    pub notes: Vec<Note>,
    pub issues: Vec<IssueState>,
    /// The rule packs of the last check run, recorded in export manifests.
    pub check_packs: Vec<Value>,
    /// The working Parquet files: the typed rows and the source text of values that did not parse.
    pub rows_file: PathBuf,
    pub exceptions_file: PathBuf,
    /// The `source.add` entry that imported it, which a project file's cache names.
    pub source_seq: u64,
    /// Rows the user excluded; the working view leaves them out.
    pub excluded: RowSet,
    /// Each rows.exclude entry still in force, with the rows it excluded, ascending. A row is
    /// excluded by exactly one entry.
    pub exclusions: Vec<(u64, Vec<u64>)>,
    /// Cell edits by (column, row): the value and the entry that set it (the Overlay).
    pub edits: BTreeMap<(String, u64), (Value, u64)>,
}

impl Dataset {
    fn exceptions_view(&self) -> String {
        format!("{}{EXCEPTIONS_SUFFIX}", self.view)
    }

    /// The view of every row, excluded ones included, for looking rows up by ID.
    fn all_view(&self) -> String {
        format!("{}__all", self.view)
    }

    fn all_exceptions_view(&self) -> String {
        format!("{}__all{EXCEPTIONS_SUFFIX}", self.view)
    }

    /// Rows in the working view: all but the excluded ones.
    fn visible_rows(&self) -> u64 {
        self.row_count - self.excluded.count()
    }

    /// Whether a check run has been recorded for it, so a change runs the checks again.
    fn checked(&self) -> bool {
        !self.check_packs.is_empty()
    }

    /// The rows.exclude entry that excluded a row.
    fn excluded_by(&self, row: u64) -> Option<u64> {
        self.exclusions
            .iter()
            .find(|(_, rows)| rows.binary_search(&row).is_ok())
            .map(|(seq, _)| *seq)
    }

    /// The row ID at visible position `i` of the working view.
    fn row_at(&self, i: u64) -> u64 {
        let mut r = i;
        for e in self.excluded.iter() {
            if e > r {
                break;
            }
            r += 1;
        }
        r
    }

    fn check_columns(&self) -> Vec<Col> {
        self.spec["columns"]
            .as_array()
            .into_iter()
            .flatten()
            .zip(&self.columns)
            .map(|(c, (_, kind))| Col::from_schema(c, *kind))
            .collect()
    }
}

pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub profile: Value,
    pub unit_system: String,
    pub log: AuditLog,
    pub datasets: Vec<Dataset>,
    pub originals: Vec<Value>,
    pub next_dataset: u64,
    /// Records of the packages exported and verified.
    pub exports: Vec<Value>,
    /// Where each original's bytes are, by file ID, for saving them into the project file.
    pub original_paths: HashMap<String, crate::project::OriginalSource>,
    pub last_saved_at: Option<String>,
    /// Set when an opened project failed an integrity check: it can be read, not changed.
    pub read_only: bool,
    /// The project area as the last project.area entry set it: null or [west, south, east, north].
    pub project_area: Value,
    /// Entries an entry.revert has undone.
    pub reverted: HashSet<u64>,
}

/// The project area as the checks take it.
fn area_of(v: &Value) -> Option<[f64; 4]> {
    let a = v.as_array()?;
    Some([
        a.first()?.as_f64()?,
        a.get(1)?.as_f64()?,
        a.get(2)?.as_f64()?,
        a.get(3)?.as_f64()?,
    ])
}

pub struct Engine {
    pub conn: Connection,
    pub workdir: PathBuf,
    pub clock: Box<dyn Clock>,
    pub ids: Box<dyn IdSource>,
    pub version: String,
    pub memory_limit: u64,
    /// Worker threads for parsing; DuckDB has its own setting.
    pub threads: usize,
    /// The registered owner of this copy, recorded in every export manifest.
    pub owner: String,
    pub project: Option<Project>,
    jobs: HashMap<String, Value>,
    /// Bytes a finished job hands back with its result (a small export package).
    pub job_bytes: HashMap<String, Vec<u8>>,
    cancels: HashMap<String, Arc<AtomicBool>>,
    next_job: u64,
}

/// What every thread shares: the engine behind a lock, and the output stream behind another, so
/// a job can report progress while a call is being answered.
pub struct Shared {
    pub engine: Mutex<Engine>,
    pub out: Mutex<Box<dyn Write + Send>>,
}

impl Shared {
    pub fn send(&self, msg: &Value) {
        if let Ok(mut w) = self.out.lock() {
            // A closed output means the client has gone; there is nobody left to tell.
            let _ = write_message(&mut *w, msg);
        }
    }

    /// Sends an escaped message carrying byte frames.
    pub fn send_framed(&self, escaped: &Value, frames: &[&[u8]]) {
        if let Ok(mut w) = self.out.lock() {
            let _ = crate::framing::write_with_frames(&mut *w, escaped, frames);
        }
    }

    pub fn event(&self, event: Value) {
        self.send(&json!({ "kind": "event", "event": event }));
    }
}

fn user_actor(profile: &Value) -> Value {
    json!({ "kind": "user", "profileId": profile["id"], "name": profile["name"], "role": "Analyst" })
}

fn draft(action: &str, target: Value) -> Map<String, Value> {
    let mut d = Map::new();
    d.insert("action".into(), Value::String(action.into()));
    d.insert("target".into(), target);
    d
}

fn count(v: &Value, name: &str, default: u64, max: u64) -> Result<u64> {
    match v {
        Value::Null => Ok(default),
        Value::Number(n) => match n.as_f64() {
            Some(x) if x >= 0.0 && x.fract() == 0.0 && x <= max as f64 => Ok(x as u64),
            _ => Err(EngineError::invalid(
                format!("{name} must be a whole number from 0 to {max}; it was {n}."),
                format!("Pass a valid {name}."),
            )),
        },
        other => Err(EngineError::invalid(
            format!("{name} must be a whole number; it was {other}."),
            format!("Pass a valid {name}."),
        )),
    }
}

/// 'well data.csv' → 'well data', as the TypeScript datasetNameFor.
fn dataset_name_for(file_name: &str) -> String {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let stem = match base.rfind('.') {
        Some(i) if i > 0 => &base[..i],
        _ => base,
    }
    .trim();
    if stem.is_empty() {
        "dataset".into()
    } else {
        stem.into()
    }
}

fn assumed(c: &Value) -> bool {
    ["type", "role", "unit", "nullMarkers"]
        .iter()
        .any(|k| c[k]["assumed"].as_bool() == Some(true))
}

impl Engine {
    pub fn new(
        conn: Connection,
        workdir: PathBuf,
        clock: Box<dyn Clock>,
        ids: Box<dyn IdSource>,
        memory_limit: u64,
        threads: usize,
        owner: String,
    ) -> Self {
        Engine {
            conn,
            workdir,
            clock,
            ids,
            version: env!("CARGO_PKG_VERSION").into(),
            memory_limit,
            threads,
            owner,
            project: None,
            jobs: HashMap::new(),
            job_bytes: HashMap::new(),
            cancels: HashMap::new(),
            next_job: 1,
        }
    }

    fn project(&self) -> Result<&Project> {
        self.project.as_ref().ok_or_else(|| {
            EngineError::not_found(
                "No project is open.",
                "Create a new project or open a .twp project file.",
            )
        })
    }

    /// The open project, unless it opened read-only.
    fn writable(&self) -> Result<&Project> {
        let p = self.project()?;
        if p.read_only {
            return Err(EngineError::new(
                "READ_ONLY_PROJECT",
                "This project opened read-only because its integrity checks failed, so it cannot be changed.",
                "Review the Open report and the project issues. To continue working, import the original files into a new project.",
            ));
        }
        Ok(p)
    }

    fn dataset(&self, id: &Value) -> Result<&Dataset> {
        let id = id.as_str().unwrap_or("");
        self.project()?
            .datasets
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| {
                EngineError::not_found(
                    format!("There is no dataset {id} in this project."),
                    "Choose a listed dataset.",
                )
            })
    }

    fn append(&mut self, d: Map<String, Value>, actor: Option<Value>) -> Result<Value> {
        let at = self.clock.now_iso();
        let p = self.project.as_mut().ok_or_else(|| {
            EngineError::not_found("No project is open.", "Create a new project first.")
        })?;
        let actor = actor.unwrap_or_else(|| user_actor(&p.profile));
        Ok(p.log.append(d, at, actor))
    }

    pub fn hello(&self) -> Value {
        json!({
            "name": ENGINE_NAME,
            "version": self.version,
            "protocol": PROTOCOL_VERSION,
            "capabilities": {
                "formats": ["csv", "tsv"],
                "exportProfiles": ["csv", "parquet"],
                "memoryBudgetBytes": self.memory_limit,
                "spillToDisk": true,
                "crsTransform": false,
            }
        })
    }

    pub fn new_project(&mut self, o: &Value) -> Result<Value> {
        let name = o["name"].as_str().map(str::trim).unwrap_or("");
        if name.is_empty() || name.chars().count() > 200 {
            return Err(EngineError::invalid(
                "A project name must be text of 1 to 200 characters.",
                "Type a name for the project.",
            ));
        }
        let profile = &o["profile"];
        let pname = profile["name"].as_str().map(str::trim).unwrap_or("");
        if profile["id"].as_str().unwrap_or("").is_empty()
            || pname.is_empty()
            || profile["role"] != "Analyst"
        {
            return Err(EngineError::invalid(
                "The user profile is incomplete.",
                "Pass a profile with an id, a name and the role Analyst.",
            ));
        }
        let unit_system = o["unitSystem"].as_str().unwrap_or("SI");
        if unit_system != "SI" && unit_system != "Oilfield" {
            return Err(EngineError::invalid(
                format!("The unit system {unit_system} is not supported."),
                "Choose SI or Oilfield.",
            ));
        }
        let profile = json!({ "id": profile["id"], "name": pname, "role": "Analyst" });
        let id = self.ids.new_project_id();
        self.project = Some(Project {
            id: id.clone(),
            name: name.into(),
            created_at: String::new(),
            profile: profile.clone(),
            unit_system: unit_system.into(),
            log: AuditLog::new(&id),
            datasets: Vec::new(),
            originals: Vec::new(),
            next_dataset: 1,
            exports: Vec::new(),
            original_paths: HashMap::new(),
            last_saved_at: None,
            read_only: false,
            project_area: Value::Null,
            reverted: HashSet::new(),
        });
        let mut d = draft("project.create", json!({}));
        d.insert(
            "new".into(),
            json!({ "name": name, "unitSystem": unit_system }),
        );
        d.insert("payload".into(), json!({ "profile": profile }));
        let entry = self.append(d, None)?;
        if let Some(p) = self.project.as_mut() {
            p.created_at = entry["at"].as_str().unwrap_or_default().into();
        }
        std::fs::create_dir_all(self.workdir.join(&id))?;
        self.summary()
    }

    fn dataset_summary(d: &Dataset) -> Value {
        json!({
            "id": d.id,
            "name": d.name,
            "source": { "fileId": d.spec["fileId"], "fileName": d.spec["fileName"], "format": d.spec["options"]["format"] },
            "rowCount": d.row_count,
            "outputRowCount": d.visible_rows(),
            "columnCount": d.columns.len(),
            "assumptions": d.assumptions.len(),
            "partial": false,
            "steps": [],
        })
    }

    pub fn summary(&self) -> Result<Value> {
        let p = self.project()?;
        let (seq, hash) = p.log.head();
        Ok(json!({
            "id": p.id,
            "name": p.name,
            "createdAt": p.created_at,
            "profile": p.profile,
            "unitSystem": p.unit_system,
            "projectArea": p.project_area,
            "readOnly": p.read_only,
            "dirty": p.log.entries().last().is_some_and(|e| e["action"] != "project.save"),
            "lastSavedAt": p.last_saved_at,
            "originals": p.originals,
            "datasets": p.datasets.iter().map(Self::dataset_summary).collect::<Vec<_>>(),
            "exports": p.exports,
            "rulePacks": rule_packs_of(&p.log),
            "auditHead": { "seq": seq, "hash": hash },
        }))
    }

    pub fn schema(&self, dataset: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        Ok(json!({
            "datasetId": d.id,
            "name": d.name,
            "source": { "fileId": d.spec["fileId"], "fileName": d.spec["fileName"], "format": d.spec["options"]["format"] },
            "rowCount": d.visible_rows(),
            "columns": d.spec["columns"],
            "crs": d.spec["crs"],
            "geometryColumn": null,
            "partial": false,
        }))
    }

    fn cell(row: &duckdb::Row, i: usize, kind: Kind) -> Result<Value> {
        Ok(match kind {
            Kind::String => row
                .get::<_, Option<String>>(i)?
                .map_or(Value::Null, Value::String),
            Kind::Integer | Kind::Number => row
                .get::<_, Option<f64>>(i)?
                .map_or(Value::Null, |x| json!(x)),
            Kind::Boolean => row
                .get::<_, Option<bool>>(i)?
                .map_or(Value::Null, Value::Bool),
            Kind::Date => row
                .get::<_, Option<i32>>(i)?
                .map_or(Value::Null, |d| json!({ "date": date_text(d as i64) })),
            Kind::DateTime => row
                .get::<_, Option<i64>>(i)?
                .map_or(Value::Null, |t| json!({ "datetime": iso_from_millis(t) })),
        })
    }

    pub fn rows(&self, q: &Value) -> Result<Value> {
        let d = self.dataset(&q["datasetId"])?;
        let stage = q["stage"].as_str().unwrap_or("");
        if stage != "working" && stage != "output" {
            return Err(EngineError::invalid(
                format!("The stage {stage} does not exist."),
                "Ask for the 'working' or the 'output' stage.",
            ));
        }
        let offset = count(&q["offset"], "offset", 0, u64::MAX >> 11)?;
        let limit = count(&q["limit"], "limit", 0, ROW_WINDOW_MAX)?;
        let wanted: Vec<String> = match q["columns"].as_array() {
            Some(cols) => cols
                .iter()
                .map(|c| c.as_str().unwrap_or_default().to_string())
                .collect(),
            None => d.columns.iter().map(|(id, _)| id.clone()).collect(),
        };
        let mut cols = Vec::new();
        for id in &wanted {
            let kind = d
                .columns
                .iter()
                .find(|(c, _)| c == id)
                .map(|(_, k)| *k)
                .ok_or_else(|| {
                    EngineError::not_found(
                        format!("Dataset {} has no column {id} at this stage.", d.id),
                        "Choose a listed column.",
                    )
                })?;
            let plan = d.spec["columns"]
                .as_array()
                .and_then(|a| a.iter().find(|c| c["id"] == id.as_str()))
                .cloned()
                .unwrap_or(Value::Null);
            cols.push((id.clone(), kind, plan));
        }
        let select: Vec<String> = cols.iter().map(|(id, _, _)| quote_ident(id)).collect();
        let sql = format!(
            "SELECT __rid, __loc{}{} FROM {} WHERE __rid >= ? AND __rid < ? ORDER BY __rid",
            if select.is_empty() { "" } else { ", " },
            select.join(", "),
            quote_ident(&d.view)
        );
        // Positions in the working view, as row-ID bounds, so the Parquet scan stays a range.
        let total = d.visible_rows();
        let end = (offset + limit).min(total);
        let (from, to) = if offset >= end {
            (0, 0)
        } else {
            (d.row_at(offset), d.row_at(end - 1) + 1)
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(duckdb::params![from as i64, to as i64])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let rid: i64 = row.get(0)?;
            let loc: i64 = row.get(1)?;
            let mut cells = Vec::new();
            for (j, (_, kind, _)) in cols.iter().enumerate() {
                cells.push(Self::cell(row, j + 2, *kind)?);
            }
            // The worst severity of the open row-scope issues that flag this cell (windows.ts).
            let r = rid as u64;
            let issue: Vec<Value> = cols
                .iter()
                .map(|(id, _, _)| {
                    d.issues
                        .iter()
                        .filter(|st| {
                            st.draft.scope == "rows"
                                && st.draft.columns.contains(id)
                                && st.current.contains(r)
                                && !st.accepted.contains(r)
                                && !d.excluded.contains(r)
                        })
                        .map(|st| st.draft.severity.as_str())
                        .max_by_key(|s| match *s {
                            "error" => 3,
                            "warning" => 2,
                            _ => 1,
                        })
                        .map_or(Value::Null, |s| json!(s))
                })
                .collect();
            out.push(json!({
                "rowId": rid,
                "locator": format!("line {loc}"),
                "cells": cells,
                "edited": cols.iter().map(|(id, _, _)| d.edits.contains_key(&(id.clone(), r))).collect::<Vec<_>>(),
                "issue": issue,
            }));
        }
        Ok(json!({
            "datasetId": d.id,
            "stage": stage,
            "offset": offset,
            "totalRows": total,
            "columns": cols.iter().map(|(id, _, plan)| json!({
                "id": id,
                "name": plan["name"],
                "unit": plan["unit"]["value"],
                "type": plan["type"]["value"],
                "assumed": assumed(plan),
                "derived": false,
            })).collect::<Vec<_>>(),
            "rows": out,
        }))
    }

    pub fn column_stats(&self, dataset: &Value, column: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        let id = column.as_str().unwrap_or("");
        let kind = d
            .columns
            .iter()
            .find(|(c, _)| c == id)
            .map(|(_, k)| *k)
            .ok_or_else(|| {
                EngineError::not_found(
                    format!("Dataset {} has no column {id} at this stage.", d.id),
                    "Choose a listed column.",
                )
            })?;
        let (v, view, exc) = (
            quote_ident(id),
            quote_ident(&d.view),
            quote_ident(&format!("{}{EXCEPTIONS_SUFFIX}", d.view)),
        );
        let numeric = matches!(kind, Kind::Integer | Kind::Number);
        let sql = format!(
            "SELECT count(*), count(*) FILTER (WHERE {v} IS NULL), \
             (SELECT count(*) FROM {exc} WHERE col = {col} AND raw IS NOT NULL), count(DISTINCT {v}), {mean} FROM {view}",
            col = quote_text(id),
            mean = if numeric {
                format!("avg({v})")
            } else {
                "NULL::DOUBLE".into()
            }
        );
        let (n, nulls, rejected, distinct, mean): (i64, i64, i64, i64, Option<f64>) =
            self.conn.query_row(&sql, [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
        let one = |sql: String| -> Result<Value> {
            let mut stmt = self.conn.prepare(&sql)?;
            let mut rows = stmt.query([])?;
            match rows.next()? {
                Some(row) => Self::cell(row, 0, kind),
                None => Ok(Value::Null),
            }
        };
        let min = one(format!("SELECT min({v}) FROM {view}"))?;
        let max = one(format!("SELECT max({v}) FROM {view}"))?;
        let mut top = Vec::new();
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {v}, count(*) AS n FROM {view} WHERE {v} IS NOT NULL GROUP BY {v} ORDER BY n DESC, {v} LIMIT 5"
        ))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            top.push(json!({ "value": Self::cell(row, 0, kind)?, "count": row.get::<_, i64>(1)? }));
        }
        Ok(json!({
            "columnId": id,
            "count": n,
            "nulls": nulls,
            "rawRejected": rejected,
            "distinct": distinct.min(DISTINCT_CAP),
            "distinctCapped": distinct > DISTINCT_CAP,
            "min": min,
            "max": max,
            "mean": mean,
            "topValues": top,
        }))
    }

    pub fn list_issues(&self, q: &Value) -> Result<Value> {
        let p = self.project()?;
        let offset = count(&q["offset"], "offset", 0, u64::MAX >> 11)? as usize;
        let limit = count(&q["limit"], "limit", 100, 1000)? as usize;
        if !q["datasetId"].is_null() {
            self.dataset(&q["datasetId"])?;
        }
        let mut list = Vec::new();
        for d in &p.datasets {
            if !q["datasetId"].is_null() && q["datasetId"] != d.id.as_str() {
                continue;
            }
            for st in &d.issues {
                let names = st
                    .draft
                    .columns
                    .iter()
                    .map(|id| {
                        d.spec["columns"]
                            .as_array()
                            .and_then(|cs| cs.iter().find(|c| c["id"] == id.as_str()))
                            .and_then(|c| c["name"].as_str())
                            .unwrap_or(id)
                            .to_string()
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                let listed = Listed {
                    issue: to_issue(st, &d.excluded),
                    names,
                };
                if matches(&listed, q) {
                    list.push(listed);
                }
            }
        }
        sort(&mut list, &q["sort"])?;
        let total = list.len();
        let items: Vec<Value> = list
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|l| l.issue)
            .collect();
        Ok(json!({ "items": items, "total": total, "offset": offset }))
    }

    pub fn list_occurrences(&self, issue_id: &Value, page: &Value) -> Result<Value> {
        let p = self.project()?;
        let offset = count(&page["offset"], "offset", 0, u64::MAX >> 11)?;
        let limit = count(&page["limit"], "limit", 100, 1000)?;
        let id = issue_id.as_str().unwrap_or("");
        let (d, st) = p
            .datasets
            .iter()
            .find_map(|d| d.issues.iter().find(|s| s.id == id).map(|s| (d, s)))
            .ok_or_else(|| {
                EngineError::not_found(
                    format!("There is no issue {id}."),
                    "Refresh the issues list and choose a listed issue.",
                )
            })?;
        let first = st.draft.columns.first();
        let column = first.and_then(|c| {
            let kind = d.columns.iter().find(|(id, _)| id == c)?.1;
            let plan = d.spec["columns"]
                .as_array()?
                .iter()
                .find(|p| p["id"] == c.as_str())?
                .clone();
            Some((c.clone(), kind, plan))
        });
        let rows: Vec<u64> = st
            .flagged
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();
        let mut items = Vec::new();
        if !rows.is_empty() {
            let list = rows
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            let (select, raw) = match &column {
                Some((c, _, _)) => (
                    format!(", v.{}", quote_ident(c)),
                    format!(
                        ", (SELECT coalesce(e.raw, e.marker) FROM {exc} e WHERE e.rid = v.__rid AND e.col = {col})",
                        exc = quote_ident(&d.all_exceptions_view()),
                        col = quote_text(c)
                    ),
                ),
                None => (String::new(), String::new()),
            };
            // Excluded rows are still occurrences, so they are read from the view of every row.
            let sql = format!(
                "SELECT v.__rid, v.__loc{select}{raw} FROM {view} v WHERE v.__rid IN ({list}) ORDER BY v.__rid",
                view = quote_ident(&d.all_view())
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let mut result = stmt.query([])?;
            while let Some(row) = result.next()? {
                let rid: i64 = row.get(0)?;
                let loc: i64 = row.get(1)?;
                let (value, raw, locator) = match &column {
                    Some((_, kind, plan)) => (
                        Self::cell(row, 2, *kind)?,
                        row.get::<_, Option<String>>(3)?
                            .map_or(Value::Null, Value::String),
                        format!(
                            "line {loc}, field {}",
                            plan["sourceIndex"].as_u64().unwrap_or(0) + 1
                        ),
                    ),
                    None => (Value::Null, Value::Null, format!("line {loc}")),
                };
                items.push(json!({
                    "issueId": id,
                    "rowId": rid,
                    "columnId": first,
                    "value": value,
                    "raw": raw,
                    "locator": locator,
                    "state": occurrence_state(st, &d.excluded, rid as u64),
                    "decidedBy": match occurrence_state(st, &d.excluded, rid as u64) {
                        "excluded" => json!(d.excluded_by(rid as u64)),
                        "accepted" => json!(st.decided_by.get(&(rid as u64))),
                        _ => Value::Null,
                    },
                }));
            }
        }
        Ok(json!({ "items": items, "total": st.flagged.count(), "offset": offset }))
    }

    /// The data health score (FR-VAL-05), as queries.ts datasetHealth.
    pub fn health(&self, dataset: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        let checked = d.checked();
        let rows = d.visible_rows();
        let counted: Vec<&IssueState> = d
            .issues
            .iter()
            .filter(|st| st.draft.severity != "note")
            .collect();
        let affected = |sts: &[&IssueState]| {
            sts.iter()
                .filter(|st| st.draft.scope == "rows")
                .fold(RowSet::new(d.row_count), |all, st| {
                    all.union(&open_rows(st, &d.excluded))
                })
                .count()
        };
        let open = |sts: &[&IssueState]| {
            sts.iter()
                .filter(|st| {
                    to_issue(st, &d.excluded)["counts"]["open"]
                        .as_u64()
                        .unwrap_or(0)
                        > 0
                })
                .count()
        };
        let score = |hit: u64| -> Value {
            if !checked {
                return Value::Null;
            }
            match (1000 * (rows - hit)).checked_div(rows) {
                Some(per_mille) => json!(per_mille as f64 / 10.0),
                None => json!(100),
            }
        };
        let all = affected(&counted);
        let categories: Vec<Value> = ["completeness", "uniqueness", "validity", "range", "units", "time", "spatial", "import"]
            .iter()
            .map(|cat| {
                let sts: Vec<&IssueState> = counted.iter().copied().filter(|st| st.draft.category == *cat).collect();
                let hit = affected(&sts);
                json!({ "category": cat, "score": score(hit), "affectedRows": hit, "openIssues": open(&sts) })
            })
            .collect();
        Ok(json!({
            "datasetId": d.id,
            "checked": checked,
            "rows": rows,
            "affectedRows": all,
            "score": score(all),
            "categories": categories,
        }))
    }

    pub fn list_export_profiles(&self, dataset: &Value) -> Result<Value> {
        self.dataset(dataset)?;
        Ok(json!(crate::export::profile_statuses()))
    }

    pub fn list_audit(&self, q: &Value) -> Result<Value> {
        let p = self.project()?;
        let offset = count(&q["offset"], "offset", 0, u64::MAX >> 11)? as usize;
        let limit = count(&q["limit"], "limit", 100, 1000)? as usize;
        let actions: Vec<&str> = q["action"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut matched: Vec<&Value> = p
            .log
            .entries()
            .iter()
            .filter(|e| actions.is_empty() || actions.contains(&e["action"].as_str().unwrap_or("")))
            .filter(|e| q["datasetId"].is_null() || e["target"]["datasetId"] == q["datasetId"])
            .filter(|e| q["rowId"].is_null() || e["target"]["rowId"] == q["rowId"])
            .filter(|e| q["columnId"].is_null() || e["target"]["columnId"] == q["columnId"])
            .filter(|e| {
                q["fromSeq"]
                    .as_u64()
                    .is_none_or(|s| e["seq"].as_u64().unwrap_or(0) >= s)
            })
            .collect();
        if q["order"] == "desc" {
            matched.reverse();
        }
        let total = matched.len();
        Ok(
            json!({ "items": matched.into_iter().skip(offset).take(limit).cloned().collect::<Vec<_>>(), "total": total, "offset": offset }),
        )
    }

    pub fn verify_audit(&self) -> Result<Value> {
        Ok(self.project()?.log.verify())
    }

    pub fn job_outcome(&self, id: &Value) -> Result<Value> {
        let id = id.as_str().unwrap_or("");
        self.jobs.get(id).cloned().ok_or_else(|| {
            EngineError::not_found(
                format!("There is no job {id}."),
                "Choose a job from the Jobs panel.",
            )
        })
    }

    pub fn cancel_job(&mut self, id: &Value) -> Result<Value> {
        let id = id.as_str().unwrap_or("");
        self.job_outcome(&json!(id))?;
        if self.jobs.get(id).map(|o| o["state"] == "running") == Some(true) {
            if let Some(flag) = self.cancels.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        Ok(Value::Null)
    }

    fn start_job(&mut self) -> (String, Arc<AtomicBool>) {
        let id = format!("j{}", self.next_job);
        self.next_job += 1;
        let flag = Arc::new(AtomicBool::new(false));
        self.jobs
            .insert(id.clone(), json!({ "state": "running", "progress": null }));
        self.cancels.insert(id.clone(), flag.clone());
        (id, flag)
    }
}

/// The DuckDB type a column of the working Parquet file has, which an edits table repeats.
fn sql_type(kind: Kind) -> &'static str {
    match kind {
        Kind::String => "VARCHAR",
        Kind::Integer | Kind::Number => "DOUBLE",
        Kind::Boolean => "BOOLEAN",
        Kind::Date => "INTEGER",
        Kind::DateTime => "BIGINT",
    }
}

/// A cell value as a literal of the column's stored type: days for a date, milliseconds for a
/// date and time. None when the value cannot be stored in the column.
fn sql_literal(v: &Value, kind: Kind) -> Option<String> {
    use crate::parse::{DateFormat, parse_date, parse_datetime};
    if v.is_null() {
        return Some("NULL".into());
    }
    Some(match kind {
        Kind::String => quote_text(v.as_str()?),
        Kind::Integer | Kind::Number => {
            let x = v.as_f64().filter(|x| x.is_finite())?;
            format!("CAST('{x:?}' AS DOUBLE)")
        }
        Kind::Boolean => if v.as_bool()? { "TRUE" } else { "FALSE" }.into(),
        Kind::Date => parse_date(v["date"].as_str()?, DateFormat::Iso)?.to_string(),
        Kind::DateTime => parse_datetime(v["datetime"].as_str()?, DateFormat::Iso)?.to_string(),
    })
}

/// (Re)creates a dataset's views over its working Parquet files. `<view>__all` has every row with
/// the cell edits applied, for looking rows up by ID; `<view>`, which the grid, the checks, the
/// exports and the digests read, leaves the excluded rows out. Its exceptions view also leaves out
/// edited cells, which keep no source text (checks.ts failedText); `<view>__all__exc` keeps every
/// row's source text, as an occurrence shows it.
fn install_views(conn: &Connection, d: &Dataset) -> Result<()> {
    let all = quote_ident(&d.all_view());
    let all_exc = quote_ident(&d.all_exceptions_view());
    let (view, exc) = (quote_ident(&d.view), quote_ident(&d.exceptions_view()));
    let excluded_name = format!("{}__excluded", d.view);
    let (excluded, edited) = (
        quote_ident(&excluded_name),
        quote_ident(&format!("{}__edited", d.view)),
    );
    let rows = format!(
        "read_parquet({})",
        quote_text(&d.rows_file.to_string_lossy())
    );
    conn.execute_batch(&format!(
        "CREATE OR REPLACE VIEW {all_exc} AS SELECT * FROM read_parquet({excf}); \
         CREATE OR REPLACE TABLE {excluded} (rid BIGINT); \
         CREATE OR REPLACE TABLE {edited} (rid BIGINT, col VARCHAR);",
        excf = quote_text(&d.exceptions_file.to_string_lossy()),
    ))?;
    if d.edits.is_empty() {
        conn.execute_batch(&format!(
            "CREATE OR REPLACE VIEW {all} AS SELECT * FROM {rows};"
        ))?;
    } else {
        let mut select = vec!["b.__rid".to_string(), "b.__loc".to_string()];
        let mut joins = String::new();
        for (i, (col, kind)) in d.columns.iter().enumerate() {
            let q = quote_ident(col);
            let edits: Vec<(u64, &Value)> = d
                .edits
                .range((col.clone(), 0)..=(col.clone(), u64::MAX))
                .map(|((_, r), (v, _))| (*r, v))
                .collect();
            if edits.is_empty() {
                select.push(format!("b.{q}"));
                continue;
            }
            let table = quote_ident(&format!("{}__e{i}", d.view));
            conn.execute_batch(&format!(
                "CREATE OR REPLACE TABLE {table} (rid BIGINT, v {});",
                sql_type(*kind)
            ))?;
            for chunk in edits.chunks(500) {
                let mut values = Vec::with_capacity(chunk.len());
                let mut keys = Vec::with_capacity(chunk.len());
                for (r, v) in chunk {
                    let lit = sql_literal(v, *kind).ok_or_else(|| {
                        EngineError::internal(format!(
                            "An edit of column {col} does not fit its type."
                        ))
                    })?;
                    values.push(format!("({r}, {lit})"));
                    keys.push(format!("({r}, {})", quote_text(col)));
                }
                conn.execute_batch(&format!(
                    "INSERT INTO {table} VALUES {}; INSERT INTO {edited} VALUES {};",
                    values.join(", "),
                    keys.join(", ")
                ))?;
            }
            joins.push_str(&format!(" LEFT JOIN {table} e{i} ON e{i}.rid = b.__rid"));
            select.push(format!(
                "CASE WHEN e{i}.rid IS NULL THEN b.{q} ELSE e{i}.v END AS {q}"
            ));
        }
        conn.execute_batch(&format!(
            "CREATE OR REPLACE VIEW {all} AS SELECT {} FROM {rows} b{joins};",
            select.join(", ")
        ))?;
    }
    if d.excluded.count() > 0 {
        let mut app = conn.appender(&excluded_name)?;
        for r in d.excluded.iter() {
            app.append_row(duckdb::params![r as i64])?;
        }
    }
    let mut keep_rows = Vec::new();
    let mut keep_exc = Vec::new();
    if d.excluded.count() > 0 {
        keep_rows.push(format!("__rid NOT IN (SELECT rid FROM {excluded})"));
        keep_exc.push(format!("e.rid NOT IN (SELECT rid FROM {excluded})"));
    }
    if !d.edits.is_empty() {
        keep_exc.push(format!(
            "NOT EXISTS (SELECT 1 FROM {edited} x WHERE x.rid = e.rid AND x.col = e.col)"
        ));
    }
    let filter = |conds: &[String]| {
        if conds.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conds.join(" AND "))
        }
    };
    conn.execute_batch(&format!(
        "CREATE OR REPLACE VIEW {view} AS SELECT * FROM {all}{}; \
         CREATE OR REPLACE VIEW {exc} AS SELECT e.* FROM {all_exc} e{};",
        filter(&keep_rows),
        filter(&keep_exc),
    ))?;
    Ok(())
}

/// Every check of the check packs over a dataset's working view, as a check run does.
fn check_drafts(
    conn: &Connection,
    d: &Dataset,
    project_area: Option<[f64; 4]>,
    cancel: &AtomicBool,
) -> Result<Vec<Draft>> {
    let ctx = CheckCtx {
        conn,
        view: quote_ident(&d.view),
        exceptions: quote_ident(&d.exceptions_view()),
        dataset_id: d.id.clone(),
        row_count: d.row_count,
        columns: d.check_columns(),
        crs: d.spec["crs"]["value"]["code"].as_str().map(String::from),
        notes: &d.notes,
        assumptions: &d.assumptions,
        project_area,
    };
    ctx.run(cancel, &mut |_, _| ())
}

/// Runs the checks again after a change recorded by entry `seq`, once a check run has been
/// recorded for the dataset (reducer.ts recheck).
fn recheck(
    conn: &Connection,
    d: &mut Dataset,
    project_area: Option<[f64; 4]>,
    seq: u64,
) -> Result<()> {
    if !d.checked() {
        return Ok(());
    }
    let drafts = check_drafts(conn, d, project_area, &AtomicBool::new(false))?;
    let n = d.row_count;
    merge_check_run(&mut d.issues, drafts, seq, n);
    Ok(())
}

fn dataset_mut<'a>(p: &'a mut Project, id: &str) -> Result<&'a mut Dataset> {
    p.datasets.iter_mut().find(|d| d.id == id).ok_or_else(|| {
        EngineError::not_found(
            format!("There is no dataset {id} in this project."),
            "Choose a listed dataset.",
        )
    })
}

/// Who wrote an entry, as an issue comment names them.
fn author(actor: &Value) -> String {
    if actor["kind"] == "user" {
        actor["name"].as_str().unwrap_or_default().to_string()
    } else {
        format!(
            "system ({})",
            actor["component"].as_str().unwrap_or_default()
        )
    }
}

/// Applies a decision entry to the project, as reducer.ts does: issue.accept, rows.exclude,
/// issue.comment, project.area and entry.revert. `reverted` is the entry an entry.revert names.
/// `skip(dataset, seq)` says where a saved issues cache stands in for the entry's effect on a
/// dataset's issues, which is then left out; its other effects always apply.
fn apply_decision(
    conn: &Connection,
    p: &mut Project,
    e: &Value,
    reverted: Option<&Value>,
    skip: &dyn Fn(&str, u64) -> bool,
) -> Result<()> {
    let seq = e["seq"].as_u64().unwrap_or(0);
    let id = e["target"]["datasetId"].as_str().unwrap_or("").to_string();
    let rows_of = |v: &Value| -> Vec<u64> {
        let mut rows: Vec<u64> = v
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default();
        rows.sort_unstable();
        rows
    };
    match e["action"].as_str().unwrap_or("") {
        "issue.accept" => {
            if skip(&id, seq) {
                return Ok(());
            }
            let d = dataset_mut(p, &id)?;
            let Some(st) = d
                .issues
                .iter_mut()
                .find(|s| e["target"]["issueId"] == s.id.as_str())
            else {
                return Ok(());
            };
            let all = e["payload"]["rows"] == "all";
            if all || st.draft.scope != "rows" {
                st.accepted_whole = true;
            }
            let rows: Vec<u64> = if all {
                st.current.iter().collect()
            } else {
                rows_of(&e["payload"]["rows"])
            };
            for r in rows {
                st.accepted.insert(r);
                st.decided_by.insert(r, seq);
            }
        }
        "rows.exclude" => {
            let area = area_of(&p.project_area);
            let d = dataset_mut(p, &id)?;
            let rows = rows_of(&e["payload"]["rows"]);
            for &r in &rows {
                d.excluded.insert(r);
            }
            d.exclusions.push((seq, rows));
            install_views(conn, d)?;
            if !skip(&id, seq) {
                recheck(conn, d, area, seq)?;
            }
        }
        "cell.edit" => {
            let area = area_of(&p.project_area);
            let d = dataset_mut(p, &id)?;
            let row = e["target"]["rowId"].as_u64().unwrap_or(0);
            let col = e["target"]["columnId"].as_str().unwrap_or("").to_string();
            d.edits.insert((col, row), (e["new"].clone(), seq));
            install_views(conn, d)?;
            if !skip(&id, seq) {
                recheck(conn, d, area, seq)?;
            }
        }
        "issue.comment" => {
            if skip(&id, seq) {
                return Ok(());
            }
            let d = dataset_mut(p, &id)?;
            if let Some(st) = d
                .issues
                .iter_mut()
                .find(|s| e["target"]["issueId"] == s.id.as_str())
            {
                st.comments.push(json!({ "seq": seq, "at": e["at"], "by": author(&e["actor"]), "text": e["new"] }));
            }
        }
        "project.area" => {
            p.project_area = e["new"].clone();
            let area = area_of(&p.project_area);
            for d in &mut p.datasets {
                if !skip(&d.id, seq) {
                    recheck(conn, d, area, seq)?;
                }
            }
        }
        "entry.revert" => {
            let Some(target) = reverted else {
                return Ok(());
            };
            let target_seq = target["seq"].as_u64().unwrap_or(0);
            p.reverted.insert(target_seq);
            let tid = target["target"]["datasetId"]
                .as_str()
                .unwrap_or("")
                .to_string();
            match target["action"].as_str().unwrap_or("") {
                "cell.edit" => {
                    let area = area_of(&p.project_area);
                    let d = dataset_mut(p, &tid)?;
                    let row = target["target"]["rowId"].as_u64().unwrap_or(0);
                    let col = target["target"]["columnId"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    if target["payload"]["previousEditSeq"].is_null() {
                        d.edits.remove(&(col, row));
                    } else {
                        d.edits.insert((col, row), (target["old"].clone(), seq));
                    }
                    install_views(conn, d)?;
                    if !skip(&tid, seq) {
                        recheck(conn, d, area, seq)?;
                    }
                }
                "issue.accept" => {
                    if skip(&tid, seq) {
                        return Ok(());
                    }
                    let d = dataset_mut(p, &tid)?;
                    if let Some(st) = d
                        .issues
                        .iter_mut()
                        .find(|s| target["target"]["issueId"] == s.id.as_str())
                    {
                        st.accepted_whole = false;
                        let undone: Vec<u64> = st
                            .decided_by
                            .iter()
                            .filter(|(_, by)| **by == target_seq)
                            .map(|(r, _)| *r)
                            .collect();
                        for r in undone {
                            st.decided_by.remove(&r);
                            st.accepted.remove(r);
                        }
                    }
                }
                "rows.exclude" => {
                    let area = area_of(&p.project_area);
                    let d = dataset_mut(p, &tid)?;
                    d.exclusions.retain(|(by, _)| *by != target_seq);
                    let mut excluded = RowSet::new(d.row_count);
                    for (_, rows) in &d.exclusions {
                        for &r in rows {
                            excluded.insert(r);
                        }
                    }
                    d.excluded = excluded;
                    install_views(conn, d)?;
                    if !skip(&tid, seq) {
                        recheck(conn, d, area, seq)?;
                    }
                }
                "project.area" => {
                    p.project_area = target["old"].clone();
                    let area = area_of(&p.project_area);
                    for d in &mut p.datasets {
                        if !skip(&d.id, seq) {
                            recheck(conn, d, area, seq)?;
                        }
                    }
                }
                other => {
                    return Err(EngineError::unsupported(format!(
                        "reverting {other} entries"
                    )));
                }
            }
        }
        other => {
            return Err(EngineError::unsupported(format!(
                "replaying {other} entries"
            )));
        }
    }
    Ok(())
}

const MIN_REASON_LENGTH: usize = 3;

/// The decision's reason, trimmed, or REASON_REQUIRED when it is shorter than the minimum
/// (requireReason). Length counts UTF-16 units without white space, as JavaScript does.
fn reason_of(v: &Value) -> Result<String> {
    let text = v
        .as_str()
        .unwrap_or("")
        .trim_matches(crate::units::is_js_space)
        .to_string();
    let length: usize = text
        .chars()
        .filter(|c| !crate::units::is_js_space(*c))
        .map(char::len_utf16)
        .sum();
    if length < MIN_REASON_LENGTH {
        return Err(EngineError::new(
            "REASON_REQUIRED",
            format!(
                "A reason of at least {MIN_REASON_LENGTH} characters is required; it is recorded in the audit log."
            ),
            "Say briefly why, for example \"Re-sent value; the field sheet confirms 1205.3\".",
        ));
    }
    Ok(text)
}

/// A number as JavaScript writes it in a message.
fn js_number(v: &Value) -> String {
    v.as_f64()
        .map_or_else(|| v.to_string(), crate::canonical::canonical_number)
}

/// The dataset and the issue with this ID (issueOf).
fn issue_of<'a>(p: &'a Project, id: &Value) -> Result<(&'a Dataset, &'a IssueState)> {
    let id = id.as_str().unwrap_or("");
    p.datasets
        .iter()
        .find_map(|d| d.issues.iter().find(|s| s.id == id).map(|s| (d, s)))
        .ok_or_else(|| {
            EngineError::not_found(
                format!("There is no issue {id}."),
                "Refresh the issues list and choose a listed issue.",
            )
        })
}

/// Requested rows, distinct and in ascending order, as `[...new Set(rows)].sort((a, b) => a - b)`.
fn distinct_rows(v: &Value) -> Vec<f64> {
    let mut rows: Vec<f64> = v
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    rows.sort_by(|a, b| a.total_cmp(b));
    rows.dedup();
    rows
}

fn row_id(r: f64, n: u64) -> Option<u64> {
    (r.fract() == 0.0 && r >= 0.0 && r < n as f64).then_some(r as u64)
}

const REVERTIBLE: [&str; 6] = [
    "cell.edit",
    "issue.accept",
    "rows.exclude",
    "step.apply",
    "detection.override",
    "project.area",
];

/// What a value of each type looks like, for the fix of a refused edit (decisions.ts EXAMPLES).
fn example(typ: &str) -> &'static str {
    match typ {
        "string" => "any text",
        "integer" => "a whole number such as 42",
        "number" => "a number such as 1205.3",
        "boolean" => "true or false",
        "date" => "a date such as 2026-01-31",
        "datetime" => "a date and time such as 2026-01-31T06:00:00Z",
        _ => "a GeoJSON geometry",
    }
}

/// A parsed cell as the protocol carries it.
fn cell_json(c: &crate::parse::Cell) -> Value {
    use crate::parse::Cell;
    match c {
        Cell::Null => Value::Null,
        Cell::Text(s) => json!(s),
        Cell::Number(x) => json!(x),
        Cell::Bool(b) => json!(b),
        Cell::Date(days) => json!({ "date": date_text(*days) }),
        Cell::DateTime(ms) => json!({ "datetime": iso_from_millis(*ms) }),
    }
}

/// An edit_cell decision as its cell.edit draft (editDraft): text is parsed with the column's
/// parser, a value is checked against the column's type.
fn edit_draft(conn: &Connection, p: &Project, d: &Value) -> Result<Map<String, Value>> {
    let reason = reason_of(&d["reason"])?;
    let id = d["datasetId"].as_str().unwrap_or("");
    let ds = p.datasets.iter().find(|x| x.id == id).ok_or_else(|| {
        EngineError::not_found(
            format!("There is no dataset {id} in this project."),
            "Choose a listed dataset.",
        )
    })?;
    let row = d["rowId"]
        .as_f64()
        .and_then(|r| row_id(r, ds.row_count))
        .ok_or_else(|| {
            EngineError::not_found(
                format!("Dataset {} has no row {}.", ds.id, js_number(&d["rowId"])),
                "Choose a row shown in the data grid.",
            )
        })?;
    let col = d["columnId"].as_str().unwrap_or("");
    let plan = ds.spec["columns"]
        .as_array()
        .and_then(|cs| cs.iter().find(|c| c["id"] == col))
        .ok_or_else(|| {
            EngineError::not_found(
                format!("Dataset {} has no column {col}.", ds.id),
                "Choose a listed column.",
            )
        })?;
    let kind = ds
        .columns
        .iter()
        .find(|(c, _)| c == col)
        .map(|(_, k)| *k)
        .ok_or_else(|| EngineError::internal(format!("Column {col} has no type.")))?;
    let typ = plan["type"]["value"].as_str().unwrap_or("string");
    let name = plan["name"].as_str().unwrap_or(col);
    let value = if let Some(text) = d["value"]["text"].as_str() {
        let csv = csv_plan(&ds.spec)?;
        let parser = &csv
            .columns
            .iter()
            .find(|c| c.id == col)
            .ok_or_else(|| EngineError::internal(format!("Column {col} has no parser.")))?
            .parser;
        match parser.parse(Some(text)) {
            crate::parse::Parsed::Value(cell, _) => cell_json(&cell),
            crate::parse::Parsed::Failed(_) => {
                return Err(EngineError::invalid(
                    format!("\"{text}\" is not a valid {typ} value for {name}."),
                    format!("Enter {}.", example(typ)),
                ));
            }
        }
    } else {
        let v = d["value"]["value"].clone();
        let fits = match kind {
            _ if v.is_null() => true,
            Kind::Integer => v
                .as_f64()
                .is_some_and(|x| x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0),
            _ => {
                sql_literal(&v, kind).is_some()
                    && match kind {
                        Kind::Date => v.as_object().is_some_and(|o| o.len() == 1),
                        Kind::DateTime => v.as_object().is_some_and(|o| o.len() == 1),
                        _ => true,
                    }
            }
        };
        if !fits {
            return Err(EngineError::invalid(
                format!("The value does not fit {name}, which holds {typ} values."),
                format!("Enter {}.", example(typ)),
            ));
        }
        v
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT __loc, {} FROM {} WHERE __rid = ?",
        quote_ident(col),
        quote_ident(&ds.all_view())
    ))?;
    let mut rows = stmt.query(duckdb::params![row as i64])?;
    let (loc, old) = match rows.next()? {
        Some(r) => (r.get::<_, i64>(0)?, Engine::cell(r, 1, kind)?),
        None => {
            return Err(EngineError::internal(format!(
                "Row {row} of dataset {} is missing.",
                ds.id
            )));
        }
    };
    let previous = ds.edits.get(&(col.to_string(), row)).map(|(_, by)| *by);
    let mut target = json!({
        "datasetId": ds.id,
        "rowId": row,
        "columnId": col,
        "locator": format!("line {loc}, field {}", plan["sourceIndex"].as_u64().unwrap_or(0) + 1),
    });
    if let Some(issue) = d.get("issueId").filter(|v| !v.is_null()) {
        target["issueId"] = issue.clone();
    }
    let mut e = draft("cell.edit", target);
    e.insert("old".into(), old);
    e.insert("new".into(), value);
    e.insert("reason".into(), json!(reason));
    e.insert("payload".into(), json!({ "previousEditSeq": previous }));
    Ok(e)
}

/// Validates a decision and turns it into its audit draft, as decisions.ts does. Edits and
/// detection overrides are refused until the native engine has steps and overrides.
fn decision_draft(conn: &Connection, p: &Project, d: &Value) -> Result<Map<String, Value>> {
    let kind = d["kind"].as_str().unwrap_or("");
    let entry = match kind {
        "edit_cell" => edit_draft(conn, p, d)?,
        "accept_issue" => {
            let reason = reason_of(&d["reason"])?;
            let (ds, st) = issue_of(p, &d["issueId"])?;
            let rows = if st.draft.scope != "rows" {
                if !st.present || st.accepted_whole {
                    return Err(EngineError::invalid(
                        "This issue is not open.",
                        "Choose an open issue.",
                    ));
                }
                json!("all")
            } else {
                let open = open_rows(st, &ds.excluded);
                let rows: Vec<f64> = if d["rows"] == "all" {
                    open.iter().map(|r| r as f64).collect()
                } else {
                    distinct_rows(&d["rows"])
                };
                let not_open: Vec<String> = rows
                    .iter()
                    .filter(|&&r| row_id(r, ds.row_count).is_none_or(|r| !open.contains(r)))
                    .map(|&r| js_number(&json!(r)))
                    .collect();
                if !not_open.is_empty() {
                    return Err(EngineError::invalid(
                        format!(
                            "Rows {} are not open in this issue.",
                            not_open[..not_open.len().min(5)].join(", ")
                        ),
                        "Choose rows the issue currently flags.",
                    ));
                }
                if rows.is_empty() {
                    return Err(EngineError::invalid(
                        "The issue has no open rows to accept.",
                        "Choose an issue with open rows.",
                    ));
                }
                json!(rows.iter().map(|&r| r as u64).collect::<Vec<_>>())
            };
            let mut e = draft(
                "issue.accept",
                json!({ "datasetId": ds.id, "issueId": st.id }),
            );
            e.insert("reason".into(), json!(reason));
            e.insert("payload".into(), json!({ "rows": rows }));
            e
        }
        "exclude_rows" => {
            let reason = reason_of(&d["reason"])?;
            let id = d["datasetId"].as_str().unwrap_or("");
            let ds = p.datasets.iter().find(|x| x.id == id).ok_or_else(|| {
                EngineError::not_found(
                    format!("There is no dataset {id} in this project."),
                    "Choose a listed dataset.",
                )
            })?;
            let rows: Vec<u64> = if d["rows"].is_array() {
                let rows = distinct_rows(&d["rows"]);
                if let Some(bad) = rows.iter().find(|&&r| row_id(r, ds.row_count).is_none()) {
                    return Err(EngineError::not_found(
                        format!("Dataset {} has no row {}.", ds.id, js_number(&json!(bad))),
                        "Choose rows shown in the data grid.",
                    ));
                }
                rows.iter().map(|&r| r as u64).collect()
            } else {
                let (owner, st) = issue_of(p, &d["rows"]["issueId"])?;
                if owner.id != ds.id {
                    return Err(EngineError::invalid(
                        "The issue belongs to another dataset.",
                        "Choose an issue of this dataset.",
                    ));
                }
                open_rows(st, &ds.excluded).iter().collect()
            };
            let rows: Vec<u64> = rows
                .into_iter()
                .filter(|&r| !ds.excluded.contains(r))
                .collect();
            if rows.is_empty() {
                return Err(EngineError::invalid(
                    "Every chosen row is already excluded.",
                    "Choose rows that are still included.",
                ));
            }
            let mut e = draft("rows.exclude", json!({ "datasetId": ds.id }));
            e.insert("reason".into(), json!(reason));
            e.insert(
                "payload".into(),
                json!({ "count": rows.len(), "rows": rows }),
            );
            e
        }
        "comment_issue" => {
            let (ds, st) = issue_of(p, &d["issueId"])?;
            let text = d["text"]
                .as_str()
                .unwrap_or("")
                .trim_matches(crate::units::is_js_space);
            if text.is_empty() {
                return Err(EngineError::invalid(
                    "The comment is empty.",
                    "Type a comment.",
                ));
            }
            let mut e = draft(
                "issue.comment",
                json!({ "datasetId": ds.id, "issueId": st.id }),
            );
            e.insert("new".into(), json!(text));
            e
        }
        "set_project_area" => {
            let reason = reason_of(&d["reason"])?;
            let b = &d["bbox"];
            if !b.is_null() {
                let valid = area_of(b).is_some_and(|[w, s, e, n]| {
                    [w, s, e, n].iter().all(|x| x.is_finite())
                        && w.abs() <= 180.0
                        && e.abs() <= 180.0
                        && s >= -90.0
                        && n <= 90.0
                        && s <= n
                });
                if !valid {
                    return Err(EngineError::invalid(
                        "The project area is not a valid longitude/latitude box.",
                        "Enter west, south, east and north in degrees (south ≤ north).",
                    ));
                }
            }
            let mut e = draft("project.area", json!({}));
            e.insert("old".into(), p.project_area.clone());
            e.insert("new".into(), b.clone());
            e.insert("reason".into(), json!(reason));
            e
        }
        "revert" => {
            let reason = reason_of(&d["reason"])?;
            let seq = d["seq"].as_u64();
            let target = p
                .log
                .entries()
                .iter()
                .find(|e| seq.is_some() && e["seq"].as_u64() == seq)
                .ok_or_else(|| {
                    EngineError::not_found(
                        format!("There is no audit entry {}.", js_number(&d["seq"])),
                        "Choose an entry from the log.",
                    )
                })?;
            let seq = seq.unwrap_or(0);
            let action = target["action"].as_str().unwrap_or("");
            if !REVERTIBLE.contains(&action) {
                return Err(EngineError::invalid(
                    format!("A {action} entry cannot be reverted."),
                    "Revert an edit, acceptance, exclusion, step, override or project-area change.",
                ));
            }
            if p.reverted.contains(&seq) {
                return Err(EngineError::invalid(
                    format!("Entry {seq} is already reverted."),
                    "Choose another entry.",
                ));
            }
            let dataset = &target["target"]["datasetId"];
            if action != "project.area" && !p.datasets.iter().any(|x| *dataset == x.id.as_str()) {
                return Err(EngineError::not_found(
                    format!("The dataset of entry {seq} is no longer in the project."),
                    "Choose another entry.",
                ));
            }
            if action == "cell.edit" {
                let key = (
                    target["target"]["columnId"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    target["target"]["rowId"].as_u64().unwrap_or(0),
                );
                let current = p
                    .datasets
                    .iter()
                    .find(|x| *dataset == x.id.as_str())
                    .and_then(|x| x.edits.get(&key))
                    .map(|(_, by)| *by);
                if current != Some(seq) {
                    return Err(EngineError::invalid(
                        format!(
                            "A later change (entry {}) replaced the value entry {seq} wrote.",
                            current.map_or("unknown".to_string(), |s| s.to_string())
                        ),
                        "Revert the later change first, or edit the cell again.",
                    ));
                }
            }
            let mut t = json!({ "seq": seq });
            if dataset.is_string() {
                t["datasetId"] = dataset.clone();
            }
            let mut e = draft("entry.revert", t);
            e.insert("reason".into(), json!(reason));
            e
        }
        "override_detection" => {
            return Err(EngineError::unsupported(format!("{kind} decisions")));
        }
        other => {
            return Err(EngineError::invalid(
                format!("There is no decision of kind {other}."),
                "Send one of the decisions the protocol lists.",
            ));
        }
    };
    Ok(entry)
}

/// Takes a decision (SAD section 8.1): validated, appended to the audit log, then applied by the
/// same reducer a replay uses. A change that alters what the checks see runs them again before
/// the answer, as the TypeScript engine does. Result: the audit entries written.
pub fn decide(shared: &Arc<Shared>, d: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let draft = decision_draft(&engine.conn, engine.writable()?, d)?;
    let entry = engine.append(draft, None)?;
    let reverted = engine
        .project()?
        .log
        .entries()
        .iter()
        .find(|e| entry["action"] == "entry.revert" && e["seq"] == entry["target"]["seq"])
        .cloned();
    let Engine { conn, project, .. } = &mut *engine;
    let p = project
        .as_mut()
        .ok_or_else(|| EngineError::internal("The project disappeared during the decision."))?;
    apply_decision(conn, p, &entry, reverted.as_ref(), &|_, _| false)?;
    drop(engine);
    crate::memory::release();
    let mut event = json!({ "type": "project.changed", "what": ["project", "datasets", "schema", "issues", "audit", "steps"] });
    if let Some(id) = entry["target"]["datasetId"].as_str() {
        event["datasetId"] = json!(id);
    }
    shared.event(event);
    Ok(json!([entry]))
}

/// Starts a check run over a dataset (SAD section 8.3): every rule of the check packs, as SQL.
pub fn run_checks(shared: &Arc<Shared>, dataset: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let project_id = engine.writable()?.id.clone();
    let d = engine.dataset(dataset)?;
    let dataset_id = d.id.clone();
    let view = quote_ident(&d.view);
    let exceptions = quote_ident(&d.exceptions_view());
    let row_count = d.row_count;
    let columns = d.check_columns();
    let crs = d.spec["crs"]["value"]["code"].as_str().map(String::from);
    let notes = d.notes.clone();
    let assumptions = d.assumptions.clone();
    let project_area = area_of(&engine.project()?.project_area);
    let conn = engine.conn.try_clone()?;
    let (job, cancel) = engine.start_job();
    let started = engine.clock.now_ms();
    drop(engine);

    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let progress_shared = shared.clone();
        let progress_job = job_id.clone();
        let mut last = Instant::now();
        let mut progress = move |done: usize, total: usize| {
            if last.elapsed().as_millis() < 100 && done < total {
                return;
            }
            last = Instant::now();
            let p =
                json!({ "phase": "Running checks", "done": done, "total": total, "unit": "items" });
            if let Ok(mut e) = progress_shared.engine.lock() {
                e.jobs.insert(
                    progress_job.clone(),
                    json!({ "state": "running", "progress": p }),
                );
            }
            progress_shared
                .event(json!({ "type": "job.progress", "jobId": progress_job, "progress": p }));
        };
        let ctx = CheckCtx {
            conn: &conn,
            view,
            exceptions,
            dataset_id: dataset_id.clone(),
            row_count,
            columns,
            crs,
            notes: &notes,
            assumptions: &assumptions,
            project_area,
        };
        let outcome = ctx.run(&cancel, &mut progress).and_then(|drafts| {
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            if engine.project.as_ref().map(|p| p.id.as_str()) != Some(project_id.as_str()) {
                return Err(EngineError::new(
                    "CANCELLED",
                    "The project was closed before the checks finished.",
                    "Run the checks again in the open project.",
                ));
            }
            let packs: Vec<Value> = check_packs().iter().map(|p| p.reference()).collect();
            let mut entry = draft("check.run", json!({ "datasetId": dataset_id }));
            entry.insert("payload".into(), json!({ "packs": packs }));
            let seq = engine.append(entry, None)?["seq"].as_u64().unwrap_or(0);
            let (by_severity, by_rule) = summarize(&drafts);
            let issues = drafts.len();
            let duration = (engine.clock.now_ms() - started).max(0);
            let ds = engine
                .project
                .as_mut()
                .and_then(|p| p.datasets.iter_mut().find(|d| d.id == dataset_id))
                .ok_or_else(|| {
                    EngineError::internal("The dataset disappeared during the checks.")
                })?;
            merge_check_run(&mut ds.issues, drafts, seq, row_count);
            ds.check_packs = packs.clone();
            Ok(json!({
                "datasetId": dataset_id,
                "packs": packs,
                "issues": issues,
                "bySeverity": by_severity,
                "byRule": by_rule,
                "durationMs": duration,
            }))
        });
        finish_job(
            &shared,
            &job_id,
            outcome,
            &["project", "issues", "audit"],
            &dataset_id,
        );
    });
    Ok(json!({ "jobId": job, "kind": "check" }))
}

/// Starts an export job (SAD section 10): the package is written, read back, assembled, re-opened
/// and verified before it is offered.
pub fn export_data(shared: &Arc<Shared>, req: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let project_id = engine.writable()?.id.clone();
    let profile = req["profile"].as_str().unwrap_or("").to_string();
    let statuses = crate::export::profile_statuses();
    let status = statuses
        .iter()
        .find(|s| s["profile"]["id"] == profile.as_str())
        .ok_or_else(|| {
            EngineError::invalid(
                format!("The export profile {} does not exist.", req["profile"]),
                "Choose Excel, CSV, Parquet or GeoJSON.",
            )
        })?;
    let d = engine.dataset(&req["datasetId"])?;
    if !crate::export::native_profile(&profile) {
        return Err(EngineError::new(
            "EXPORT_REFUSED",
            status["reason"]
                .as_str()
                .unwrap_or("This export is not available."),
            status["fix"]
                .as_str()
                .unwrap_or("Choose another export profile."),
        ));
    }
    let target = target_path(&req["target"])?;
    let columns = out_columns(d);
    let base_name = req["baseName"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or_else(|| d.name.clone(), String::from);
    let p = engine.project()?;
    let sources: Vec<Value> = p
        .originals
        .iter()
        .filter(|o| o["fileId"] == d.spec["fileId"])
        .cloned()
        .collect();
    let (seq, hash) = p.log.head();
    let mut input = crate::export::ExportInput {
        export_id: String::new(),
        base_name,
        profile: profile.clone(),
        at: String::new(),
        app_version: engine.version.clone(),
        owner: engine.owner.clone(),
        project: json!({ "id": p.id, "name": p.name }),
        dataset_id: d.id.clone(),
        dataset_name: d.name.clone(),
        view: quote_ident(&d.view),
        row_count: d.visible_rows(),
        excluded_rows: d.excluded.count(),
        columns,
        sources,
        rule_packs: d.check_packs.clone(),
        assumptions: d.assumptions.clone(),
        issues: d
            .issues
            .iter()
            .map(|st| to_issue(st, &d.excluded))
            .collect(),
        audit: p.log.entries().to_vec(),
        audit_head: json!({ "seq": seq, "hash": hash }),
        workdir: engine.workdir.join(&project_id),
        target,
        threads: engine.threads,
        ordered: !d.edits.is_empty(),
        neutralize: req["neutralizeFormulas"] == true,
    };
    // In the order the TypeScript engine draws them, so seeded runs give the same IDs and times.
    input.export_id = engine.ids.new_export_id();
    input.at = engine.clock.now_iso();
    let conn = engine.conn.try_clone()?;
    let (job, cancel) = engine.start_job();
    drop(engine);

    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let progress_shared = shared.clone();
        let progress_job = job_id.clone();
        let mut progress = move |phase: &str, done: u64| {
            let p = json!({ "phase": phase, "done": done, "total": 4, "unit": "items" });
            if let Ok(mut e) = progress_shared.engine.lock() {
                e.jobs.insert(
                    progress_job.clone(),
                    json!({ "state": "running", "progress": p }),
                );
            }
            progress_shared
                .event(json!({ "type": "job.progress", "jobId": progress_job, "progress": p }));
        };
        let outcome =
            crate::export::build_export(&conn, &input, &cancel, &mut progress).and_then(|out| {
                let mut engine = shared
                    .engine
                    .lock()
                    .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
                if let Some(record) = out.record {
                    if engine.project.as_ref().map(|p| p.id.as_str()) != Some(project_id.as_str()) {
                        return Err(EngineError::new(
                            "CANCELLED",
                            "The project was closed before the export finished.",
                            "Export again from the open project.",
                        ));
                    }
                    let mut entry =
                        draft("export.create", json!({ "datasetId": input.dataset_id }));
                    entry.insert(
                        "new".into(),
                        json!({ "packageName": out.result["packageName"] }),
                    );
                    entry.insert("payload".into(), json!({ "record": record }));
                    engine.append(entry, None)?;
                    if let Some(p) = engine.project.as_mut() {
                        p.exports.push(record);
                    }
                }
                if let Some(bytes) = out.bytes {
                    engine.job_bytes.insert(job_id.clone(), bytes);
                }
                Ok(out.result)
            });
        if outcome.is_err() {
            if let Some(t) = &input.target {
                let _ = std::fs::remove_file(t);
            }
        }
        finish_job(
            &shared,
            &job_id,
            outcome,
            &["project", "exports", "audit"],
            &input.dataset_id,
        );
    });
    Ok(json!({ "jobId": job, "kind": "export" }))
}

/// The rule packs the project's check runs used, in the order they were first used.
fn rule_packs_of(log: &AuditLog) -> Vec<Value> {
    let mut packs: Vec<Value> = Vec::new();
    for e in log.entries().iter().filter(|e| e["action"] == "check.run") {
        for r in e["payload"]["packs"].as_array().into_iter().flatten() {
            if !packs
                .iter()
                .any(|x| x["id"] == r["id"] && x["version"] == r["version"])
            {
                packs.push(r.clone());
            }
        }
    }
    packs
}

/// A reader's note as JSON, as the TypeScript IngestNote holds it.
fn note_json(n: &Note) -> Value {
    let mut v = json!({ "code": n.code, "message": n.message });
    if let Some(at) = n.src_loc {
        v["srcLoc"] = json!(at);
    }
    if !n.detail.is_null() {
        v["detail"] = n.detail.clone();
    }
    v
}

fn note_from_json(v: &Value) -> Note {
    Note {
        code: v["code"].as_str().unwrap_or_default().to_string(),
        message: v["message"].as_str().unwrap_or_default().to_string(),
        src_loc: v["srcLoc"].as_u64(),
        detail: v["detail"].clone(),
    }
}

/// A dataset's columns as the export and the digests read them.
fn out_columns(d: &Dataset) -> Vec<crate::export::OutColumn> {
    d.spec["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .zip(&d.columns)
        .map(|(c, (id, kind))| crate::export::OutColumn {
            id: id.clone(),
            name: c["name"].as_str().unwrap_or_default().to_string(),
            unit: c["unit"]["value"].as_str().map(String::from),
            typ: c["type"]["value"].as_str().unwrap_or_default().to_string(),
            kind: *kind,
        })
        .collect()
}

/// Packages up to this size are handed back with the job's result; larger ones stay on disk.
const RETURN_BYTES_MAX: u64 = 256 * 1024 * 1024;

/// Where a save or an export should be written: a path, or None to hand the bytes back.
fn target_path(target: &Value) -> Result<Option<PathBuf>> {
    match target {
        Value::Null => Ok(None),
        t if t["kind"] == "return-bytes" => Ok(None),
        t if t["kind"] == "path" && t["path"].as_str().is_some_and(|p| !p.is_empty()) => {
            Ok(Some(PathBuf::from(t["path"].as_str().unwrap_or_default())))
        }
        _ => Err(EngineError::invalid(
            "The save target is not valid.",
            "Pass { kind: 'return-bytes' } or a file path.",
        )),
    }
}

/// The last entry that may have changed the dataset's issues: one of its own entries, or a change
/// of the project area or the revert of one. An issues cache holds the issues as they stood after
/// it.
fn issues_after(log: &AuditLog, dataset_id: &str) -> Option<u64> {
    log.entries()
        .iter()
        .rev()
        .find(|e| {
            e["target"]["datasetId"] == dataset_id
                || e["action"] == "project.area"
                || (e["action"] == "entry.revert" && e["target"]["datasetId"].is_null())
        })
        .and_then(|e| e["seq"].as_u64())
}

struct SavedDataset {
    notes: Vec<Value>,
    id: String,
    name: String,
    rows: u64,
    /// Rows in the working view, which the digest covers.
    visible: u64,
    /// Whether the view joins cell edits, so reading it in row order needs ORDER BY.
    edited: bool,
    view: String,
    columns: Vec<crate::export::OutColumn>,
    rows_file: PathBuf,
    exceptions_file: PathBuf,
    source_seq: u64,
}

/**
 * Saves the project as a .twp file (SAD section 11, decision D-13): the dataset digests are
 * computed, every original is checked to still be the file that was imported, the save is
 * recorded, then the file is written with the originals, the audit log, the rule packs, the unit
 * registry and each dataset's working Parquet files. Result: SaveResult.
 */
pub fn save_project(shared: &Arc<Shared>, target: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let target = target_path(target)?;
    let p = engine.writable()?;
    let project_id = p.id.clone();
    let datasets: Vec<SavedDataset> = p
        .datasets
        .iter()
        .map(|d| SavedDataset {
            notes: d.notes.iter().map(note_json).collect(),
            id: d.id.clone(),
            name: d.name.clone(),
            rows: d.row_count,
            visible: d.visible_rows(),
            edited: !d.edits.is_empty(),
            view: quote_ident(&d.view),
            columns: out_columns(d),
            rows_file: d.rows_file.clone(),
            exceptions_file: d.exceptions_file.clone(),
            source_seq: d.source_seq,
        })
        .collect();
    let originals: Vec<(Value, crate::project::OriginalSource)> = p
        .originals
        .iter()
        .filter_map(|o| {
            let path = p.original_paths.get(o["fileId"].as_str()?)?;
            Some((o.clone(), path.clone()))
        })
        .collect();
    if originals.len() != p.originals.len() {
        return Err(EngineError::internal(
            "An original file of the project has no known location.",
        ));
    }
    let conn = engine.conn.try_clone()?;
    let threads = engine.threads;
    let workdir = engine.workdir.join(&project_id);
    let (job, cancel) = engine.start_job();
    drop(engine);

    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let progress_shared = shared.clone();
        let progress_job = job_id.clone();
        let mut last = Instant::now();
        let mut progress = move |phase: &str, done: u64| {
            if last.elapsed().as_millis() < 100 {
                return;
            }
            last = Instant::now();
            let p = json!({ "phase": phase, "done": done, "unit": "bytes" });
            if let Ok(mut e) = progress_shared.engine.lock() {
                e.jobs.insert(
                    progress_job.clone(),
                    json!({ "state": "running", "progress": p }),
                );
            }
            progress_shared
                .event(json!({ "type": "job.progress", "jobId": progress_job, "progress": p }));
        };
        let cancelled = || {
            EngineError::new(
                "CANCELLED",
                "The save was cancelled.",
                "Save again when you are ready.",
            )
        };
        let out = target
            .clone()
            .unwrap_or_else(|| workdir.join(format!("{job_id}.twp")));
        let outcome = (|| -> Result<Value> {
            let mut digests = Vec::new();
            for d in &datasets {
                progress("Computing the dataset digests", 0);
                let sha = crate::export::dataset_digest(
                    &conn, &d.view, d.edited, &d.columns, d.visible, threads,
                )?;
                digests.push(json!({ "id": d.id, "name": d.name, "rowCount": d.rows, "workingDigest": sha, "outputDigest": sha }));
                if cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
            }
            // Checked before the save is recorded, so a changed original leaves no save behind.
            for (info, source) in &originals {
                progress("Checking the original files", 0);
                let place = match source {
                    crate::project::OriginalSource::File(path) => path.display().to_string(),
                    crate::project::OriginalSource::Entry { archive, .. } => {
                        archive.display().to_string()
                    }
                };
                let sha = crate::project::hash_source(source).map_err(|_| {
                    EngineError::not_found(
                        format!("The original file {place} can no longer be read."),
                        "Put the original file back where it was imported from, then save again.",
                    )
                })?;
                if info["fileId"].as_str() != Some(sha.as_str()) {
                    return Err(EngineError::new(
                        "INVALID_INPUT",
                        format!(
                            "{place} has changed since it was imported, so it cannot be saved as the project's original."
                        ),
                        "Put the original file back as it was, or import the changed file as a new source.",
                    ));
                }
                if cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
            }
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            if engine.project.as_ref().map(|p| p.id.as_str()) != Some(project_id.as_str()) {
                return Err(EngineError::new(
                    "CANCELLED",
                    "The project was closed before it was saved.",
                    "Save the open project again.",
                ));
            }
            let file_name = crate::project::suggested_file_name(&engine.project()?.name);
            let mut entry = draft("project.save", json!({}));
            entry.insert("new".into(), json!({ "fileName": file_name }));
            entry.insert("payload".into(), json!({ "datasets": digests }));
            let saved = engine.append(entry, None)?;
            let saved_at = saved["at"].as_str().unwrap_or_default().to_string();
            let version = engine.version.clone();
            let p = engine
                .project
                .as_mut()
                .ok_or_else(|| EngineError::internal("The project disappeared during the save."))?;
            p.last_saved_at = Some(saved_at.clone());
            let (seq, hash) = p.log.head();
            let packs = rule_packs_of(&p.log);
            let mut rule_packs = Vec::new();
            for r in packs {
                let text =
                    crate::rules::pack_json(r["id"].as_str().unwrap_or("")).ok_or_else(|| {
                        EngineError::internal(format!("The rule pack {} is not built in.", r["id"]))
                    })?;
                rule_packs.push((r, text));
            }
            let mut manifest = Map::new();
            manifest.insert("appVersion".into(), json!(version));
            manifest.insert("projectId".into(), json!(p.id));
            manifest.insert("name".into(), json!(p.name));
            manifest.insert("createdAt".into(), json!(p.created_at));
            manifest.insert("savedAt".into(), json!(saved_at));
            manifest.insert("savedBy".into(), p.profile["name"].clone());
            manifest.insert("unitSystem".into(), json!(p.unit_system));
            manifest.insert("projectArea".into(), Value::Null);
            manifest.insert("datasets".into(), json!(digests));
            manifest.insert("auditHead".into(), json!({ "seq": seq, "hash": hash }));
            let registry: Value =
                serde_json::from_str(crate::units::REGISTRY_JSON).unwrap_or(Value::Null);
            let caches = datasets
                .iter()
                .flat_map(|d| {
                    [("rows", &d.rows_file), ("exceptions", &d.exceptions_file)].map(|(kind, file)| {
                        (json!({ "datasetId": d.id, "sourceSeq": d.source_seq, "kind": kind }), file.clone())
                    })
                })
                .collect();
            let mut cache_bytes: Vec<(Value, Vec<u8>)> = datasets
                .iter()
                .map(|d| {
                    let record =
                        json!({ "datasetId": d.id, "sourceSeq": d.source_seq, "kind": "notes" });
                    let text = format!("{}\n", crate::canonical::canonical_json(&json!(d.notes)));
                    (record, text.into_bytes())
                })
                .collect();
            // Each checked dataset's issues, so a reopen need not run its checks again.
            for d in p
                .datasets
                .iter()
                .filter(|d| d.checked() && datasets.iter().any(|s| s.id == d.id))
            {
                let Some(after) = issues_after(&p.log, &d.id) else {
                    continue;
                };
                let record = json!({ "datasetId": d.id, "sourceSeq": d.source_seq, "afterSeq": after, "kind": "issues" });
                let body = json!({
                    "rowCount": d.row_count,
                    "issues": d.issues.iter().map(crate::issues::to_cache).collect::<Vec<_>>(),
                });
                let text = format!("{}\n", crate::canonical::canonical_json(&body));
                cache_bytes.push((record, text.into_bytes()));
            }
            let input = crate::project::SaveInput {
                cache_bytes,
                manifest,
                audit_jsonl: p.log.to_jsonl(),
                originals: originals.clone(),
                caches,
                rule_packs,
                registry: (
                    registry["version"].as_str().unwrap_or("").to_string(),
                    crate::units::REGISTRY_JSON,
                ),
            };
            drop(engine);
            crate::project::write_twp(&out, input, &mut progress)?;
            let (sha256, size) = crate::project::hash_file(&out)?;
            let mut result = json!({ "fileName": file_name, "size": size, "sha256": sha256 });
            if target.is_none() {
                if size <= RETURN_BYTES_MAX {
                    let bytes = std::fs::read(&out)?;
                    let _ = std::fs::remove_file(&out);
                    if let Ok(mut e) = shared.engine.lock() {
                        e.job_bytes.insert(job_id.clone(), bytes);
                    }
                } else {
                    result["path"] = json!(out.to_string_lossy());
                }
            }
            Ok(result)
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_file(&out);
        }
        finish_job(&shared, &job_id, outcome, &["project", "audit"], "");
    });
    Ok(json!({ "jobId": job, "kind": "save" }))
}

/// Records a job's outcome and tells the client.
fn finish_job(
    shared: &Arc<Shared>,
    job_id: &str,
    outcome: Result<Value>,
    changed: &[&str],
    dataset_id: &str,
) {
    // A large job frees most of what it used; give it back before the next one starts.
    crate::memory::release();
    let Ok(mut engine) = shared.engine.lock() else {
        return;
    };
    match outcome {
        Ok(result) => {
            engine.jobs.insert(
                job_id.to_string(),
                json!({ "state": "done", "result": result }),
            );
            drop(engine);
            shared.event(json!({ "type": "job.done", "jobId": job_id }));
            let mut event = json!({ "type": "project.changed", "what": changed });
            if !dataset_id.is_empty() {
                event["datasetId"] = json!(dataset_id);
            }
            shared.event(event);
        }
        Err(e) if e.code == "CANCELLED" => {
            engine
                .jobs
                .insert(job_id.to_string(), json!({ "state": "cancelled" }));
            drop(engine);
            shared.event(json!({ "type": "job.cancelled", "jobId": job_id }));
        }
        Err(e) => {
            engine.jobs.insert(
                job_id.to_string(),
                json!({ "state": "failed", "error": e.to_json() }),
            );
            drop(engine);
            shared.event(json!({ "type": "job.failed", "jobId": job_id, "error": e.to_json() }));
        }
    }
}

/// The TW-IMP-004 note for an assumed encoding, restated from the spec as the TypeScript ingest
/// does, so an import replayed from a project raises it exactly as the first did.
fn assumed_encoding_note(spec: &Value) -> Option<Note> {
    let d = &spec["detections"]["encoding"];
    if d["assumed"].as_bool() != Some(true) {
        return None;
    }
    let value = match &d["value"] {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    Some(Note {
        code: "TW-IMP-004".into(),
        message: format!(
            "The text encoding {value} is assumed. {} If accented letters or symbols such as the degree sign look wrong, choose another encoding in the import settings.",
            d["evidence"].as_str().unwrap_or("")
        ),
        src_loc: None,
        detail: json!({ "encoding": d["value"], "confidence": d["confidence"], "method": d["method"] }),
    })
}

/// Where an import reads from: a path, or bytes the client sent, written to the work folder first.
fn input_path(engine: &Engine, msg: &Incoming, file: &Value) -> Result<(PathBuf, String)> {
    match file["kind"].as_str() {
        Some("path") => {
            let path = PathBuf::from(file["path"].as_str().unwrap_or_default());
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if !path.is_file() {
                return Err(EngineError::not_found(
                    format!("The file {} does not exist.", path.display()),
                    "Choose an existing file.",
                ));
            }
            Ok((path, name))
        }
        Some("bytes") => {
            let bytes = msg.bytes(&file["bytes"]).ok_or_else(|| {
                EngineError::invalid(
                    "The file bytes are missing.",
                    "Pass the file contents as bytes.",
                )
            })?;
            let name = file["name"].as_str().unwrap_or("upload").to_string();
            let dir = engine.workdir.join("uploads");
            std::fs::create_dir_all(&dir)?;
            let path = dir.join(sha256_hex(bytes));
            std::fs::write(&path, bytes)?;
            Ok((path, name))
        }
        _ => Err(EngineError::unsupported("files passed as browser Blobs")),
    }
}

/// Starts an import job: the plan is the preview the user reviewed (SAD decision D-12), executed here.
pub fn import_file(shared: &Arc<Shared>, msg: &Incoming, file: &Value, o: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let project_id = engine.writable()?.id.clone();
    let preview = &o["preview"];
    if preview.is_null() {
        return Err(EngineError::invalid(
            "The native engine imports the plan of a reviewed preview, and none was given.",
            "Preview the file first and pass the preview with the import.",
        ));
    }
    if !o["columnOverrides"].as_array().is_none_or(Vec::is_empty)
        || (!o["options"].is_null() && o["options"] != preview["sniff"]["options"])
    {
        return Err(EngineError::unsupported("changed import settings"));
    }
    let (path, name) = input_path(&engine, msg, file)?;
    let mut spec = json!({
        "fileName": name,
        "options": preview["sniff"]["options"],
        "columns": preview["columns"],
        "detections": preview["sniff"]["detections"],
        "crs": preview["crs"],
        "datasetName": o["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| dataset_name_for(&name)),
    });
    let plan: CsvPlan = csv_plan(&spec)?;
    // The preview lists its assumptions under the dataset id 'preview'; the commit renames them.
    let assumptions: Vec<Value> = preview["assumptions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let (job, cancel) = engine.start_job();
    let conn = engine.conn.try_clone()?;
    let workdir = engine.workdir.join(&project_id);
    let threads = engine.threads;
    let total = std::fs::metadata(&path)?.len();
    drop(engine);

    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let mut last = Instant::now();
        let progress_shared = shared.clone();
        let progress_job = job_id.clone();
        let mut progress = move |bytes: u64| {
            if last.elapsed().as_millis() < 100 {
                return;
            }
            last = Instant::now();
            let p = json!({ "phase": "Importing", "done": bytes.min(total), "total": total, "unit": "bytes" });
            if let Ok(mut e) = progress_shared.engine.lock() {
                e.jobs.insert(
                    progress_job.clone(),
                    json!({ "state": "running", "progress": p }),
                );
            }
            progress_shared
                .event(json!({ "type": "job.progress", "jobId": progress_job, "progress": p }));
        };
        let outcome = (|| -> Result<Value> {
            let imported = import_csv(
                &conn,
                &path,
                &plan,
                &job_id,
                &workdir,
                threads,
                &cancel,
                &mut progress,
            )?;
            spec["fileId"] = json!(imported.sha256);
            spec["size"] = json!(imported.size);
            if cancel.load(Ordering::Relaxed) {
                return Err(EngineError::new(
                    "CANCELLED",
                    "The import was cancelled.",
                    "Run it again when you are ready.",
                ));
            }
            commit_import(
                &shared,
                &project_id,
                spec.clone(),
                &plan,
                imported,
                &workdir,
                &job_id,
                assumptions,
                &path,
            )
        })();
        let mut engine = match shared.engine.lock() {
            Ok(e) => e,
            Err(_) => return,
        };
        match outcome {
            Ok(result) => {
                engine.jobs.insert(
                    job_id.clone(),
                    json!({ "state": "done", "result": result.clone() }),
                );
                drop(engine);
                shared.event(json!({ "type": "job.done", "jobId": job_id }));
                shared.event(json!({ "type": "project.changed", "what": ["project", "datasets", "schema", "audit"], "datasetId": result["id"] }));
            }
            Err(e) if e.code == "CANCELLED" => {
                engine
                    .jobs
                    .insert(job_id.clone(), json!({ "state": "cancelled" }));
                drop(engine);
                shared.event(json!({ "type": "job.cancelled", "jobId": job_id }));
            }
            Err(e) => {
                engine.jobs.insert(
                    job_id.clone(),
                    json!({ "state": "failed", "error": e.to_json() }),
                );
                drop(engine);
                shared
                    .event(json!({ "type": "job.failed", "jobId": job_id, "error": e.to_json() }));
            }
        }
    });
    Ok(json!({ "jobId": job, "kind": "import" }))
}

#[allow(clippy::too_many_arguments)]
fn commit_import(
    shared: &Arc<Shared>,
    project_id: &str,
    spec: Value,
    plan: &CsvPlan,
    imported: crate::import::Imported,
    workdir: &Path,
    job_id: &str,
    assumptions: Vec<Value>,
    original: &Path,
) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    if engine.project.as_ref().map(|p| p.id.as_str()) != Some(project_id) {
        return Err(EngineError::new(
            "CANCELLED",
            "The project was closed before the import finished.",
            "Import the file again into the open project.",
        ));
    }
    let dataset_id = format!("d{}", engine.project.as_ref().map_or(1, |p| p.next_dataset));
    let view = format!("{project_id}_{dataset_id}");
    let parquet = workdir.join(format!("{job_id}.parquet"));
    let exc = workdir.join(format!("{job_id}{EXCEPTIONS_SUFFIX}.parquet"));
    engine.conn.execute_batch(&format!(
        "DROP VIEW IF EXISTS {jobview}; DROP VIEW IF EXISTS {jobexc};",
        jobview = quote_ident(&imported.view),
        jobexc = quote_ident(&format!("{}{EXCEPTIONS_SUFFIX}", imported.view)),
    ))?;
    let file_id = spec["fileId"].clone();
    let media_type = if spec["options"]["format"] == "tsv" {
        "text/tab-separated-values"
    } else {
        "text/csv"
    };
    let mut add = draft(
        "source.add",
        json!({ "datasetId": dataset_id, "fileId": file_id }),
    );
    add.insert(
        "new".into(),
        json!({ "name": spec["datasetName"], "fileName": spec["fileName"] }),
    );
    add.insert(
        "payload".into(),
        json!({ "spec": spec, "mediaType": media_type }),
    );
    let entry = engine.append(add, None)?;
    let added_seq = entry["seq"].clone();
    let source_seq = entry["seq"].as_u64().unwrap_or(0);
    let assumptions: Vec<Value> = assumptions
        .into_iter()
        .map(|mut a| {
            a["datasetId"] = json!(dataset_id);
            a
        })
        .collect();
    if !assumptions.is_empty() {
        let mut assume = draft("detection.assume", json!({ "datasetId": dataset_id }));
        assume.insert("payload".into(), json!({ "assumptions": assumptions }));
        engine.append(
            assume,
            Some(json!({ "kind": "system", "component": "detector" })),
        )?;
    }
    let columns: Vec<(String, Kind)> = plan
        .columns
        .iter()
        .map(|c| (c.id.clone(), c.kind))
        .collect();
    let mut notes = imported.notes;
    if let Some(note) = assumed_encoding_note(&spec) {
        if !notes.iter().any(|n| n.code == "TW-IMP-004") {
            notes.insert(0, note);
        }
    }
    let dataset = Dataset {
        id: dataset_id,
        name: spec["datasetName"].as_str().unwrap_or_default().to_string(),
        spec: spec.clone(),
        view,
        row_count: imported.row_count,
        assumptions,
        columns,
        notes,
        issues: Vec::new(),
        check_packs: Vec::new(),
        rows_file: parquet,
        exceptions_file: exc,
        source_seq,
        excluded: RowSet::new(imported.row_count),
        exclusions: Vec::new(),
        edits: BTreeMap::new(),
    };
    install_views(&engine.conn, &dataset)?;
    let summary = Engine::dataset_summary(&dataset);
    let p = engine
        .project
        .as_mut()
        .ok_or_else(|| EngineError::internal("The project disappeared during the import."))?;
    if let Some(id) = file_id.as_str() {
        p.original_paths
            .entry(id.to_string())
            .or_insert_with(|| crate::project::OriginalSource::File(original.to_path_buf()));
    }
    if !p.originals.iter().any(|o| o["fileId"] == file_id) {
        p.originals.push(json!({ "fileId": file_id, "name": spec["fileName"], "size": spec["size"], "mediaType": media_type, "addedSeq": added_seq }));
    }
    p.next_dataset += 1;
    p.datasets.push(dataset);
    Ok(summary)
}

/// What a cache of the project file gives back for one dataset.
struct Restored {
    rows_file: PathBuf,
    exceptions_file: PathBuf,
    notes: Vec<Note>,
    row_count: u64,
}

/// Copies an entry of the project file to `dest`, streaming it.
fn extract(archive: &Path, e: &crate::zip::Entry, dest: &Path) -> Result<()> {
    let mut out = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(dest)?);
    crate::zip::read_entry(archive, e, &mut |b| {
        out.write_all(b)?;
        Ok(())
    })?;
    out.flush()?;
    Ok(())
}

/// The dataset's caches when all three are in the file, verified and tied to this source.add.
fn restore_cache(
    conn: &Connection,
    archive: &Path,
    read: &crate::project::TwpRead,
    manifest: &Value,
    dataset_id: &str,
    seq: u64,
    dir: &Path,
) -> Result<Option<Restored>> {
    let entry = |kind: &str| -> Option<crate::zip::Entry> {
        let path = manifest["caches"].as_array()?.iter().find(|c| {
            c["datasetId"] == dataset_id
                && c["sourceSeq"].as_u64() == Some(seq)
                && c["kind"] == kind
        })?["path"]
            .as_str()?
            .to_string();
        if !read.verified.contains(&path) {
            return None;
        }
        read.entries.iter().find(|e| e.name == path).cloned()
    };
    let (Some(rows), Some(exc), Some(notes)) = (entry("rows"), entry("exceptions"), entry("notes"))
    else {
        return Ok(None);
    };
    let rows_file = dir.join(format!("{dataset_id}.parquet"));
    let exceptions_file = dir.join(format!("{dataset_id}{EXCEPTIONS_SUFFIX}.parquet"));
    extract(archive, &rows, &rows_file)?;
    extract(archive, &exc, &exceptions_file)?;
    let notes: Value = serde_json::from_slice(&crate::project::entry_bytes(archive, &notes)?)
        .map_err(|_| {
            EngineError::internal("The notes of a dataset in the project file are not JSON.")
        })?;
    let row_count: i64 = conn.query_row(
        &format!(
            "SELECT count(*) FROM read_parquet({})",
            quote_text(&rows_file.to_string_lossy())
        ),
        [],
        |r| r.get(0),
    )?;
    Ok(Some(Restored {
        rows_file,
        exceptions_file,
        notes: notes
            .as_array()
            .into_iter()
            .flatten()
            .map(note_from_json)
            .collect(),
        row_count: row_count.max(0) as u64,
    }))
}

struct Reopen<'a> {
    conn: &'a Connection,
    archive: &'a Path,
    workdir: &'a Path,
    threads: usize,
    cancel: &'a AtomicBool,
    /// The seq of every entry in the log.
    seqs: HashSet<u64>,
    /// Per dataset with a usable issues cache: the entry after which its issues are as the cache
    /// holds them, and the issues until they are installed there.
    issue_caches: HashMap<String, (u64, Option<Vec<IssueState>>)>,
}

/// How a check.run entry was replayed.
enum CheckReplay {
    /// The checks ran again.
    Ran,
    /// A saved issues cache stands in for it.
    Superseded,
}

impl Reopen<'_> {
    /// Rebuilds a dataset from its source.add entry: from its caches, or by importing its original
    /// again under the recorded plan. Returns the dataset and whether a cache was used.
    fn source_add(
        &self,
        p: &mut Project,
        read: &crate::project::TwpRead,
        manifest: &Value,
        e: &Value,
        progress: &mut dyn FnMut(&str, u64),
    ) -> Result<bool> {
        let dataset_id = e["target"]["datasetId"].as_str().unwrap_or("").to_string();
        let seq = e["seq"].as_u64().unwrap_or(0);
        let spec = e["payload"]["spec"].clone();
        let plan = csv_plan(&spec)?;
        let file_id = spec["fileId"].as_str().unwrap_or("").to_string();
        let original = manifest["originals"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|o| o["fileId"] == file_id.as_str())
            .and_then(|o| {
                read.entries
                    .iter()
                    .find(|x| Some(x.name.as_str()) == o["path"].as_str())
            })
            .cloned()
            .ok_or_else(|| {
                EngineError::new(
                    "PROJECT_INVALID",
                    format!("The original file {} is missing.", spec["fileName"]),
                    "Open the project from a complete .twp file.",
                )
            })?;
        let dir = self.workdir.join(&p.id);
        std::fs::create_dir_all(&dir)?;
        let cached = restore_cache(
            self.conn,
            self.archive,
            read,
            manifest,
            &dataset_id,
            seq,
            &dir,
        )?;
        let used_cache = cached.is_some();
        let source = if original.method == 0 {
            crate::project::OriginalSource::Entry {
                archive: self.archive.to_path_buf(),
                offset: original.data_offset,
                size: original.size,
            }
        } else {
            let uploads = self.workdir.join("uploads");
            std::fs::create_dir_all(&uploads)?;
            let path = uploads.join(&file_id);
            extract(self.archive, &original, &path)?;
            crate::project::OriginalSource::File(path)
        };
        let restored = match cached {
            Some(r) => r,
            None => {
                // Imported again from the original under the plan the log recorded.
                let path = match &source {
                    crate::project::OriginalSource::File(path) => path.clone(),
                    crate::project::OriginalSource::Entry { .. } => {
                        let uploads = self.workdir.join("uploads");
                        std::fs::create_dir_all(&uploads)?;
                        let path = uploads.join(&file_id);
                        extract(self.archive, &original, &path)?;
                        path
                    }
                };
                let job = format!("open_{dataset_id}");
                let imported = import_csv(
                    self.conn,
                    &path,
                    &plan,
                    &job,
                    &dir,
                    self.threads,
                    self.cancel,
                    &mut |n| progress("Importing the original files again", n),
                )?;
                self.conn.execute_batch(&format!(
                    "DROP VIEW IF EXISTS {}; DROP VIEW IF EXISTS {};",
                    quote_ident(&imported.view),
                    quote_ident(&format!("{}{EXCEPTIONS_SUFFIX}", imported.view)),
                ))?;
                let mut notes = imported.notes;
                if let Some(note) = assumed_encoding_note(&spec) {
                    if !notes.iter().any(|n| n.code == "TW-IMP-004") {
                        notes.insert(0, note);
                    }
                }
                Restored {
                    rows_file: dir.join(format!("{job}.parquet")),
                    exceptions_file: dir.join(format!("{job}{EXCEPTIONS_SUFFIX}.parquet")),
                    notes,
                    row_count: imported.row_count,
                }
            }
        };
        let view = format!("{}_{dataset_id}", p.id);
        let media_type = e["payload"]["mediaType"].clone();
        if !p.originals.iter().any(|o| o["fileId"] == file_id.as_str()) {
            p.originals.push(json!({ "fileId": file_id, "name": spec["fileName"], "size": spec["size"], "mediaType": media_type, "addedSeq": seq }));
        }
        p.original_paths.entry(file_id).or_insert(source);
        let n: u64 = dataset_id.trim_start_matches('d').parse().unwrap_or(0);
        p.next_dataset = p.next_dataset.max(n + 1);
        p.datasets.push(Dataset {
            id: dataset_id,
            name: spec["datasetName"].as_str().unwrap_or_default().to_string(),
            columns: plan
                .columns
                .iter()
                .map(|c| (c.id.clone(), c.kind))
                .collect(),
            spec,
            view,
            row_count: restored.row_count,
            assumptions: Vec::new(),
            notes: restored.notes,
            issues: Vec::new(),
            check_packs: Vec::new(),
            rows_file: restored.rows_file,
            exceptions_file: restored.exceptions_file,
            source_seq: seq,
            excluded: RowSet::new(restored.row_count),
            exclusions: Vec::new(),
            edits: BTreeMap::new(),
        });
        if let Some(d) = p.datasets.last() {
            install_views(self.conn, d)?;
        }
        Ok(used_cache)
    }

    /// The dataset's issues cache, when it is present, verified, tied to this import of the
    /// dataset and to one of its recorded check runs, and reads back whole.
    fn load_issues(
        &self,
        read: &crate::project::TwpRead,
        manifest: &Value,
        d: &Dataset,
    ) -> Option<(u64, Vec<IssueState>)> {
        let cache = manifest["caches"].as_array()?.iter().find(|c| {
            c["datasetId"] == d.id.as_str()
                && c["kind"] == "issues"
                && c["sourceSeq"].as_u64() == Some(d.source_seq)
        })?;
        let after = cache["afterSeq"].as_u64()?;
        let path = cache["path"].as_str()?;
        if !self.seqs.contains(&after) || after < d.source_seq || !read.verified.contains(path) {
            return None;
        }
        let entry = read.entries.iter().find(|x| x.name == path)?;
        let bytes = crate::project::entry_bytes(self.archive, entry).ok()?;
        let body: Value = serde_json::from_slice(&bytes).ok()?;
        if body["rowCount"].as_u64() != Some(d.row_count) {
            return None;
        }
        let issues = body["issues"]
            .as_array()?
            .iter()
            .map(|v| crate::issues::from_cache(v, d.row_count))
            .collect::<Option<Vec<_>>>()?;
        if issues.iter().any(|i| i.draft.dataset_id != d.id) {
            return None;
        }
        Some((after, issues))
    }

    /// Whether the dataset's issues cache stands in for entry `seq`'s effect on its issues.
    fn cached(&self, dataset_id: &str, seq: u64) -> bool {
        self.issue_caches
            .get(dataset_id)
            .is_some_and(|(after, _)| seq <= *after)
    }

    /// Replays a check.run entry with the rule packs it names: the checks run again, unless the
    /// dataset's issues cache stands in for it.
    fn check_run(
        &self,
        p: &mut Project,
        e: &Value,
        progress: &mut dyn FnMut(&str, u64),
    ) -> Result<CheckReplay> {
        let packs: Vec<Value> = check_packs().iter().map(|p| p.reference()).collect();
        if e["payload"]["packs"].as_array() != Some(&packs) {
            return Err(EngineError::unsupported(
                "check runs with rule packs other than the built-in ones",
            ));
        }
        let seq = e["seq"].as_u64().unwrap_or(0);
        let id = e["target"]["datasetId"].as_str().unwrap_or("");
        let area = area_of(&p.project_area);
        let d = p.datasets.iter_mut().find(|d| d.id == id).ok_or_else(|| {
            EngineError::internal(format!("The log checks dataset {id} before importing it."))
        })?;
        d.check_packs = packs;
        if self.cached(id, seq) {
            return Ok(CheckReplay::Superseded);
        }
        progress("Running the recorded checks", 0);
        let drafts = check_drafts(self.conn, d, area, self.cancel)?;
        let rows = d.row_count;
        merge_check_run(&mut d.issues, drafts, seq, rows);
        Ok(CheckReplay::Ran)
    }
}

/**
 * Opens a .twp project file (SAD section 11, decision D-13): every integrity check the TypeScript
 * reader makes, then a replay of the audit log, with each dataset restored from its caches when
 * they are present and verified, and imported again from its original otherwise. The datasets'
 * digests are then compared with the manifest's. Any failure opens the project read-only.
 * Result: ProjectOpenReport.
 */
pub fn open_project(shared: &Arc<Shared>, msg: &Incoming, file: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let (archive, name) = input_path(&engine, msg, file)?;
    let conn = engine.conn.try_clone()?;
    let workdir = engine.workdir.clone();
    let threads = engine.threads;
    let (job, cancel) = engine.start_job();
    drop(engine);

    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let progress_shared = shared.clone();
        let progress_job = job_id.clone();
        let mut last = Instant::now();
        let mut progress = move |phase: &str, done: u64| {
            if last.elapsed().as_millis() < 100 {
                return;
            }
            last = Instant::now();
            let p = json!({ "phase": phase, "done": done, "unit": "bytes" });
            if let Ok(mut e) = progress_shared.engine.lock() {
                e.jobs.insert(
                    progress_job.clone(),
                    json!({ "state": "running", "progress": p }),
                );
            }
            progress_shared
                .event(json!({ "type": "job.progress", "jobId": progress_job, "progress": p }));
        };
        let outcome = (|| -> Result<Value> {
            let read = crate::project::read_twp(&archive, &mut progress);
            let mut checks = read.checks.clone();
            let manifest = read.manifest.clone().unwrap_or(Value::Null);
            let project_id = manifest["projectId"]
                .as_str()
                .unwrap_or("p_0000000000000000")
                .to_string();
            let text = read.audit_jsonl.clone();
            let (log, bad_line) = AuditLog::from_jsonl(&project_id, text.as_deref().unwrap_or(""));
            let chain = log.verify();
            let (seq, hash) = log.head();
            let fail = |id: &str, detail: String, rule: &str| {
                crate::project::integrity(id, false, detail, Some(rule), None)
            };
            checks.push(if text.is_none() {
                fail("audit-chain", "The audit chain cannot be verified because audit.jsonl is missing.".into(), "TW-PRJ-002")
            } else if let Some((line, why)) = &bad_line {
                fail("audit-chain", format!("audit.jsonl line {line} cannot be read: {why}."), "TW-PRJ-002")
            } else if chain["ok"] != true {
                fail("audit-chain", format!("The audit chain is broken at entry {}: {}.", chain["brokenAt"], chain["reason"].as_str().unwrap_or("an entry does not verify")), "TW-PRJ-002")
            } else if manifest["auditHead"]["seq"].as_u64() != Some(seq) || manifest["auditHead"]["hash"].as_str() != Some(hash.as_str()) {
                fail("audit-chain", format!("The audit log ends at entry {seq}, but the manifest says it ends at entry {} with another hash.", manifest["auditHead"]["seq"]), "TW-PRJ-002")
            } else {
                crate::project::integrity("audit-chain", true, format!("All {} audit entries verify, each linked to the one before.", log.entries().len()), None, None)
            });

            let mut p = Project {
                id: project_id.clone(),
                name: manifest["name"]
                    .as_str()
                    .map_or_else(|| name.trim_end_matches(".twp").to_string(), String::from),
                created_at: manifest["createdAt"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                profile: Value::Null,
                unit_system: manifest["unitSystem"].as_str().unwrap_or("SI").to_string(),
                log: AuditLog::new(&project_id),
                datasets: Vec::new(),
                originals: Vec::new(),
                next_dataset: 1,
                exports: Vec::new(),
                original_paths: HashMap::new(),
                last_saved_at: None,
                read_only: false,
                project_area: Value::Null,
                reverted: HashSet::new(),
            };
            let mut reopen = Reopen {
                conn: &conn,
                archive: &archive,
                workdir: &workdir,
                threads,
                cancel: &cancel,
                seqs: log
                    .entries()
                    .iter()
                    .filter_map(|e| e["seq"].as_u64())
                    .collect(),
                issue_caches: HashMap::new(),
            };
            let mut stopped: Option<String> = None;
            let mut from_cache = 0;
            let (mut checks_restored, mut checks_ran) = (0, 0);
            if read.manifest.is_none() || text.is_none() {
                stopped = Some("the manifest or the audit log could not be read".into());
            } else {
                for e in log.entries() {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(EngineError::new(
                            "CANCELLED",
                            "Opening the project was cancelled.",
                            "Open it again when you are ready.",
                        ));
                    }
                    let at = e["seq"].clone();
                    let step = match e["action"].as_str().unwrap_or("") {
                        "project.create" => {
                            p.name = e["new"]["name"].as_str().unwrap_or(&p.name).to_string();
                            p.unit_system =
                                e["new"]["unitSystem"].as_str().unwrap_or("SI").to_string();
                            p.created_at = e["at"].as_str().unwrap_or_default().to_string();
                            p.profile = e["payload"]["profile"].clone();
                            Ok(())
                        }
                        "source.add" => {
                            progress("Restoring the datasets", 0);
                            reopen
                                .source_add(&mut p, &read, &manifest, e, &mut progress)
                                .map(|cached| {
                                    if cached {
                                        from_cache += 1;
                                    }
                                    if let Some(d) = p.datasets.last() {
                                        progress("Restoring the saved check results", 0);
                                        if let Some((after, issues)) =
                                            reopen.load_issues(&read, &manifest, d)
                                        {
                                            reopen
                                                .issue_caches
                                                .insert(d.id.clone(), (after, Some(issues)));
                                        }
                                    }
                                })
                        }
                        "detection.assume" => {
                            let id = e["target"]["datasetId"].as_str().unwrap_or("");
                            if let Some(d) = p.datasets.iter_mut().find(|d| d.id == id) {
                                d.assumptions = e["payload"]["assumptions"]
                                    .as_array()
                                    .cloned()
                                    .unwrap_or_default();
                            }
                            Ok(())
                        }
                        "check.run" => {
                            reopen
                                .check_run(&mut p, e, &mut progress)
                                .map(|how| match how {
                                    CheckReplay::Ran => checks_ran += 1,
                                    CheckReplay::Superseded => {}
                                })
                        }
                        "cell.edit" | "issue.accept" | "rows.exclude" | "issue.comment"
                        | "project.area" | "entry.revert" => {
                            let reverted = log.entries().iter().find(|x| {
                                e["action"] == "entry.revert" && x["seq"] == e["target"]["seq"]
                            });
                            apply_decision(&conn, &mut p, e, reverted, &|id, seq| {
                                reopen.cached(id, seq)
                            })
                        }
                        "export.create" => {
                            p.exports.push(e["payload"]["record"].clone());
                            Ok(())
                        }
                        "project.save" => {
                            p.last_saved_at = e["at"].as_str().map(String::from);
                            Ok(())
                        }
                        other => Err(EngineError::unsupported(format!(
                            "replaying {other} entries"
                        ))),
                    };
                    if let Err(err) = step {
                        stopped = Some(format!("entry {at}: {}", err.message));
                        break;
                    }
                    // Issues caches that hold the issues as this entry left them.
                    let seq = e["seq"].as_u64().unwrap_or(0);
                    for (id, (after, issues)) in reopen.issue_caches.iter_mut() {
                        if *after != seq {
                            continue;
                        }
                        if let (Some(issues), Some(d)) =
                            (issues.take(), p.datasets.iter_mut().find(|d| d.id == *id))
                        {
                            d.issues = issues;
                            checks_restored += 1;
                        }
                    }
                }
            }
            checks.push(match &stopped {
                Some(why) => fail("replay-digest", format!("Rebuilding the project stopped at {why}"), "TW-PRJ-003"),
                None => {
                    let mut bad = Vec::new();
                    let saved: Vec<Value> = manifest["datasets"].as_array().cloned().unwrap_or_default();
                    for d in &p.datasets {
                        progress("Comparing the dataset digests", 0);
                        let sha = crate::export::dataset_digest(&conn, &quote_ident(&d.view), !d.edits.is_empty(), &out_columns(d), d.visible_rows(), threads)?;
                        match saved.iter().find(|s| s["id"] == d.id.as_str()) {
                            None => bad.push(format!("the audit log builds dataset {}, which the manifest does not list", d.id)),
                            Some(s) if s["rowCount"].as_u64() != Some(d.row_count) => bad.push(format!("dataset {} has {} rows instead of the {} saved", d.id, d.row_count, s["rowCount"])),
                            Some(s) if s["workingDigest"].as_str() != Some(sha.as_str()) || s["outputDigest"].as_str() != Some(sha.as_str()) => {
                                bad.push(format!("dataset {} ({}) differs from its saved digest", d.id, d.name))
                            }
                            Some(_) => {}
                        }
                    }
                    for s in &saved {
                        if !p.datasets.iter().any(|d| s["id"] == d.id.as_str()) {
                            bad.push(format!("dataset {} is not rebuilt by the audit log", s["id"]));
                        }
                    }
                    if bad.is_empty() {
                        let n = p.datasets.len();
                        let how = if from_cache == n {
                            "restored from their saved working data".to_string()
                        } else if from_cache == 0 {
                            "rebuilt from the originals and the audit log".to_string()
                        } else {
                            format!("rebuilt ({from_cache} from their saved working data, {} from the originals)", n - from_cache)
                        };
                        let issues = match (checks_restored, checks_ran) {
                            (0, 0) => String::new(),
                            (_, 0) => " Their issues were restored from the saved check results.".to_string(),
                            (0, 1) => " The recorded check run ran again.".to_string(),
                            (0, r) => format!(" The {r} recorded check runs ran again."),
                            (k, r) => format!(" The issues of {k} datasets were restored from the saved check results, and {r} recorded check runs ran again."),
                        };
                        crate::project::integrity("replay-digest", true, format!("All {n} datasets were {how} and match their saved digests.{issues}"), None, None)
                    } else {
                        fail("replay-digest", format!("Rebuilding the project gives {}.", bad.join("; ")), "TW-PRJ-003")
                    }
                }
            });
            let read_only = checks.iter().any(|c| c["ok"] == false);
            p.read_only = read_only;
            p.log = log;
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            engine.project = Some(p);
            let summary = engine.summary()?;
            Ok(json!({ "project": summary, "readOnly": read_only, "checks": checks }))
        })();
        finish_job(
            &shared,
            &job_id,
            outcome,
            &[
                "project", "datasets", "schema", "issues", "audit", "steps", "exports",
            ],
            "",
        );
    });
    Ok(json!({ "jobId": job, "kind": "open" }))
}
