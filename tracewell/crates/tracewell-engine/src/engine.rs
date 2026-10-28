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
    IssueState, Listed, matches, merge_check_run, occurrence_state, sort, to_issue,
};
use crate::parse::Kind;
use crate::rules::check_packs;
use crate::time::{Clock, IdSource, date_text, iso_from_millis};
use duckdb::Connection;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const ENGINE_NAME: &str = "tracewell-native";
pub const PROTOCOL_VERSION: &str = "0.2.0";
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
}

impl Dataset {
    fn exceptions_view(&self) -> String {
        format!("{}{EXCEPTIONS_SUFFIX}", self.view)
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
    pub project: Option<Project>,
    jobs: HashMap<String, Value>,
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
    ) -> Self {
        Engine {
            conn,
            workdir,
            clock,
            ids,
            version: env!("CARGO_PKG_VERSION").into(),
            memory_limit,
            threads,
            project: None,
            jobs: HashMap::new(),
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
                "exportProfiles": [],
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
            "outputRowCount": d.row_count,
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
            "projectArea": null,
            "readOnly": false,
            "dirty": seq > 0,
            "lastSavedAt": null,
            "originals": p.originals,
            "datasets": p.datasets.iter().map(Self::dataset_summary).collect::<Vec<_>>(),
            "exports": [],
            "rulePacks": [],
            "auditHead": { "seq": seq, "hash": hash },
        }))
    }

    pub fn schema(&self, dataset: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        Ok(json!({
            "datasetId": d.id,
            "name": d.name,
            "source": { "fileId": d.spec["fileId"], "fileName": d.spec["fileName"], "format": d.spec["options"]["format"] },
            "rowCount": d.row_count,
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
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(duckdb::params![offset as i64, (offset + limit) as i64])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let rid: i64 = row.get(0)?;
            let loc: i64 = row.get(1)?;
            let mut cells = Vec::new();
            for (j, (_, kind, _)) in cols.iter().enumerate() {
                cells.push(Self::cell(row, j + 2, *kind)?);
            }
            out.push(json!({
                "rowId": rid,
                "locator": format!("line {loc}"),
                "cells": cells,
                "edited": vec![false; cols.len()],
                "issue": vec![Value::Null; cols.len()],
            }));
        }
        Ok(json!({
            "datasetId": d.id,
            "stage": stage,
            "offset": offset,
            "totalRows": d.row_count,
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
                    issue: to_issue(st),
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
                        exc = quote_ident(&d.exceptions_view()),
                        col = quote_text(c)
                    ),
                ),
                None => (String::new(), String::new()),
            };
            let sql = format!(
                "SELECT v.__rid, v.__loc{select}{raw} FROM {view} v WHERE v.__rid IN ({list}) ORDER BY v.__rid",
                view = quote_ident(&d.view)
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
                    "state": occurrence_state(st, rid as u64),
                    "decidedBy": null,
                }));
            }
        }
        Ok(json!({ "items": items, "total": st.flagged.count(), "offset": offset }))
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

/// Starts a check run over a dataset (SAD section 8.3): every rule of the check packs, as SQL.
pub fn run_checks(shared: &Arc<Shared>, dataset: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let project_id = engine.project()?.id.clone();
    let d = engine.dataset(dataset)?;
    let dataset_id = d.id.clone();
    let view = quote_ident(&d.view);
    let exceptions = quote_ident(&d.exceptions_view());
    let row_count = d.row_count;
    let columns = d.check_columns();
    let crs = d.spec["crs"]["value"]["code"].as_str().map(String::from);
    let notes = d.notes.clone();
    let assumptions = d.assumptions.clone();
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
            project_area: None,
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

/// Records a job's outcome and tells the client.
fn finish_job(
    shared: &Arc<Shared>,
    job_id: &str,
    outcome: Result<Value>,
    changed: &[&str],
    dataset_id: &str,
) {
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
            shared.event(
                json!({ "type": "project.changed", "what": changed, "datasetId": dataset_id }),
            );
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
    let project_id = engine.project()?.id.clone();
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
        "DROP VIEW IF EXISTS {jobview}; DROP VIEW IF EXISTS {jobexc}; \
         CREATE OR REPLACE VIEW {view} AS SELECT * FROM read_parquet({file}); \
         CREATE OR REPLACE VIEW {excview} AS SELECT * FROM read_parquet({exc});",
        jobview = quote_ident(&imported.view),
        jobexc = quote_ident(&format!("{}{EXCEPTIONS_SUFFIX}", imported.view)),
        view = quote_ident(&view),
        excview = quote_ident(&format!("{view}{EXCEPTIONS_SUFFIX}")),
        file = quote_text(&parquet.to_string_lossy()),
        exc = quote_text(&exc.to_string_lossy()),
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
    };
    let summary = Engine::dataset_summary(&dataset);
    let p = engine
        .project
        .as_mut()
        .ok_or_else(|| EngineError::internal("The project disappeared during the import."))?;
    if !p.originals.iter().any(|o| o["fileId"] == file_id) {
        p.originals.push(json!({ "fileId": file_id, "name": spec["fileName"], "size": spec["size"], "mediaType": media_type, "addedSeq": added_seq }));
    }
    p.next_dataset += 1;
    p.datasets.push(dataset);
    Ok(summary)
}
