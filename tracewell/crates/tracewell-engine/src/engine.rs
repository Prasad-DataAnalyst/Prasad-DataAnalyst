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
use crate::rules::{RowSet, check_packs};
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
    /// Records of the packages exported and verified.
    pub exports: Vec<Value>,
    /// Where each original's bytes are on disk, by file ID, for saving them into the project file.
    pub original_paths: HashMap<String, PathBuf>,
    pub last_saved_at: Option<String>,
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
            "exports": p.exports,
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

    /// The data health score (FR-VAL-05), as queries.ts datasetHealth.
    pub fn health(&self, dataset: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        let checked = !d.check_packs.is_empty();
        let rows = d.row_count;
        let counted: Vec<&IssueState> = d
            .issues
            .iter()
            .filter(|st| st.draft.severity != "note")
            .collect();
        let affected = |sts: &[&IssueState]| {
            sts.iter()
                .filter(|st| st.draft.scope == "rows")
                .fold(RowSet::new(rows), |all, st| {
                    all.union(&st.current.minus(&st.accepted))
                })
                .count()
        };
        let open = |sts: &[&IssueState]| {
            sts.iter()
                .filter(|st| to_issue(st)["counts"]["open"].as_u64().unwrap_or(0) > 0)
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
    let project_id = engine.project()?.id.clone();
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
        row_count: d.row_count,
        columns,
        sources,
        rule_packs: d.check_packs.clone(),
        assumptions: d.assumptions.clone(),
        issues: d.issues.iter().map(to_issue).collect(),
        audit: p.log.entries().to_vec(),
        audit_head: json!({ "seq": seq, "hash": hash }),
        workdir: engine.workdir.join(&project_id),
        target,
        threads: engine.threads,
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

#[allow(dead_code)] // Read back by openProject.
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

struct SavedDataset {
    notes: Vec<Value>,
    id: String,
    name: String,
    rows: u64,
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
    let p = engine.project()?;
    let project_id = p.id.clone();
    let datasets: Vec<SavedDataset> = p
        .datasets
        .iter()
        .map(|d| SavedDataset {
            notes: d.notes.iter().map(note_json).collect(),
            id: d.id.clone(),
            name: d.name.clone(),
            rows: d.row_count,
            view: quote_ident(&d.view),
            columns: out_columns(d),
            rows_file: d.rows_file.clone(),
            exceptions_file: d.exceptions_file.clone(),
            source_seq: d.source_seq,
        })
        .collect();
    let originals: Vec<(Value, PathBuf)> = p
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
                let sha =
                    crate::export::dataset_digest(&conn, &d.view, &d.columns, d.rows, threads)?;
                digests.push(json!({ "id": d.id, "name": d.name, "rowCount": d.rows, "workingDigest": sha, "outputDigest": sha }));
                if cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
            }
            // Checked before the save is recorded, so a changed original leaves no save behind.
            for (info, path) in &originals {
                progress("Checking the original files", 0);
                let (sha, _) = crate::project::hash_file(path).map_err(|_| {
                    EngineError::not_found(
                        format!(
                            "The original file {} can no longer be read.",
                            path.display()
                        ),
                        "Put the original file back where it was imported from, then save again.",
                    )
                })?;
                if info["fileId"].as_str() != Some(sha.as_str()) {
                    return Err(EngineError::new(
                        "INVALID_INPUT",
                        format!(
                            "{} has changed since it was imported, so it cannot be saved as the project's original.",
                            path.display()
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
            let mut packs: Vec<Value> = Vec::new();
            for e in p
                .log
                .entries()
                .iter()
                .filter(|e| e["action"] == "check.run")
            {
                for r in e["payload"]["packs"].as_array().into_iter().flatten() {
                    if !packs
                        .iter()
                        .any(|x| x["id"] == r["id"] && x["version"] == r["version"])
                    {
                        packs.push(r.clone());
                    }
                }
            }
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
            let cache_bytes = datasets
                .iter()
                .map(|d| {
                    let record =
                        json!({ "datasetId": d.id, "sourceSeq": d.source_seq, "kind": "notes" });
                    let text = format!("{}\n", crate::canonical::canonical_json(&json!(d.notes)));
                    (record, text.into_bytes())
                })
                .collect();
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
    };
    let summary = Engine::dataset_summary(&dataset);
    let p = engine
        .project
        .as_mut()
        .ok_or_else(|| EngineError::internal("The project disappeared during the import."))?;
    if let Some(id) = file_id.as_str() {
        p.original_paths
            .entry(id.to_string())
            .or_insert_with(|| original.to_path_buf());
    }
    if !p.originals.iter().any(|o| o["fileId"] == file_id) {
        p.originals.push(json!({ "fileId": file_id, "name": spec["fileName"], "size": spec["size"], "mediaType": media_type, "addedSeq": added_seq }));
    }
    p.next_dataset += 1;
    p.datasets.push(dataset);
    Ok(summary)
}
