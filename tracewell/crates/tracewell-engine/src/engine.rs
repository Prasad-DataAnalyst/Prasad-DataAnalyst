//! The native engine's state and protocol methods. Each change is an audit draft appended to the
//! hash-chained log, in the same format and with the same payloads as the TypeScript engine, so a
//! project's history means the same thing whichever engine wrote it.

use crate::audit::AuditLog;
use crate::canonical::sha256_hex;
use crate::checks::{CheckCtx, Col, summarize};
use crate::csv::Note;
use crate::error::{EngineError, Result};
use crate::framing::{Incoming, write_message};
use crate::import::{
    EXCEPTIONS_SUFFIX, ImportPlan, import_plan, import_source, quote_ident, quote_text,
};
use crate::issues::{
    IssueState, Listed, matches, merge_check_run, occurrence_state, open_rows, sort, to_issue,
};
use crate::overrides::{Outcome, ReadEnv, original_file, override_of};
use crate::parse::Kind;
use crate::parse::Raw;
use crate::rules::{Draft, RowSet, check_packs, find_rule};
use crate::steps::{StageColumn, Stages};
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
    /// The steps applied, in order, each with its `id` and `seq`.
    pub steps: Vec<Value>,
    /// Rows in the output view, counted when the views are installed.
    pub output_rows: u64,
    /// The recipe last run on the dataset (FR-RCP-02): id, name, version, baseline and export.
    pub recipe: Value,
    /// An override has read the original again, so the working files no longer hold what the
    /// `source.add` entry imported, and a project file keeps no cache of them.
    pub reread: bool,
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

    /// The columns of the working view, as the checks see them: converted columns in place.
    fn check_columns(&self) -> Vec<Col> {
        self.stages()
            .map(|st| st.working)
            .unwrap_or_else(|_| self.base_columns())
            .iter()
            .map(|c| Col::from_schema(&c.schema, c.kind))
            .collect()
    }

    /// The columns the import planned, with how each is stored.
    fn base_columns(&self) -> Vec<StageColumn> {
        self.spec["columns"]
            .as_array()
            .into_iter()
            .flatten()
            .zip(&self.columns)
            .map(|(c, (_, kind))| StageColumn {
                schema: c.clone(),
                kind: *kind,
            })
            .collect()
    }

    /// The working and output views' columns after the steps.
    fn stages(&self) -> Result<Stages> {
        crate::steps::build(&self.base_columns(), &self.steps)
    }

    /// The view of the output stage: the working view less the rows the filters drop.
    fn out_view(&self) -> String {
        format!("{}__out", self.view)
    }
}

/// The column a column comes from: itself, or the source its conversions start from (rootColumn).
fn root_of(stages: &Stages, id: &str) -> String {
    let mut id = id.to_string();
    while let Some(from) = stages
        .every
        .iter()
        .find(|c| c.id() == id)
        .and_then(StageColumn::derived_from)
    {
        id = from.to_string();
    }
    id
}

/// A dataset schema's `source` (schemaFor): the file, its format and, for a workbook its sheet,
/// for JSON its layout.
fn source_of(spec: &Value) -> Value {
    let mut source = json!({ "fileId": spec["fileId"], "fileName": spec["fileName"], "format": spec["options"]["format"] });
    if spec["options"]["format"] == "xlsx" {
        source["sheet"] = spec["options"]["xlsx"]["sheet"].clone();
    }
    if spec["options"]["format"] == "json" {
        source["layout"] = spec["options"]["json"]["layout"].clone();
    }
    source
}

/// A sheet name as a spreadsheet formula writes it: quoted, apostrophes doubled, unless it is a
/// plain word.
fn sheet_ref(name: &str) -> String {
    let mut chars = name.chars();
    let plain = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if plain {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

/// A row's or a cell's source locator (locator.ts): 'line 4, field 3' for delimited text,
/// 'Sheet1!C17' for workbooks (the column's source index read as its sheet column), 'record 12,
/// key "rate"' for JSON and 'row 4, column "rate"' for Parquet, columns named as the file names them.
fn locator(spec: &Value, loc: i64, column: Option<&Value>) -> String {
    let source_name = |c: &Value| {
        c["sourceHeader"][0]
            .as_str()
            .or(c["name"].as_str())
            .unwrap_or("")
            .to_string()
    };
    let json_at = || {
        let unit = if spec["options"]["json"]["layout"] == "lines" {
            "line"
        } else {
            "record"
        };
        format!("{unit} {loc}")
    };
    let sheet = || {
        sheet_ref(
            spec["options"]["xlsx"]["sheet"]
                .as_str()
                .unwrap_or("Sheet1"),
        )
    };
    match (spec["options"]["format"].as_str(), column) {
        (Some("xlsx"), None) => format!("{} row {loc}", sheet()),
        (Some("xlsx"), Some(c)) => format!(
            "{}!{}{loc}",
            sheet(),
            crate::xlsx::column_name(c["sourceIndex"].as_u64().unwrap_or(0) as u32)
        ),
        (Some("json"), None) => json_at(),
        (Some("json"), Some(c)) => format!(
            "{}, key {}",
            json_at(),
            serde_json::to_string(&source_name(c)).unwrap_or_default()
        ),
        (Some("parquet"), None) => format!("row {loc}"),
        (Some("parquet"), Some(c)) => format!(
            "row {loc}, column {}",
            serde_json::to_string(&source_name(c)).unwrap_or_default()
        ),
        (_, None) => format!("line {loc}"),
        (_, Some(c)) => format!(
            "line {loc}, field {}",
            c["sourceIndex"].as_u64().unwrap_or(0) + 1
        ),
    }
}

/// Columns as an export or a digest takes them.
fn out_columns(cols: &[StageColumn]) -> Vec<crate::export::OutColumn> {
    cols.iter()
        .map(|c| crate::export::OutColumn {
            id: c.id().to_string(),
            name: c.schema["name"].as_str().unwrap_or_default().to_string(),
            unit: c.schema["unit"]["value"].as_str().map(String::from),
            typ: c.schema["type"]["value"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            kind: c.kind,
        })
        .collect()
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
    /// Step IDs are numbered per project: 's1', 's2', ...
    pub next_step: u64,
    /// Findings about the project file when it was opened or recovered: one issue of the system
    /// rule pack per failed integrity rule (TW-PRJ-001 to TW-PRJ-004), listed with the issues.
    pub system_issues: Vec<Draft>,
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
    /// The file that keeps the user's mapping templates (FR-IMP-06), beside the engine rather than
    /// in a project.
    pub templates: PathBuf,
    /// Bytes the current call hands back with its answer, under `bytes` (a saved recipe).
    pub reply_bytes: Option<Vec<u8>>,
    /// This session's recovery journal (FR-PRJ-03); nothing is journalled without one.
    pub journal: Option<crate::recovery::Journal>,
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
            templates: PathBuf::from("mapping-templates.json"),
            reply_bytes: None,
            journal: None,
        }
    }

    /// Validates a decision, appends its entry and applies it. An override reads the file again
    /// before its entry is appended, so a file that cannot be read that way leaves no entry behind.
    fn commit_decision(&mut self, d: &Value) -> Result<Value> {
        let draft = decision_draft(&self.conn, self.writable()?, d)?;
        let prepared = self.prepare_override(&draft)?;
        let entry = self.append(draft, None)?;
        let reverted = self
            .project()?
            .log
            .entries()
            .iter()
            .find(|e| entry["action"] == "entry.revert" && e["seq"] == entry["target"]["seq"])
            .cloned();
        let Engine {
            conn,
            project,
            workdir,
            threads,
            ..
        } = self;
        let p = project
            .as_mut()
            .ok_or_else(|| EngineError::internal("The project disappeared during the decision."))?;
        let env = ReadEnv {
            workdir,
            threads: *threads,
        };
        apply_decision(
            conn,
            p,
            &entry,
            reverted.as_ref(),
            &|_, _| false,
            &env,
            prepared,
        )?;
        Ok(entry)
    }

    /// What an override draft, or the revert of one, makes of its dataset, worked out before the
    /// entry is appended (commitDraft); None for any other draft.
    fn prepare_override(&self, draft: &Map<String, Value>) -> Result<Option<Outcome>> {
        let p = self.project()?;
        let e = Value::Object(draft.clone());
        let reverted = if e["action"] == "entry.revert" {
            p.log
                .entries()
                .iter()
                .find(|x| x["seq"] == e["target"]["seq"])
        } else {
            None
        };
        if override_of(&e, reverted).is_none() {
            return Ok(None);
        }
        let env = ReadEnv {
            workdir: &self.workdir,
            threads: self.threads,
        };
        override_outcome(&self.conn, p, &e, reverted, &env, p.log.head().0 + 1).map(Some)
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
                "formats": ["csv", "tsv", "xlsx", "parquet", "json"],
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
            next_step: 1,
            system_issues: Vec::new(),
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
        self.journal_now();
        self.summary()
    }

    fn dataset_summary(d: &Dataset) -> Value {
        json!({
            "id": d.id,
            "name": d.name,
            "source": source_of(&d.spec),
            "rowCount": d.row_count,
            "outputRowCount": d.output_rows,
            "columnCount": d.stages().map_or(d.columns.len(), |s| s.working.len()),
            "assumptions": d.assumptions.len(),
            "partial": false,
            "steps": d.steps,
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

    pub fn schema(&self, dataset: &Value, stage: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        let output = match stage.as_str() {
            None | Some("working") if !stage.is_string() || stage == "working" => false,
            Some("output") => true,
            _ => {
                return Err(EngineError::invalid(
                    format!(
                        "The stage {} does not exist.",
                        stage
                            .as_str()
                            .map_or_else(|| stage.to_string(), String::from)
                    ),
                    "Ask for the 'working' or the 'output' stage.",
                ));
            }
        };
        let stages = d.stages()?;
        let cols = if output {
            &stages.output
        } else {
            &stages.working
        };
        Ok(json!({
            "datasetId": d.id,
            "name": d.name,
            "source": source_of(&d.spec),
            "rowCount": if output { d.output_rows } else { d.visible_rows() },
            "columns": cols.iter().map(|c| c.schema.clone()).collect::<Vec<_>>(),
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
        let stages = d.stages()?;
        let at_stage = if stage == "output" {
            &stages.output
        } else {
            &stages.working
        };
        let wanted: Vec<String> = match q["columns"].as_array() {
            Some(cols) => cols
                .iter()
                .map(|c| c.as_str().unwrap_or_default().to_string())
                .collect(),
            None => at_stage.iter().map(|c| c.id().to_string()).collect(),
        };
        let mut cols = Vec::new();
        for id in &wanted {
            let c = at_stage.iter().find(|c| c.id() == id).ok_or_else(|| {
                EngineError::not_found(
                    format!("Dataset {} has no column {id} at this stage.", d.id),
                    "Choose a listed column.",
                )
            })?;
            cols.push((id.clone(), c.kind, c.schema.clone()));
        }
        let roots: Vec<String> = cols.iter().map(|(id, _, _)| root_of(&stages, id)).collect();
        let select: Vec<String> = cols.iter().map(|(id, _, _)| quote_ident(id)).collect();
        let columns = format!(
            "__rid, __loc{}{}",
            if select.is_empty() { "" } else { ", " },
            select.join(", ")
        );
        let filtered = stage == "output" && !stages.filters.is_empty();
        let (total, sql, params) = if filtered {
            // Filters keep rows anywhere, so positions are counted in the output view itself.
            (
                d.output_rows,
                format!(
                    "SELECT {columns} FROM {} ORDER BY __rid LIMIT ? OFFSET ?",
                    quote_ident(&d.out_view())
                ),
                (limit as i64, offset as i64),
            )
        } else {
            // Positions in the working view, as row-ID bounds, so the Parquet scan stays a range.
            let total = d.visible_rows();
            let end = (offset + limit).min(total);
            let (from, to) = if offset >= end {
                (0, 0)
            } else {
                (d.row_at(offset), d.row_at(end - 1) + 1)
            };
            (
                total,
                format!(
                    "SELECT {columns} FROM {} WHERE __rid >= ? AND __rid < ? ORDER BY __rid",
                    quote_ident(&d.view)
                ),
                (from as i64, to as i64),
            )
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(duckdb::params![params.0, params.1])?;
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
                .zip(&roots)
                .map(|((id, _, _), root)| {
                    d.issues
                        .iter()
                        .filter(|st| {
                            st.draft.scope == "rows"
                                && (st.draft.columns.contains(id)
                                    || st.draft.columns.contains(root))
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
                "locator": locator(&d.spec, loc, None),
                "cells": cells,
                "edited": cols.iter().zip(&roots).map(|((id, _, _), root)| d.edits.contains_key(&(id.clone(), r)) || d.edits.contains_key(&(root.clone(), r))).collect::<Vec<_>>(),
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
                "derived": plan.get("derivedFrom").is_some(),
            })).collect::<Vec<_>>(),
            "rows": out,
        }))
    }

    pub fn column_stats(&self, dataset: &Value, column: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        let id = column.as_str().unwrap_or("");
        let kind = d
            .stages()?
            .working
            .iter()
            .find(|c| c.id() == id)
            .map(|c| c.kind)
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
            let namer = column_namer(d);
            let stages = d.stages().ok();
            let root = |c: &str| {
                stages
                    .as_ref()
                    .map_or_else(|| c.to_string(), |s| root_of(s, c))
            };
            let baseline = d.recipe["baseline"]["issues"].as_array();
            for st in &d.issues {
                let columns: Vec<String> = st.draft.columns.iter().map(|c| namer(c)).collect();
                let mut issue = to_issue(st, &d.excluded);
                // After a recipe run, each issue says whether it is new or changed since its baseline.
                if let Some(baseline) = baseline {
                    issue["delta"] = crate::recipes::delta_of(&issue, &columns, baseline);
                }
                let listed = Listed {
                    issue,
                    names: columns.join(", "),
                };
                if matches(&listed, q, &root) {
                    list.push(listed);
                }
            }
        }
        // Findings about the project file concern every dataset, so they are listed whatever the filter.
        let head = p.log.head().0;
        for dr in &p.system_issues {
            if !(q["datasetId"].is_null()
                || dr.dataset_id.is_empty()
                || q["datasetId"] == dr.dataset_id.as_str())
            {
                continue;
            }
            let d = p.datasets.iter().find(|d| d.id == dr.dataset_id);
            let mut issue = system_to_issue(dr, head);
            if let Some(baseline) = d.and_then(|d| d.recipe["baseline"]["issues"].as_array()) {
                issue["delta"] = crate::recipes::delta_of(&issue, &[], baseline);
            }
            let stages = d.and_then(|d| d.stages().ok());
            let root = |c: &str| {
                stages
                    .as_ref()
                    .map_or_else(|| c.to_string(), |s| root_of(s, c))
            };
            let listed = Listed {
                issue,
                names: String::new(),
            };
            if matches(&listed, q, &root) {
                list.push(listed);
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
        if p.system_issues.iter().any(|d| d.issue_id() == id) {
            return Ok(json!({ "items": [], "total": 0, "offset": offset }));
        }
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
                        locator(&d.spec, loc, Some(plan)),
                    ),
                    None => (Value::Null, Value::Null, locator(&d.spec, loc, None)),
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
        if self.jobs.get(id).map(|o| o["state"] == "running") == Some(true)
            && let Some(flag) = self.cancels.get(id)
        {
            flag.store(true, Ordering::Relaxed);
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
fn install_views(conn: &Connection, d: &mut Dataset) -> Result<()> {
    let stages = d.stages()?;
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
    let mut base = format!("SELECT * FROM {rows}");
    if !d.edits.is_empty() {
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
        base = format!("SELECT {} FROM {rows} b{joins}", select.join(", "));
    }
    // Each conversion adds its column to the layer below, so conversions chain in step order.
    for der in &stages.derived {
        base = format!(
            "SELECT *, {} AS {} FROM ({base})",
            der.method.sql(&quote_ident(&der.source)),
            quote_ident(&der.id)
        );
    }
    conn.execute_batch(&format!("CREATE OR REPLACE VIEW {all} AS {base};"))?;
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
    let out = quote_ident(&d.out_view());
    conn.execute_batch(&format!(
        "CREATE OR REPLACE VIEW {view} AS SELECT * FROM {all}{}; \
         CREATE OR REPLACE VIEW {exc} AS SELECT e.* FROM {all_exc} e{}; \
         CREATE OR REPLACE VIEW {out} AS SELECT * FROM {view}{};",
        filter(&keep_rows),
        filter(&keep_exc),
        filter(&stages.filters),
    ))?;
    d.output_rows = if stages.filters.is_empty() {
        d.visible_rows()
    } else {
        let n: i64 = conn.query_row(&format!("SELECT count(*) FROM {out}"), [], |r| r.get(0))?;
        n.max(0) as u64
    };
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

/// An issue of the system rule pack about the whole project or one dataset (systemIssue).
fn system_issue(rule_id: &str, dataset_id: &str, message: &str, detail: Value) -> Option<Draft> {
    let pack = check_packs().iter().find(|p| p.id == "tracewell.system")?;
    let rule = pack.rules.iter().find(|r| r.id == rule_id)?;
    Some(Draft {
        rule_id: rule.id.clone(),
        rule_version: rule.version.clone(),
        pack_id: pack.id.clone(),
        severity: rule.severity.clone(),
        category: rule.category.clone(),
        dataset_id: dataset_id.to_string(),
        columns: Vec::new(),
        scope: "dataset",
        rows: RowSet::new(0),
        message: crate::rules::render_message(
            &rule.message,
            &[
                ("detail", crate::rules::Var::Text(message.to_string())),
                ("count", crate::rules::Var::Num(1.0)),
                ("column", crate::rules::Var::Text("the dataset".into())),
                ("unit", crate::rules::Var::Text(String::new())),
            ],
        ),
        detail: Some(detail),
    })
}

/// The failed integrity checks of an open or a recovery as issues, one per rule, in the order the
/// rules first failed (project-io.ts finish). An issue names the dataset when its only failure
/// does; otherwise it concerns the whole project.
fn integrity_issues(p: &Project, checks: &[Value]) -> Vec<Draft> {
    let mut by_rule: Vec<(String, Vec<&Value>)> = Vec::new();
    for c in checks.iter().filter(|c| c["ok"] == false) {
        let Some(rule) = c["ruleId"].as_str() else {
            continue;
        };
        match by_rule.iter_mut().find(|(r, _)| r == rule) {
            Some((_, list)) => list.push(c),
            None => by_rule.push((rule.to_string(), vec![c])),
        }
    }
    by_rule
        .into_iter()
        .filter_map(|(rule, list)| {
            let first = list[0];
            let more = if list.len() > 1 {
                format!(" (and {} more)", list.len() - 1)
            } else {
                String::new()
            };
            let dataset = first["target"]
                .as_str()
                .filter(|t| list.len() == 1 && p.datasets.iter().any(|d| d.id == *t))
                .unwrap_or("");
            let detail = json!({
                "checks": list
                    .iter()
                    .map(|c| json!({ "id": c["id"], "detail": c["detail"], "target": c.get("target").cloned().unwrap_or(Value::Null) }))
                    .collect::<Vec<_>>(),
            });
            let message = format!("{}{more}", first["detail"].as_str().unwrap_or(""));
            system_issue(&rule, dataset, &message, detail)
        })
        .collect()
}

/// A system issue as the issue list shows it (systemToIssue): open, with nothing to review row by row.
fn system_to_issue(d: &Draft, seq: u64) -> Value {
    let rule = find_rule(&d.rule_id).map(|(_, r)| r);
    json!({
        "id": d.issue_id(),
        "ruleId": d.rule_id,
        "ruleVersion": d.rule_version,
        "packId": d.pack_id,
        "severity": d.severity,
        "category": d.category,
        "datasetId": d.dataset_id,
        "columns": d.columns,
        "scope": d.scope,
        "title": rule.map_or(d.rule_id.as_str(), |r| r.title.as_str()),
        "message": d.message,
        "explanation": rule.map_or("", |r| r.explanation.as_str()),
        "source": rule.map_or("", |r| r.source.as_str()),
        "status": "open",
        "counts": { "flagged": 1, "open": 1, "accepted": 0, "excluded": 0, "fixed": 0 },
        "openRows": { "count": 0, "ranges": [] },
        "comments": [],
        "firstSeenSeq": seq,
        "lastCheckedSeq": seq,
    })
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

/// What an override entry, or the revert of one, makes of its dataset (overrideOutcome), read
/// from the dataset's original. `seq` is the entry that applies it.
fn override_outcome(
    conn: &Connection,
    p: &Project,
    e: &Value,
    reverted: Option<&Value>,
    env: &ReadEnv,
    seq: u64,
) -> Result<Outcome> {
    let (property, column, value) = override_of(e, reverted)
        .ok_or_else(|| EngineError::internal("The entry is not a detection override."))?;
    let source = reverted.unwrap_or(e);
    let id = source["target"]["datasetId"].as_str().unwrap_or("");
    let d = p.datasets.iter().find(|d| d.id == id).ok_or_else(|| {
        EngineError::not_found(
            format!("There is no dataset {id} in this project."),
            "Choose a listed dataset.",
        )
    })?;
    let file_id = d.spec["fileId"].as_str().unwrap_or_default();
    let original = p.original_paths.get(file_id).ok_or_else(|| {
        EngineError::new(
            "PROJECT_INVALID",
            format!("The original file of dataset {} is missing.", d.id),
            "Open the project from a complete .twp file.",
        )
    })?;
    let path = original_file(original, env.workdir, file_id)?;
    let name = p
        .originals
        .iter()
        .find(|o| o["fileId"] == file_id)
        .and_then(|o| o["name"].as_str())
        .or(d.spec["fileName"].as_str())
        .unwrap_or_default()
        .to_string();
    crate::overrides::outcome(
        conn,
        d,
        &path,
        &name,
        env,
        &env.workdir.join(&p.id),
        &property,
        column.as_deref(),
        &value,
        seq,
    )
}

/// Installs what an override made of a dataset (reducer.ts install), then runs the checks again
/// when `recheck_now` says so. A change of reading setting reads new rows, so the edits,
/// exclusions and issues of the old ones go.
fn install_override(
    conn: &Connection,
    d: &mut Dataset,
    o: Outcome,
    area: Option<[f64; 4]>,
    seq: u64,
    recheck_now: bool,
) -> Result<()> {
    d.spec = o.spec;
    d.columns = o.columns;
    d.assumptions = o.assumptions;
    let mut replaced = Vec::new();
    if let Some(r) = o.reread {
        replaced.push(std::mem::replace(&mut d.rows_file, r.rows_file));
        replaced.push(std::mem::replace(&mut d.exceptions_file, r.exceptions_file));
        d.row_count = r.row_count;
        d.notes = r.notes;
        d.reread = true;
    }
    if o.rows_change {
        d.edits.clear();
        d.excluded = RowSet::new(d.row_count);
        d.exclusions.clear();
        d.issues.clear();
    }
    install_views(conn, d)?;
    for f in replaced {
        if f != d.rows_file && f != d.exceptions_file {
            let _ = std::fs::remove_file(f);
        }
    }
    if recheck_now {
        recheck(conn, d, area, seq)?;
    }
    Ok(())
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
    env: &ReadEnv,
    prepared: Option<Outcome>,
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
        "step.apply" => {
            let area = area_of(&p.project_area);
            let step_id = e["target"]["stepId"].as_str().unwrap_or("").to_string();
            let n: u64 = step_id.trim_start_matches('s').parse().unwrap_or(0);
            p.next_step = p.next_step.max(n + 1);
            let d = dataset_mut(p, &id)?;
            let mut step = e["new"].clone();
            step["id"] = json!(step_id);
            step["seq"] = json!(seq);
            let convert = step["kind"] == "convert_unit";
            d.steps.push(step);
            install_views(conn, d)?;
            if convert && !skip(&id, seq) {
                recheck(conn, d, area, seq)?;
            }
        }
        "step.remove" => {
            let area = area_of(&p.project_area);
            let d = dataset_mut(p, &id)?;
            let step_id = &e["target"]["stepId"];
            let convert = d
                .steps
                .iter()
                .any(|st| st["id"] == *step_id && st["kind"] == "convert_unit");
            d.steps.retain(|st| st["id"] != *step_id);
            install_views(conn, d)?;
            if convert && !skip(&id, seq) {
                recheck(conn, d, area, seq)?;
            }
        }
        "detection.override" => {
            let area = area_of(&p.project_area);
            let o = match prepared {
                Some(o) => o,
                None => override_outcome(conn, p, e, None, env, seq)?,
            };
            let d = dataset_mut(p, &id)?;
            install_override(conn, d, o, area, seq, !skip(&id, seq))?;
        }
        "recipe.apply" => {
            let r = &e["payload"]["recipe"];
            dataset_mut(p, &id)?.recipe = json!({
                "id": r["id"],
                "name": r["name"],
                "version": r["version"],
                "baseline": r["baseline"],
                "export": r["export"],
            });
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
                "step.apply" => {
                    let area = area_of(&p.project_area);
                    let d = dataset_mut(p, &tid)?;
                    d.steps.retain(|st| st["id"] != target["target"]["stepId"]);
                    install_views(conn, d)?;
                    if !skip(&tid, seq) {
                        recheck(conn, d, area, seq)?;
                    }
                }
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
                "detection.override" => {
                    let area = area_of(&p.project_area);
                    let o = match prepared {
                        Some(o) => o,
                        None => override_outcome(conn, p, e, Some(target), env, seq)?,
                    };
                    let d = dataset_mut(p, &tid)?;
                    install_override(conn, d, o, area, seq, !skip(&tid, seq))?;
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
pub fn cell_json(c: &crate::parse::Cell) -> Value {
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
            if ds
                .stages()
                .is_ok_and(|s| s.working.iter().any(|c| c.id() == col))
            {
                EngineError::invalid(
                    "A converted column is calculated from its source and cannot be edited.",
                    "Edit the value in the source column instead.",
                )
            } else {
                EngineError::not_found(
                    format!("Dataset {} has no column {col}.", ds.id),
                    "Choose a listed column.",
                )
            }
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
        let csv = import_plan(&ds.spec)?;
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
        "locator": locator(&ds.spec, loc, Some(plan)),
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
            if action == "step.apply" {
                let step_id = &target["target"]["stepId"];
                let ds = p.datasets.iter().find(|x| *dataset == x.id.as_str());
                if !ds.is_some_and(|x| x.steps.iter().any(|st| st["id"] == *step_id)) {
                    return Err(EngineError::invalid(
                        format!(
                            "Step {} has already been removed.",
                            step_id.as_str().unwrap_or_default()
                        ),
                        "Choose another entry.",
                    ));
                }
                if let Some(ds) = ds {
                    require_steps_build(
                        ds,
                        ds.steps
                            .iter()
                            .filter(|st| st["id"] != *step_id)
                            .cloned()
                            .collect(),
                        &format!("Reverting step {}", step_id.as_str().unwrap_or_default()),
                    )?;
                }
            }
            if action == "detection.override" {
                let property = target["payload"]["property"].as_str().unwrap_or("");
                if let Some(ds) = p.datasets.iter().find(|x| *dataset == x.id.as_str())
                    && crate::overrides::changes_rows(property)
                {
                    crate::overrides::require_no_work(ds, property)?;
                }
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
            let reason = reason_of(&d["reason"])?;
            let id = d["datasetId"].as_str().unwrap_or("");
            let ds = p.datasets.iter().find(|x| x.id == id).ok_or_else(|| {
                EngineError::not_found(
                    format!("There is no dataset {id} in this project."),
                    "Choose a listed dataset.",
                )
            })?;
            let property = d["property"].as_str().unwrap_or("");
            let value = d.get("value").cloned().unwrap_or(Value::Null);
            crate::overrides::check_override_value(property, &value)?;
            let old = crate::overrides::old_value(ds, property, d["columnId"].as_str())?;
            let mut target = json!({ "datasetId": ds.id });
            if let Some(c) = d.get("columnId") {
                target["columnId"] = c.clone();
            }
            let mut e = draft("detection.override", target);
            e.insert("old".into(), old);
            e.insert("new".into(), value);
            e.insert("reason".into(), json!(reason));
            e.insert("payload".into(), json!({ "property": property }));
            e
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

/// Refuses a step list that no longer builds, such as a filter on a column a removed conversion
/// created (requireStepsBuild).
fn require_steps_build(d: &Dataset, steps: Vec<Value>, what: &str) -> Result<()> {
    let base = d.base_columns();
    if crate::steps::build(&base, &steps).is_ok() {
        return Ok(());
    }
    let later = (0..steps.len())
        .find(|&i| crate::steps::build(&base, &steps[..=i]).is_err())
        .and_then(|i| steps[i]["id"].as_str().map(String::from));
    Err(EngineError::invalid(
        format!(
            "{what} would break step {}, which uses a column it creates.",
            later.as_deref().unwrap_or("a later step")
        ),
        format!(
            "Remove step {} first.",
            later.as_deref().unwrap_or("the later step")
        ),
    ))
}

const STEP_KINDS: [&str; 3] = ["convert_unit", "filter", "select_columns"];

fn require_step_kind(s: &Value) -> Result<()> {
    if s["kind"].as_str().is_some_and(|k| STEP_KINDS.contains(&k)) {
        return Ok(());
    }
    Err(EngineError::invalid(
        format!(
            "The step kind {} does not exist.",
            s["kind"]
                .as_str()
                .map_or_else(|| "undefined".to_string(), String::from)
        ),
        "Choose a unit conversion, a filter or a column selection.",
    ))
}

impl Engine {
    /// What a step would do, without recording it (previewStep): its description, the output's
    /// row count after it, and for a conversion the method and the first rows before and after.
    pub fn preview_step(&self, dataset: &Value, s: &Value) -> Result<Value> {
        let d = self.dataset(dataset)?;
        let stages = d.stages()?;
        if let Err(e) = crate::steps::validate(s, &stages) {
            return Ok(
                json!({ "ok": false, "error": e.to_json(), "description": "", "sample": [] }),
            );
        }
        let convert = s["kind"] == "convert_unit";
        let seen = if convert {
            &stages.working
        } else {
            &stages.output
        };
        let description = crate::steps::describe(s, seen);
        let mut next = s.clone();
        next["id"] = json!(format!("s{}", d.steps.len() + 1));
        next["seq"] = json!(9_007_199_254_740_991u64);
        let mut steps = d.steps.clone();
        steps.push(next);
        let after = crate::steps::build(&d.base_columns(), &steps)?;
        let resulting = if after.filters.is_empty() {
            d.visible_rows()
        } else {
            let n: i64 = self.conn.query_row(
                &format!(
                    "SELECT count(*) FROM {} WHERE {}",
                    quote_ident(&d.view),
                    after.filters.join(" AND ")
                ),
                [],
                |r| r.get(0),
            )?;
            n.max(0) as u64
        };
        if !convert {
            return Ok(
                json!({ "ok": true, "description": description, "sample": [], "resultingRows": resulting }),
            );
        }
        let method = crate::steps::conversion_for(s, &stages.working)?;
        let source = s["columnId"].as_str().unwrap_or_default();
        let kind = stages
            .working
            .iter()
            .find(|c| c.id() == source)
            .map_or(Kind::Number, |c| c.kind);
        let shown = d.visible_rows().min(20);
        let mut sample = Vec::new();
        if shown > 0 {
            let src = quote_ident(source);
            let mut stmt = self.conn.prepare(&format!(
                "SELECT __rid, {src}, {} FROM {} WHERE __rid >= ? AND __rid < ? ORDER BY __rid",
                method.sql(&src),
                quote_ident(&d.view)
            ))?;
            let mut rows = stmt.query(duckdb::params![
                d.row_at(0) as i64,
                (d.row_at(shown - 1) + 1) as i64
            ])?;
            while let Some(row) = rows.next()? {
                sample.push(json!({
                    "rowId": row.get::<_, i64>(0)?,
                    "before": Self::cell(row, 1, kind)?,
                    "after": Self::cell(row, 2, Kind::Number)?,
                }));
            }
        }
        Ok(json!({
            "ok": true,
            "method": method.to_json(),
            "description": description,
            "sample": sample,
            "resultingRows": resulting,
        }))
    }
}

impl Engine {
    /// The rule packs the checks run (listRulePacks), as shipped.
    pub fn list_rule_packs(&self) -> Result<Value> {
        [crate::rules::GENERIC_DQ_JSON, crate::rules::SYSTEM_JSON]
            .iter()
            .map(|text| {
                serde_json::from_str::<Value>(text)
                    .map_err(|_| EngineError::internal("A built-in rule pack is not JSON."))
            })
            .collect::<Result<Vec<_>>>()
            .map(Value::from)
    }

    /// The units of the registry (listUnits): of one quantity, or those a unit converts to
    /// without crossing a convention.
    pub fn list_units(&self, q: &Value) -> Result<Value> {
        use crate::units::{all_units, get_unit, same_family};
        let mut units: Vec<&crate::units::Unit> = all_units().collect();
        if let Some(code) = q["compatibleWith"].as_str() {
            let u = get_unit(code).ok_or_else(|| {
                EngineError::new(
                    "UNIT_UNKNOWN",
                    format!("The unit '{code}' is not in the unit registry."),
                    "Choose a unit from the list.",
                )
            })?;
            units.retain(|v| same_family(&u.quantity, &v.quantity) && v.convention == u.convention);
        }
        if let Some(quantity) = q["quantity"].as_str() {
            units.retain(|v| v.quantity == quantity);
        }
        Ok(Value::from(
            units
                .iter()
                .map(|u| json!({ "code": u.code, "label": u.label, "quantity": u.quantity, "convention": u.convention }))
                .collect::<Vec<_>>(),
        ))
    }
}

const TEMPLATE_FORMAT: &str = "tracewell-mapping-templates";

fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
}

/// Whether a stored template has the shape schemas.mappingTemplate requires; one that does not
/// is left out rather than trusted.
fn valid_template(t: &Value) -> bool {
    let column = |c: &Value| {
        strings(&c["sourceHeader"])
            && c["name"].is_string()
            && c["type"].is_string()
            && (c["unit"].is_string() || c["unit"].is_null())
            && c["role"].is_string()
            && strings(&c["nullMarkers"])
            && c.get("dateFormat").is_none_or(Value::is_string)
            && c.get("timezone").is_none_or(Value::is_string)
    };
    t["id"].as_str().is_some_and(|id| id.starts_with("mt_"))
        && t["name"].as_str().is_some_and(|n| !n.is_empty())
        && t["savedFrom"]["fileName"].is_string()
        && t["savedFrom"]["format"].is_string()
        && t["columns"]
            .as_array()
            .is_some_and(|cs| cs.iter().all(column))
        && t["savedAt"].is_string()
        && t["savedBy"].is_string()
}

pub fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

impl Engine {
    /// The valid templates in the store; a missing or unreadable store holds none.
    fn load_templates(&self) -> Vec<Value> {
        let Ok(text) = std::fs::read_to_string(&self.templates) else {
            return Vec::new();
        };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else {
            return Vec::new();
        };
        if doc["format"] != TEMPLATE_FORMAT {
            return Vec::new();
        }
        doc["templates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| valid_template(t))
            .cloned()
            .collect()
    }

    fn store_templates(&self, templates: &[Value]) -> Result<()> {
        if let Some(dir) = self
            .templates
            .parent()
            .filter(|d| !d.as_os_str().is_empty())
        {
            std::fs::create_dir_all(dir)?;
        }
        let doc = json!({ "format": TEMPLATE_FORMAT, "version": 1, "templates": templates });
        let text = serde_json::to_string_pretty(&doc)
            .map_err(|_| EngineError::internal("The mapping templates could not be written."))?;
        // Written whole, then renamed over the old file, so a crash never leaves half a store.
        let tmp = self.templates.with_extension("json.tmp");
        std::fs::write(&tmp, format!("{text}\n"))?;
        std::fs::rename(&tmp, &self.templates)?;
        Ok(())
    }

    /// The user's mapping templates, by name (listMappingTemplates).
    pub fn list_mapping_templates(&self) -> Result<Value> {
        let mut list = self.load_templates();
        list.sort_by(|a, b| {
            utf16_cmp(
                a["name"].as_str().unwrap_or(""),
                b["name"].as_str().unwrap_or(""),
            )
        });
        Ok(Value::from(list))
    }

    /// The mapping template for a file's detected columns (templateFor): the chosen one, refused
    /// when it does not fit; none when the choice is null; or the one that fits when none is given.
    fn template_for(&self, plans: &[Value], choice: Option<&Value>) -> Result<Option<Value>> {
        use crate::sniff::{apply_template, match_template};
        let templates = match choice {
            Some(Value::Null) => return Ok(None),
            _ => self.load_templates(),
        };
        let Some(id) = choice else {
            return Ok(match_template(&templates, plans).and_then(|t| apply_template(t, plans)));
        };
        let shown = id.as_str().map_or_else(|| id.to_string(), String::from);
        let chosen = templates.iter().find(|t| &t["id"] == id).ok_or_else(|| {
            EngineError::not_found(
                format!("There is no mapping template {shown}."),
                "Choose a template from the list, or import without one.",
            )
        })?;
        let applied = apply_template(chosen, plans).ok_or_else(|| {
            EngineError::invalid(
                format!(
                    "The mapping template \"{}\" does not fit this file: some of its columns are not in it.",
                    chosen["name"].as_str().unwrap_or("")
                ),
                "Import without the template, or choose one saved from a file with the same columns.",
            )
        })?;
        Ok(Some(applied))
    }

    /// The import preview of a file (sniff): its options, columns, sample rows and assumptions,
    /// read as the mapping template that fits it says, or the chosen one, or none.
    pub fn sniff(&self, msg: &Incoming, file: &Value, o: &Value) -> Result<Value> {
        use crate::sniff::{Source, credit_template, preview, sniff_source};
        let (path, name) = input_path(self, msg, file)?;
        let size = std::fs::metadata(&path)?.len();
        let src = Source {
            path: &path,
            name: &name,
            size,
        };
        let sniffed = sniff_source(&self.conn, &src, &o["options"])?;
        let budget = self.memory_limit;
        let mut detected = preview(&src, &sniffed, &[], budget)?;
        let plans = detected["columns"].as_array().cloned().unwrap_or_default();
        let Some(applied) = self.template_for(&plans, o.get("template"))? else {
            detected["template"] = Value::Null;
            return Ok(detected);
        };
        let overrides = applied["overrides"].as_array().cloned().unwrap_or_default();
        let mut shown = if overrides.is_empty() {
            detected
        } else {
            preview(&src, &sniffed, &overrides, budget)?
        };
        let columns = shown["columns"].as_array().cloned().unwrap_or_default();
        shown["columns"] = Value::from(credit_template(columns, &applied));
        shown["template"] = applied;
        Ok(shown)
    }

    /// Saves how a dataset's columns are read as a template (saveMappingTemplate): the columns
    /// read from the source, by header text, with their settings; a template of the same name is
    /// replaced.
    pub fn save_mapping_template(&mut self, o: &Value) -> Result<Value> {
        use unicode_normalization::UnicodeNormalization;
        let d = self.dataset(&o["datasetId"])?;
        let name: String = o["name"]
            .as_str()
            .unwrap_or("")
            .nfc()
            .collect::<String>()
            .trim_matches(crate::units::is_js_space)
            .to_string();
        if name.is_empty() || name.encode_utf16().count() > 200 {
            return Err(EngineError::invalid(
                "A mapping template name must be text of 1 to 200 characters.",
                "Type a name for the template.",
            ));
        }
        let stages = d.stages()?;
        let columns: Vec<Value> = stages
            .working
            .iter()
            .filter(|c| c.derived_from().is_none() && c.schema["type"]["value"] != "geometry")
            .map(|c| {
                let s = &c.schema;
                let mut t = json!({
                    "sourceHeader": s["sourceHeader"],
                    "name": s["name"],
                    "type": s["type"]["value"],
                    "unit": s["unit"]["value"],
                    "role": s["role"]["value"],
                    "nullMarkers": s["nullMarkers"]["value"],
                });
                for k in ["dateFormat", "timezone"] {
                    if let Some(v) = s.get(k) {
                        t[k] = v["value"].clone();
                    }
                }
                t
            })
            .collect();
        if columns.is_empty() {
            return Err(EngineError::invalid(
                format!(
                    "{} has no columns read from its source file, so there is nothing to save.",
                    d.name
                ),
                "Save a template from a dataset imported from a file.",
            ));
        }
        let template = json!({
            "id": format!("mt_{}", &sha256_hex(name.as_bytes())[..12]),
            "name": name,
            "savedFrom": { "fileName": d.spec["fileName"], "format": d.spec["options"]["format"] },
            "columns": columns,
            "savedAt": self.clock.now_iso(),
            "savedBy": self.project()?.profile["name"],
        });
        if !valid_template(&template) {
            return Err(EngineError::internal(format!(
                "The mapping template \"{name}\" could not be saved: it is not valid."
            )));
        }
        let mut kept: Vec<Value> = self
            .load_templates()
            .into_iter()
            .filter(|t| t["id"] != template["id"])
            .collect();
        kept.push(template.clone());
        self.store_templates(&kept)?;
        Ok(template)
    }

    /// Deletes a mapping template (deleteMappingTemplate).
    pub fn delete_mapping_template(&mut self, id: &Value) -> Result<Value> {
        let templates = self.load_templates();
        if !templates.iter().any(|t| t["id"] == *id) {
            return Err(EngineError::not_found(
                format!(
                    "There is no mapping template {}.",
                    id.as_str().map_or_else(|| id.to_string(), String::from)
                ),
                "Choose a template from the list.",
            ));
        }
        let kept: Vec<Value> = templates.into_iter().filter(|t| t["id"] != *id).collect();
        self.store_templates(&kept)?;
        Ok(Value::Null)
    }
}

impl Engine {
    /// Writes the recovery journal after a change: the audit log as it now stands and where each
    /// original is. A read-only project records nothing new, so it has nothing to journal. A
    /// failed write is said once on standard error and tried again after the next change.
    pub fn journal_now(&mut self) {
        let Some(p) = self.project.as_ref().filter(|p| !p.read_only) else {
            return;
        };
        let originals: Vec<(Value, crate::project::OriginalSource, bool)> = p
            .originals
            .iter()
            .filter_map(|o| {
                let source = p.original_paths.get(o["fileId"].as_str()?)?.clone();
                // Uploads live in this session's working folder, which may not outlive it, and a
                // recovered upload in the old journal, which goes once recovered.
                let copy = matches!(&source, crate::project::OriginalSource::File(path)
                    if path.starts_with(&self.workdir) || self.journal.as_ref().is_some_and(|j| j.holds(path)));
                Some((o.clone(), source, copy))
            })
            .collect();
        let (id, name, jsonl) = (p.id.clone(), p.name.clone(), p.log.to_jsonl());
        if let Some(j) = self.journal.as_mut()
            && let Err(e) = j.write(&id, &name, &jsonl, &originals)
        {
            eprintln!(
                "Unsaved work could not be journalled for recovery: {}",
                e.message
            );
        }
    }

    /// Work an earlier session left unsaved (recoveryInfo): the latest journal of a session that
    /// has ended, when it holds audit entries after the project's last save. Journals with nothing
    /// unsaved are deleted.
    pub fn recovery_info(&mut self) -> Result<Value> {
        let Some(j) = self.journal.as_mut() else {
            return Ok(Value::Null);
        };
        while let Some(found) = j.find_orphan() {
            let (log, _) = AuditLog::from_jsonl(&found.project_id, &found.audit_jsonl);
            let entries = log.entries();
            let last_save = entries.iter().rposition(|e| e["action"] == "project.save");
            let unsaved = entries[last_save.map_or(0, |i| i + 1)..]
                .iter()
                .filter(|e| e["action"] != "project.create")
                .count();
            if unsaved > 0 {
                return Ok(json!({
                    "projectId": found.project_id,
                    "name": found.name,
                    "updatedAt": found.updated_at,
                    "entries": entries.len(),
                    "unsaved": unsaved,
                }));
            }
            j.drop_orphan();
        }
        Ok(Value::Null)
    }

    /// Deletes the unsaved work recoveryInfo found (discardRecovery).
    pub fn discard_recovery(&mut self) -> Result<Value> {
        if let Some(j) = self.journal.as_mut()
            && j.find_orphan().is_some()
        {
            j.drop_orphan();
        }
        Ok(Value::Null)
    }
}

/// Rebuilds the unsaved project of a session that ended (recoverProject) and makes it this
/// session's own, journalled again before the old journal is deleted. Each original is checked
/// against its SHA-256, the audit chain is verified and the log replayed; any failure opens the
/// project read-only. Result: ProjectOpenReport.
pub fn recover_project(shared: &Arc<Shared>) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let (job, cancel) = engine.start_job();
    drop(engine);
    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> Result<Value> {
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            let found = engine
                .journal
                .as_mut()
                .and_then(|j| j.find_orphan())
                .ok_or_else(|| {
                    EngineError::not_found(
                        "There is no unsaved work to recover.",
                        "Start a new project or open one.",
                    )
                })?;
            let fail = |id: &str, detail: String, rule: &str, target: Option<&str>| {
                crate::project::integrity(id, false, detail, Some(rule), target)
            };
            let mut checks = Vec::new();
            for (info, source) in &found.originals {
                let name = info["name"].as_str().unwrap_or("");
                let id = info["fileId"].as_str().unwrap_or("");
                match crate::project::hash_source(source) {
                    Ok(sha) if sha == id => {}
                    Ok(_) => checks.push(fail(
                        "original-checksum",
                        format!("The recovered copy of {name} does not match its SHA-256."),
                        "TW-PRJ-001",
                        Some(id),
                    )),
                    Err(_) => checks.push(fail(
                        "original-checksum",
                        format!("The original file {name} can no longer be read."),
                        "TW-PRJ-001",
                        Some(id),
                    )),
                }
            }
            if checks.is_empty() {
                checks.push(crate::project::integrity(
                    "original-checksum",
                    true,
                    format!(
                        "All {} original files match their SHA-256.",
                        found.originals.len()
                    ),
                    None,
                    None,
                ));
            }
            let (log, bad_line) = AuditLog::from_jsonl(&found.project_id, &found.audit_jsonl);
            let chain = log.verify();
            checks.push(if bad_line.is_none() && chain["ok"] == true {
                crate::project::integrity(
                    "audit-chain",
                    true,
                    format!(
                        "All {} recovered audit entries verify, each linked to the one before.",
                        log.entries().len()
                    ),
                    None,
                    None,
                )
            } else {
                let at = chain["brokenAt"]
                    .as_u64()
                    .map_or(String::new(), |s| format!(" at entry {s}"));
                fail(
                    "audit-chain",
                    format!(
                        "The recovered audit chain is broken{at}: {}.",
                        chain["reason"]
                            .as_str()
                            .unwrap_or("an entry does not verify")
                    ),
                    "TW-PRJ-002",
                    None,
                )
            });
            let conn = engine.conn.try_clone()?;
            let workdir = engine.workdir.clone();
            let threads = engine.threads;
            let mut p = Project {
                id: found.project_id.clone(),
                name: String::new(),
                created_at: String::new(),
                profile: Value::Null,
                unit_system: "SI".into(),
                log: AuditLog::new(&found.project_id),
                datasets: Vec::new(),
                originals: Vec::new(),
                next_dataset: 1,
                exports: Vec::new(),
                original_paths: HashMap::new(),
                last_saved_at: None,
                read_only: false,
                project_area: Value::Null,
                reverted: HashSet::new(),
                next_step: 1,
                system_issues: Vec::new(),
            };
            let archive = PathBuf::new();
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
                journal: Some(
                    found
                        .originals
                        .iter()
                        .map(|(info, source)| {
                            (
                                info["fileId"].as_str().unwrap_or("").to_string(),
                                source.clone(),
                            )
                        })
                        .collect(),
                ),
            };
            let read = crate::project::TwpRead {
                entries: Vec::new(),
                manifest: None,
                audit_jsonl: None,
                checks: Vec::new(),
                verified: HashSet::new(),
                originals: HashMap::new(),
            };
            drop(engine);
            let replayed = reopen.replay(&mut p, &log, &read, &Value::Null, &mut |_, _| ())?;
            checks.push(match &replayed.stopped {
                None => crate::project::integrity("replay-digest", true, format!("All {} datasets were rebuilt from the original files and the recovered audit log.", p.datasets.len()), None, None),
                Some(why) => fail("replay-digest", format!("Rebuilding the project stopped at audit {why}"), "TW-PRJ-003", None),
            });
            if p.name.is_empty() {
                p.name = found.name.clone();
            }
            let read_only = checks.iter().any(|c| c["ok"] == false);
            p.read_only = read_only;
            p.system_issues = integrity_issues(&p, &checks);
            p.log = log;
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            engine.project = Some(p);
            engine.journal_now();
            if let Some(j) = engine.journal.as_mut() {
                j.drop_orphan();
            }
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

/// How a column's text was parsed, in words (lineage.ts parseMethod).
fn parse_method(c: &Value) -> String {
    let typ = c["type"]["value"].as_str().unwrap_or("string");
    match typ {
        "number" | "integer" => format!(
            "{typ}, decimal separator '{}'",
            c["decimalSeparator"]["value"].as_str().unwrap_or(".")
        ),
        "date" => format!(
            "date, {} format",
            c["dateFormat"]["value"].as_str().unwrap_or("iso")
        ),
        "datetime" => format!(
            "datetime, {}",
            c["timezone"]["value"]
                .as_str()
                .unwrap_or("naive-assumed-utc")
        ),
        "boolean" => "boolean, true/false".into(),
        "geometry" => "GeoJSON geometry".into(),
        _ => "text as written".into(),
    }
}

impl Engine {
    /// Where a cell's value came from (explainCell, SAD section 9.3): the source locator and text,
    /// how the text was parsed, every audit entry that changed the cell, and its current value.
    pub fn explain_cell(&self, dataset: &Value, row: &Value, column: &Value) -> Result<Value> {
        let p = self.project()?;
        let d = self.dataset(dataset)?;
        let r = row
            .as_f64()
            .and_then(|x| row_id(x, d.row_count))
            .ok_or_else(|| {
                EngineError::not_found(
                    format!("Dataset {} has no row {}.", d.id, js_number(row)),
                    "Choose a row shown in the data grid.",
                )
            })?;
        let stages = d.stages()?;
        let col = column.as_str().unwrap_or_default();
        let shown = stages
            .working
            .iter()
            .find(|c| c.id() == col)
            .ok_or_else(|| {
                EngineError::not_found(
                    format!("Dataset {} has no column {col} at this stage.", d.id),
                    "Choose a listed column.",
                )
            })?;
        // The conversion steps the column's values went through.
        let mut steps = HashSet::new();
        let mut at = Some(shown.clone());
        while let Some(c) = at {
            match (c.schema["derivedFrom"]["step"].as_str(), c.derived_from()) {
                (Some(step), Some(from)) => {
                    steps.insert(step.to_string());
                    at = stages.every.iter().find(|x| x.id() == from).cloned();
                }
                _ => at = None,
            }
        }
        let root = root_of(&stages, col);
        let plan = d.spec["columns"]
            .as_array()
            .and_then(|cs| cs.iter().find(|c| c["id"] == root.as_str()))
            .cloned()
            .unwrap_or(Value::Null);
        let (raw, marker): (Option<String>, Option<String>) = {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT raw, marker FROM {} WHERE rid = ? AND col = ?",
                quote_ident(&d.all_exceptions_view())
            ))?;
            let mut rows = stmt.query(duckdb::params![r as i64, root])?;
            match rows.next()? {
                Some(x) => (x.get(0)?, x.get(1)?),
                None => (None, None),
            }
        };
        let (loc, current): (i64, Value) = {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT __loc, {} FROM {} WHERE __rid = ?",
                quote_ident(col),
                quote_ident(&d.all_view())
            ))?;
            let mut rows = stmt.query(duckdb::params![r as i64])?;
            match rows.next()? {
                Some(x) => (x.get(0)?, Self::cell(x, 1, shown.kind)?),
                None => {
                    return Err(EngineError::internal(format!(
                        "Row {r} of dataset {} is missing.",
                        d.id
                    )));
                }
            }
        };
        let file_id = d.spec["fileId"].as_str().unwrap_or_default();
        let raw_text = match raw.clone().or(marker.clone()) {
            Some(kept) => Some(kept),
            None => match p.original_paths.get(file_id) {
                Some(source) => {
                    let index = plan["sourceIndex"].as_u64().unwrap_or(0) as usize;
                    let read = import_plan(&d.spec)?;
                    match read.reading {
                        // A Parquet row is found by its number; its field reads as rawToText does.
                        crate::import::Reading::Parquet => {
                            let path =
                                crate::overrides::original_file(source, &self.workdir, file_id)?;
                            crate::parquet::read_row(&self.conn, &path, loc.max(0) as u64)?
                                .and_then(|fields| fields.get(index).map(Raw::text))
                        }
                        // The records are read again until the one at this locator.
                        crate::import::Reading::Json(layout) => {
                            let path =
                                crate::overrides::original_file(source, &self.workdir, file_id)?;
                            let mut found = None;
                            let stop = EngineError::new("FOUND", "", "");
                            let read = crate::import::read_json(
                                &path,
                                &layout,
                                &mut |at, fields| {
                                    if at as i64 == loc {
                                        found = Some(fields.get(index).map(Raw::text));
                                        return Err(stop.clone());
                                    }
                                    Ok(())
                                },
                                &AtomicBool::new(false),
                                &std::sync::atomic::AtomicU64::new(0),
                            );
                            match read {
                                Err(e) if e.code != "FOUND" => return Err(e),
                                _ => found.flatten(),
                            }
                        }
                        // The chosen table is read again until the row at this locator.
                        crate::import::Reading::Xlsx(options) => {
                            let path =
                                crate::overrides::original_file(source, &self.workdir, file_id)?;
                            let mut found = None;
                            crate::xlsx::read(&path, &options, &mut |at, fields| {
                                if at as i64 == loc {
                                    found = Some(fields.get(index).map(Raw::text));
                                    return Ok(false);
                                }
                                Ok(true)
                            })?;
                            found.flatten()
                        }
                        _ => crate::import::field_text(source, &read, loc, index)?,
                    }
                }
                None => None,
            },
        };
        let mut touched = HashSet::new();
        let mut history = Vec::new();
        for e in p.log.entries() {
            let seq = e["seq"].as_u64().unwrap_or(0);
            let t = &e["target"];
            let is_revert = e["action"] == "entry.revert"
                && t["seq"].as_u64().is_some_and(|s| touched.contains(&s));
            let touches = t["datasetId"] == d.id.as_str()
                && match e["action"].as_str().unwrap_or("") {
                    "source.add" => true,
                    "cell.edit" => t["rowId"].as_u64() == Some(r) && t["columnId"] == root.as_str(),
                    "detection.override" => {
                        let property = e["payload"]["property"].as_str().unwrap_or("");
                        t["columnId"] == root.as_str()
                            || !matches!(
                                property,
                                "name"
                                    | "type"
                                    | "unit"
                                    | "role"
                                    | "nullMarkers"
                                    | "dateFormat"
                                    | "timezone"
                            )
                    }
                    "step.apply" | "step.remove" => {
                        t["stepId"].as_str().is_some_and(|s| steps.contains(s))
                    }
                    "rows.exclude" => e["payload"]["rows"]
                        .as_array()
                        .is_some_and(|rows| rows.iter().any(|x| x.as_u64() == Some(r))),
                    _ => false,
                };
            if !is_revert && !touches {
                continue;
            }
            touched.insert(seq);
            if e["action"] == "source.add" {
                continue;
            }
            let mut item = json!({ "seq": seq, "at": e["at"], "actor": author(&e["actor"]), "action": e["action"] });
            for k in ["old", "new", "reason", "method"] {
                if let Some(v) = e.get(k) {
                    item[k] = v.clone();
                }
            }
            history.push(item);
        }
        let file_name = p
            .originals
            .iter()
            .find(|o| o["fileId"] == file_id)
            .and_then(|o| o["name"].as_str())
            .or(d.spec["fileName"].as_str())
            .unwrap_or_default();
        Ok(json!({
            "datasetId": d.id,
            "rowId": r,
            "columnId": col,
            "source": {
                "fileId": file_id,
                "fileName": file_name,
                "locator": locator(&d.spec, loc, Some(&plan)),
                "rawText": raw_text,
            },
            "parse": {
                "type": plan["type"]["value"],
                "method": parse_method(&plan),
                "nullMarker": marker,
                "ok": raw.is_none(),
            },
            "history": history,
            "current": current,
        }))
    }
}

/// Validates a step against the dataset as it stands, records it with its description (and a
/// conversion's method) and applies it (commitStep). Returns the step, its entry, the description
/// and the method.
fn commit_step(
    engine: &mut Engine,
    dataset_id: &str,
    input: &Value,
    reason: &str,
) -> Result<(Value, Value, String, Option<crate::steps::Method>)> {
    let p = engine.writable()?;
    let step_id = format!("s{}", p.next_step);
    let d = engine.dataset(&json!(dataset_id))?;
    let stages = d.stages()?;
    crate::steps::validate(input, &stages)?;
    let convert = input["kind"] == "convert_unit";
    let seen = if convert {
        &stages.working
    } else {
        &stages.output
    };
    let method = if convert {
        Some(crate::steps::conversion_for(input, seen)?)
    } else {
        None
    };
    let description = crate::steps::describe(input, seen);
    let mut target = json!({ "datasetId": dataset_id, "stepId": step_id });
    if convert {
        target["columnId"] = input["columnId"].clone();
    }
    let mut entry = draft("step.apply", target);
    entry.insert("new".into(), input.clone());
    entry.insert("reason".into(), json!(reason));
    if let Some(m) = &method {
        entry.insert("method".into(), m.to_json());
    }
    entry.insert("payload".into(), json!({ "description": description }));
    let appended = engine.append(entry, None)?;
    let Engine {
        conn,
        project,
        workdir,
        threads,
        ..
    } = &mut *engine;
    let p = project
        .as_mut()
        .ok_or_else(|| EngineError::internal("The project disappeared during the step."))?;
    let env = ReadEnv {
        workdir,
        threads: *threads,
    };
    apply_decision(conn, p, &appended, None, &|_, _| false, &env, None)?;
    let step = dataset_mut(p, dataset_id)?
        .steps
        .iter()
        .find(|st| st["id"] == step_id.as_str())
        .cloned()
        .ok_or_else(|| EngineError::internal(format!("Step {step_id} was not applied.")))?;
    Ok((step, appended, description, method))
}

/// The column names of a dataset's working view, for issue keys and baselines (columnNamer).
fn column_namer(d: &Dataset) -> impl Fn(&str) -> String + use<> {
    let names: Vec<(String, String)> = d
        .stages()
        .map(|s| s.every)
        .unwrap_or_else(|_| d.base_columns())
        .iter()
        .map(|c| {
            (
                c.id().to_string(),
                c.schema["name"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    move |id: &str| {
        names
            .iter()
            .find(|(c, _)| c == id)
            .map_or_else(|| id.to_string(), |(_, n)| n.clone())
    }
}

/// The rule packs this engine checks with, as references.
fn builtin_packs() -> Vec<Value> {
    check_packs().iter().map(|p| p.reference()).collect()
}

impl Engine {
    /// A recipe of a dataset's steps, checks and issues (saveRecipe); the .twr bytes go back with
    /// the answer.
    pub fn save_recipe(&mut self, o: &Value) -> Result<Value> {
        use unicode_normalization::UnicodeNormalization;
        let p = self.project()?;
        let d = self.dataset(&o["datasetId"])?;
        let name: String = o["name"]
            .as_str()
            .unwrap_or("")
            .nfc()
            .collect::<String>()
            .trim_matches(crate::units::is_js_space)
            .to_string();
        if name.is_empty() || name.encode_utf16().count() > 200 {
            return Err(EngineError::invalid(
                "A recipe name must be text of 1 to 200 characters.",
                "Type a name for the recipe.",
            ));
        }
        let exported = o.get("export").cloned().unwrap_or(Value::Null);
        if !exported.is_null() {
            let known = crate::export::profile_statuses()
                .iter()
                .any(|s| s["profile"]["id"] == exported["profile"]);
            if !known || !exported["neutralizeFormulas"].is_boolean() {
                return Err(EngineError::invalid(
                    format!(
                        "The export profile {} does not exist.",
                        exported["profile"]
                            .as_str()
                            .map_or_else(|| exported["profile"].to_string(), String::from)
                    ),
                    "Choose a listed export profile, or none.",
                ));
            }
        }
        if !d.checked() && d.steps.is_empty() && exported.is_null() {
            return Err(EngineError::invalid(
                format!(
                    "{} has not been checked and has no steps, so a recipe of it would do nothing.",
                    d.name
                ),
                "Run checks or apply a step first, then save the recipe.",
            ));
        }
        let issues: Vec<Value> = d
            .issues
            .iter()
            .map(|st| to_issue(st, &d.excluded))
            .collect();
        let version = if d.recipe["name"] == name.as_str() {
            d.recipe["version"].as_u64().unwrap_or(0) + 1
        } else {
            1
        };
        let base = d.base_columns();
        let namer = column_namer(d);
        let (dataset_name, steps, packs, rows) = (
            d.name.clone(),
            d.steps.clone(),
            d.check_packs.clone(),
            d.row_count,
        );
        let export = if exported.is_null() {
            Value::Null
        } else {
            json!({ "profile": exported["profile"], "neutralizeFormulas": exported["neutralizeFormulas"] })
        };
        let saved_by = p.profile["name"].clone();
        let version_text = self.version.clone();
        let at = self.clock.now_iso();
        let src = crate::recipes::Source {
            dataset_name: &dataset_name,
            base: &base,
            steps: &steps,
            check_packs: &packs,
            row_count: rows,
            issues: &issues,
            name: &namer,
        };
        let recipe =
            crate::recipes::build(&src, &name, version, &at, &saved_by, &version_text, export)?;
        self.reply_bytes = Some(crate::recipes::bytes(&recipe));
        Ok(json!({ "recipe": recipe, "fileName": crate::recipes::file_name(&recipe) }))
    }

    /// How a recipe would map onto a dataset (planRecipe).
    pub fn plan_recipe(&self, dataset: &Value, bytes: &[u8], file_name: &str) -> Result<Value> {
        let d = self.dataset(dataset)?;
        let recipe = crate::recipes::parse(bytes, file_name)?;
        Ok(crate::recipes::plan(
            &recipe,
            &d.id,
            &d.name,
            &d.base_columns(),
            &d.steps,
            &builtin_packs(),
        )
        .0)
    }
}

/// The contents of a file passed to a call, and its name.
fn input_bytes(engine: &Engine, msg: &Incoming, file: &Value) -> Result<(Vec<u8>, String)> {
    let (path, name) = input_path(engine, msg, file)?;
    Ok((std::fs::read(path)?, name))
}

/// planRecipe, reading the recipe file the call passes.
pub fn plan_recipe(
    shared: &Arc<Shared>,
    msg: &Incoming,
    dataset: &Value,
    file: &Value,
) -> Result<Value> {
    let engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let (bytes, name) = input_bytes(&engine, msg, file)?;
    engine.plan_recipe(dataset, &bytes, &name)
}

/// Runs a recipe as a job (applyRecipe): it is recorded, its steps are applied and its checks run,
/// each as its own audit entry with the user's reason, then the issues are compared with the
/// recipe's baseline. A recipe that does not fit is refused before anything is recorded.
/// Result: RecipeRun.
pub fn apply_recipe(
    shared: &Arc<Shared>,
    msg: &Incoming,
    dataset: &Value,
    file: &Value,
    reason: &Value,
) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let text = reason_of(reason)?;
    engine.writable()?;
    let dataset_id = engine.dataset(dataset)?.id.clone();
    let (bytes, file_name) = input_bytes(&engine, msg, file)?;
    let (job, cancel) = engine.start_job();
    drop(engine);
    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> Result<Value> {
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            engine.writable()?;
            let recipe = crate::recipes::parse(&bytes, &file_name)?;
            let d = engine.dataset(&json!(dataset_id))?;
            let (plan, steps) = crate::recipes::plan(
                &recipe,
                &d.id,
                &d.name,
                &d.base_columns(),
                &d.steps,
                &builtin_packs(),
            );
            if plan["fits"] != true {
                return Err(EngineError::invalid(
                    format!(
                        "The recipe \"{}\" does not fit {}: {}",
                        recipe["name"].as_str().unwrap_or(""),
                        d.name,
                        plan["problems"][0].as_str().unwrap_or("")
                    ),
                    "Set the dataset up as the recipe expects (column names, types and units), or choose another recipe.",
                ));
            }
            let mut entry = draft("recipe.apply", json!({ "datasetId": dataset_id }));
            entry.insert("reason".into(), json!(text));
            entry.insert(
                "payload".into(),
                json!({ "recipe": recipe, "columns": plan["columns"] }),
            );
            let appended = engine.append(entry, None)?;
            {
                let Engine {
                    conn,
                    project,
                    workdir,
                    threads,
                    ..
                } = &mut *engine;
                let p = project.as_mut().ok_or_else(|| {
                    EngineError::internal("The project disappeared during the recipe.")
                })?;
                let env = ReadEnv {
                    workdir,
                    threads: *threads,
                };
                apply_decision(conn, p, &appended, None, &|_, _| false, &env, None)?;
            }
            let label = format!(
                "Recipe \"{}\" v{}: {text}",
                recipe["name"].as_str().unwrap_or(""),
                recipe["version"]
            );
            let mut step_ids = Vec::new();
            for input in &steps {
                if cancel.load(Ordering::Relaxed) {
                    return Err(EngineError::new(
                        "CANCELLED",
                        "The recipe was cancelled.",
                        "Run the recipe again when you are ready.",
                    ));
                }
                let (step, _, _, _) = commit_step(&mut engine, &dataset_id, input, &label)?;
                step_ids.push(step["id"].clone());
            }
            let checked = !recipe["check"].is_null();
            if checked {
                let area = area_of(&engine.project()?.project_area);
                let drafts = check_drafts(
                    &engine.conn,
                    engine.dataset(&json!(dataset_id))?,
                    area,
                    &cancel,
                )?;
                let packs = builtin_packs();
                let mut run = draft("check.run", json!({ "datasetId": dataset_id }));
                run.insert("payload".into(), json!({ "packs": packs }));
                let seq = engine.append(run, None)?["seq"].as_u64().unwrap_or(0);
                let p = engine.project.as_mut().ok_or_else(|| {
                    EngineError::internal("The project disappeared during the recipe.")
                })?;
                let d = dataset_mut(p, &dataset_id)?;
                let n = d.row_count;
                merge_check_run(&mut d.issues, drafts, seq, n);
                d.check_packs = packs;
            }
            let d = engine.dataset(&json!(dataset_id))?;
            let mut result = json!({
                "datasetId": dataset_id,
                "recipeId": recipe["id"],
                "name": recipe["name"],
                "version": recipe["version"],
                "steps": step_ids,
                "checked": checked,
                "delta": null,
                "export": recipe["export"],
            });
            let baseline = recipe["baseline"]["issues"].as_array().cloned();
            if let (Some(baseline), true) = (baseline, checked) {
                let namer = column_namer(d);
                let issues: Vec<Value> = d
                    .issues
                    .iter()
                    .map(|st| to_issue(st, &d.excluded))
                    .collect();
                let states: Vec<Value> = issues
                    .iter()
                    .map(|i| {
                        let names: Vec<String> = i["columns"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|c| namer(c.as_str().unwrap_or("")))
                            .collect();
                        crate::recipes::delta_of(i, &names, &baseline)["state"].clone()
                    })
                    .collect();
                let count = |s: &str| states.iter().filter(|x| *x == s).count();
                result["delta"] = json!({
                    "new": count("new"),
                    "changed": count("changed"),
                    "unchanged": count("unchanged"),
                    "resolved": crate::recipes::resolved_since(&crate::recipes::baseline_of(&issues, &namer), &baseline),
                });
            }
            Ok(result)
        })();
        finish_job(
            &shared,
            &job_id,
            outcome,
            &["project", "steps", "schema", "datasets", "issues", "audit"],
            &dataset_id,
        );
    });
    Ok(json!({ "jobId": job, "kind": "recipe" }))
}

/// Applies a step as a job (applyStep): validated against the dataset as it stands, recorded with
/// its description (and, for a conversion, its method), then applied by the reducer. Result:
/// StepResult.
pub fn apply_step(
    shared: &Arc<Shared>,
    dataset: &Value,
    s: &Value,
    reason: &Value,
) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let text = reason_of(reason)?;
    engine.writable()?;
    let d = engine.dataset(dataset)?;
    require_step_kind(s)?;
    crate::steps::validate(s, &d.stages()?)?;
    let dataset_id = d.id.clone();
    let input = s.clone();
    let (job, _cancel) = engine.start_job();
    drop(engine);
    let shared = shared.clone();
    let job_id = job.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> Result<Value> {
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            let (step, appended, description, method) =
                commit_step(&mut engine, &dataset_id, &input, &text)?;
            let Engine { conn, project, .. } = &mut *engine;
            let p = project
                .as_mut()
                .ok_or_else(|| EngineError::internal("The project disappeared during the step."))?;
            let d = dataset_mut(p, &dataset_id)?;
            let mut result = json!({
                "step": step,
                "audit": appended,
                "description": description,
                "outputRows": d.output_rows,
            });
            if let Some(m) = method {
                let src = quote_ident(input["columnId"].as_str().unwrap_or_default());
                let (converted, nulls): (i64, i64) = conn.query_row(
                    &format!(
                        "SELECT count({src}), count(*) - count({src}) FROM {}",
                        quote_ident(&d.view)
                    ),
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                result["method"] = m.to_json();
                result["converted"] = json!(converted);
                result["nullsSkipped"] = json!(nulls);
            }
            Ok(result)
        })();
        finish_job(
            &shared,
            &job_id,
            outcome,
            &["project", "steps", "schema", "datasets", "issues", "audit"],
            &dataset_id,
        );
    });
    Ok(json!({ "jobId": job, "kind": "step" }))
}

/// Removes a step (removeStep), unless a later step uses a column it creates. Result: the
/// step.remove entry.
pub fn remove_step(
    shared: &Arc<Shared>,
    dataset: &Value,
    step_id: &Value,
    reason: &Value,
) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let text = reason_of(reason)?;
    engine.writable()?;
    let d = engine.dataset(dataset)?;
    let id = step_id.as_str().unwrap_or_default();
    let step = d
        .steps
        .iter()
        .find(|st| st["id"] == id)
        .cloned()
        .ok_or_else(|| {
            EngineError::not_found(
                format!(
                    "Dataset {} has no step {}.",
                    d.id,
                    step_id
                        .as_str()
                        .map_or_else(|| step_id.to_string(), String::from)
                ),
                "Choose a listed step.",
            )
        })?;
    require_steps_build(
        d,
        d.steps
            .iter()
            .filter(|st| st["id"] != id)
            .cloned()
            .collect(),
        &format!("Removing step {id}"),
    )?;
    let dataset_id = d.id.clone();
    let mut input = step;
    if let Some(o) = input.as_object_mut() {
        o.remove("id");
        o.remove("seq");
    }
    let mut entry = draft(
        "step.remove",
        json!({ "datasetId": dataset_id, "stepId": id }),
    );
    entry.insert("old".into(), input);
    entry.insert("reason".into(), json!(text));
    let appended = engine.append(entry, None)?;
    let Engine {
        conn,
        project,
        workdir,
        threads,
        ..
    } = &mut *engine;
    let p = project
        .as_mut()
        .ok_or_else(|| EngineError::internal("The project disappeared while removing the step."))?;
    let env = ReadEnv {
        workdir,
        threads: *threads,
    };
    apply_decision(conn, p, &appended, None, &|_, _| false, &env, None)?;
    engine.journal_now();
    drop(engine);
    shared.event(json!({ "type": "project.changed", "what": ["project", "steps", "schema", "datasets", "issues", "audit"], "datasetId": dataset_id }));
    Ok(appended)
}

/// Takes a decision (SAD section 8.1): validated, appended to the audit log, then applied by the
/// same reducer a replay uses. A change that alters what the checks see runs them again before
/// the answer, as the TypeScript engine does. Result: the audit entries written.
pub fn decide(shared: &Arc<Shared>, d: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let entry = engine.commit_decision(d)?;
    engine.journal_now();
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
    let stages = d.stages()?;
    let columns = out_columns(&stages.output);
    let step_descriptions: Vec<String> = d
        .steps
        .iter()
        .map(|st| {
            engine
                .project()
                .map(|p| p.log.entries())
                .unwrap_or_default()
                .iter()
                .find(|e| e["seq"] == st["seq"])
                .and_then(|e| e["payload"]["description"].as_str().map(String::from))
                .unwrap_or_else(|| crate::steps::describe(st, &stages.working))
        })
        .collect();
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
        view: quote_ident(&d.out_view()),
        row_count: d.output_rows,
        excluded_rows: d.excluded.count(),
        steps: d.steps.clone(),
        step_descriptions,
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
        if outcome.is_err()
            && let Some(t) = &input.target
        {
            let _ = std::fs::remove_file(t);
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
pub fn note_json(n: &Note) -> Value {
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
    /// The output view's columns, its view and its rows.
    output: Vec<crate::export::OutColumn>,
    out_view: String,
    output_rows: u64,
    view: String,
    columns: Vec<crate::export::OutColumn>,
    rows_file: PathBuf,
    exceptions_file: PathBuf,
    source_seq: u64,
    /// An override read the original again, so the working files are not the import's result.
    reread: bool,
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
            columns: d
                .stages()
                .map(|s| out_columns(&s.working))
                .unwrap_or_default(),
            output: d
                .stages()
                .map(|s| out_columns(&s.output))
                .unwrap_or_default(),
            out_view: quote_ident(&d.out_view()),
            output_rows: d.output_rows,
            rows_file: d.rows_file.clone(),
            exceptions_file: d.exceptions_file.clone(),
            source_seq: d.source_seq,
            reread: d.reread,
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
                let out = crate::export::dataset_digest(
                    &conn,
                    &d.out_view,
                    d.edited,
                    &d.output,
                    d.output_rows,
                    threads,
                )?;
                digests.push(json!({ "id": d.id, "name": d.name, "rowCount": d.rows, "workingDigest": sha, "outputDigest": out }));
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
            // A dataset an override read again is rebuilt from its original on open: its working
            // files are not what its source.add entry imported, which is what a cache stands for.
            let caches = datasets
                .iter()
                .filter(|d| !d.reread)
                .flat_map(|d| {
                    [("rows", &d.rows_file), ("exceptions", &d.exceptions_file)].map(|(kind, file)| {
                        (json!({ "datasetId": d.id, "sourceSeq": d.source_seq, "kind": kind }), file.clone())
                    })
                })
                .collect();
            let mut cache_bytes: Vec<(Value, Vec<u8>)> = datasets
                .iter()
                .filter(|d| !d.reread)
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
            // Journalled before the job is done, so a client that sees it done can rely on it.
            engine.journal_now();
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
pub fn assumed_encoding_note(spec: &Value) -> Option<Note> {
    // Only delimited text has the note at import (assumedEncodingNote).
    if !matches!(spec["options"]["format"].as_str(), Some("csv" | "tsv")) {
        return None;
    }
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

/// Column overrides as single changes, each column's in the order an import applies them
/// (overrideList); a property left out is not changed, one set to null is.
fn override_list(overrides: &Value) -> Vec<(Option<String>, String, Value)> {
    overrides
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|o| {
            crate::overrides::COLUMN_PROPERTIES
                .iter()
                .filter_map(move |p| {
                    o.get(*p).map(|v| {
                        (
                            o["columnId"].as_str().map(String::from),
                            p.to_string(),
                            v.clone(),
                        )
                    })
                })
        })
        .collect()
}

/// Starts an import job: the plan is the preview the user reviewed (SAD decision D-12), executed here.
pub fn import_file(shared: &Arc<Shared>, msg: &Incoming, file: &Value, o: &Value) -> Result<Value> {
    let mut engine = shared
        .engine
        .lock()
        .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
    let project_id = engine.writable()?.id.clone();
    // As in the TypeScript engine, the import plans the file again rather than trusting a preview
    // sent with it: detection is deterministic, so the plan is the one the user reviewed.
    let (path, name) = input_path(&engine, msg, file)?;
    let src = crate::sniff::Source {
        path: &path,
        name: &name,
        size: std::fs::metadata(&path)?.len(),
    };
    // Column overrides are checked before anything is read (overrideList, checkOverrideValue).
    if !o["columnOverrides"].is_null() && !o["columnOverrides"].is_array() {
        return Err(EngineError::invalid(
            "Column overrides must be a list.",
            "Pass a list of column overrides.",
        ));
    }
    let overrides = override_list(&o["columnOverrides"]);
    for (_, property, value) in &overrides {
        crate::overrides::check_override_value(property, value)?;
    }
    let budget = engine.memory_limit;
    let planned = crate::sniff::preview(
        &src,
        &crate::sniff::sniff_source(&engine.conn, &src, &Value::Null)?,
        &[],
        budget,
    )?;
    let chosen = if o["options"].is_null() {
        planned.clone()
    } else {
        crate::sniff::preview(
            &src,
            &crate::sniff::sniff_source(&engine.conn, &src, &o["options"])?,
            &[],
            budget,
        )?
    };
    let chosen_plans = chosen["columns"].as_array().cloned().unwrap_or_default();
    // The import reads the file as detected; the template's changes, the settings the user chose
    // and their column overrides follow as detection.override entries, as in the TypeScript engine.
    let mut decisions: Vec<(Option<String>, String, Value, String)> = Vec::new();
    if let Some(t) = engine.template_for(&chosen_plans, o.get("template"))? {
        let reason = format!(
            "Mapping template \"{}\" ({}).",
            t["name"].as_str().unwrap_or(""),
            t["id"].as_str().unwrap_or("")
        );
        for (column, property, value) in override_list(&t["overrides"]) {
            decisions.push((column, property, value, reason.clone()));
        }
    }
    // Reading settings the user chose that differ from the detected ones (optionChanges).
    let (detected_options, chosen_options) =
        (&planned["sniff"]["options"], &chosen["sniff"]["options"]);
    let (group, properties): (&str, &[&str]) = match chosen_options["format"].as_str() {
        Some("csv" | "tsv") => ("csv", &crate::overrides::CSV_SETTINGS),
        Some("xlsx") => ("xlsx", &["sheet", "tableIndex"]),
        _ => ("", &[]),
    };
    let mut changes: Vec<(Option<String>, String, Value)> = properties
        .iter()
        .filter(|p| detected_options[group][**p] != chosen_options[group][**p])
        .map(|p| (None, p.to_string(), chosen_options[group][*p].clone()))
        .collect();
    changes.extend(overrides.iter().cloned());
    if !changes.is_empty() {
        let reason = reason_of(&o["overrideReason"])?;
        for (column, _, _) in &overrides {
            if !chosen_plans
                .iter()
                .any(|c| c["id"].as_str() == column.as_deref())
            {
                return Err(EngineError::not_found(
                    format!(
                        "The file has no column {}.",
                        column.as_deref().unwrap_or("undefined")
                    ),
                    "Choose a column shown in the preview.",
                ));
            }
        }
        for (column, property, value) in changes {
            decisions.push((column, property, value, reason.clone()));
        }
    }
    let preview = &planned;
    let mut spec = json!({
        "fileName": name,
        "options": preview["sniff"]["options"],
        "columns": preview["columns"],
        "detections": preview["sniff"]["detections"],
        "crs": preview["crs"],
        "datasetName": o["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| dataset_name_for(&name)),
    });
    let plan: ImportPlan = import_plan(&spec)?;
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
            let imported = import_source(
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
            let summary = commit_import(
                &shared,
                &project_id,
                spec.clone(),
                &plan,
                imported,
                &workdir,
                &job_id,
                assumptions,
                &path,
            )?;
            if decisions.is_empty() {
                return Ok(summary);
            }
            let mut engine = shared
                .engine
                .lock()
                .map_err(|_| EngineError::internal("The engine lock is poisoned."))?;
            for (column, property, value, reason) in decisions {
                let mut d = json!({
                    "kind": "override_detection",
                    "datasetId": summary["id"],
                    "property": property,
                    "value": value,
                    "reason": reason,
                });
                if let Some(c) = column {
                    d["columnId"] = json!(c);
                }
                engine.commit_decision(&d)?;
            }
            Ok(Engine::dataset_summary(engine.dataset(&summary["id"])?))
        })();
        let mut engine = match shared.engine.lock() {
            Ok(e) => e,
            Err(_) => return,
        };
        match outcome {
            Ok(result) => {
                engine.journal_now();
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

/// The first bytes of a file, as many as it has up to eight.
fn file_head(path: &Path) -> Vec<u8> {
    use std::io::Read;
    let mut head = Vec::with_capacity(8);
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(8).read_to_end(&mut head);
    }
    head
}

#[allow(clippy::too_many_arguments)]
fn commit_import(
    shared: &Arc<Shared>,
    project_id: &str,
    spec: Value,
    plan: &ImportPlan,
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
    let media_type = match spec["options"]["format"].as_str() {
        Some("tsv") => "text/tab-separated-values",
        Some("parquet") => "application/vnd.apache.parquet",
        Some("json") => "application/json",
        // A workbook in an OLE compound file is a legacy .xls (mediaTypeOf).
        Some("xlsx") if crate::xlsx::is_legacy(&file_head(original)) => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "text/csv",
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
    if let Some(note) = assumed_encoding_note(&spec)
        && !notes.iter().any(|n| n.code == "TW-IMP-004")
    {
        notes.insert(0, note);
    }
    let mut dataset = Dataset {
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
        steps: Vec::new(),
        output_rows: imported.row_count,
        recipe: Value::Null,
        reread: false,
    };
    install_views(&engine.conn, &mut dataset)?;
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

/// What a replay did: where it stopped, and how many datasets and check results came from caches.
#[derive(Default)]
struct Replayed {
    stopped: Option<String>,
    from_cache: usize,
    checks_restored: usize,
    checks_ran: usize,
}

struct Reopen<'a> {
    conn: &'a Connection,
    archive: &'a Path,
    workdir: &'a Path,
    threads: usize,
    cancel: &'a AtomicBool,
    /// The seq of every entry in the log.
    seqs: HashSet<u64>,
    /// When rebuilding from a recovery journal: where each original is, by file ID. The project
    /// file's originals and caches are used otherwise.
    journal: Option<HashMap<String, crate::project::OriginalSource>>,
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
    /// Replays the log onto the project (applyEntry for each entry), restoring datasets and issues
    /// from caches where the project file has usable ones. Stops at the first entry it cannot
    /// replay.
    fn replay(
        &mut self,
        p: &mut Project,
        log: &AuditLog,
        read: &crate::project::TwpRead,
        manifest: &Value,
        progress: &mut dyn FnMut(&str, u64),
    ) -> Result<Replayed> {
        let mut out = Replayed::default();
        for e in log.entries() {
            if self.cancel.load(Ordering::Relaxed) {
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
                    p.unit_system = e["new"]["unitSystem"].as_str().unwrap_or("SI").to_string();
                    p.created_at = e["at"].as_str().unwrap_or_default().to_string();
                    p.profile = e["payload"]["profile"].clone();
                    Ok(())
                }
                "source.add" => {
                    progress("Restoring the datasets", 0);
                    self.source_add(p, read, manifest, e, progress)
                        .map(|cached| {
                            if cached {
                                out.from_cache += 1;
                            }
                            if let Some(d) = p.datasets.last() {
                                progress("Restoring the saved check results", 0);
                                if let Some((after, issues)) = self.load_issues(read, manifest, d) {
                                    self.issue_caches
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
                "check.run" => self.check_run(p, e, progress).map(|how| match how {
                    CheckReplay::Ran => out.checks_ran += 1,
                    CheckReplay::Superseded => {}
                }),
                "cell.edit" | "issue.accept" | "rows.exclude" | "issue.comment"
                | "project.area" | "entry.revert" | "step.apply" | "step.remove"
                | "recipe.apply" | "detection.override" => {
                    let reverted = log
                        .entries()
                        .iter()
                        .find(|x| e["action"] == "entry.revert" && x["seq"] == e["target"]["seq"]);
                    let env = ReadEnv {
                        workdir: self.workdir,
                        threads: self.threads,
                    };
                    apply_decision(
                        self.conn,
                        p,
                        e,
                        reverted,
                        &|id, seq| self.cached(id, seq),
                        &env,
                        None,
                    )
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
                out.stopped = Some(format!("entry {at}: {}", err.message));
                break;
            }
            // Issues caches that hold the issues as this entry left them.
            let seq = e["seq"].as_u64().unwrap_or(0);
            for (id, (after, issues)) in self.issue_caches.iter_mut() {
                if *after != seq {
                    continue;
                }
                if let (Some(issues), Some(d)) =
                    (issues.take(), p.datasets.iter_mut().find(|d| d.id == *id))
                {
                    d.issues = issues;
                    out.checks_restored += 1;
                }
            }
        }
        Ok(out)
    }

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
        let plan = import_plan(&spec)?;
        let file_id = spec["fileId"].as_str().unwrap_or("").to_string();
        let dir = self.workdir.join(&p.id);
        std::fs::create_dir_all(&dir)?;
        let file_name = spec["fileName"].as_str().unwrap_or_default();
        let missing = || {
            EngineError::new(
                "PROJECT_INVALID",
                format!("The original file {file_name} is missing."),
                "Open the project from a complete .twp file.",
            )
        };
        let (source, cached) = match &self.journal {
            Some(originals) => (originals.get(&file_id).cloned().ok_or_else(missing)?, None),
            None => {
                // The TypeScript replay reads every original, so one that is missing or cannot be
                // read stops it here, and so does one whose bytes are not the file imported.
                match read.originals.get(&file_id) {
                    None | Some(None) => return Err(missing()),
                    Some(Some(sha)) if *sha != file_id => {
                        return Err(EngineError::invalid(
                            format!(
                                "The file {file_name} is not the file this import was planned for (its SHA-256 differs)."
                            ),
                            "Import the file again so the plan matches its contents.",
                        ));
                    }
                    Some(Some(_)) => {}
                }
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
                    .ok_or_else(missing)?;
                let cached = restore_cache(
                    self.conn,
                    self.archive,
                    read,
                    manifest,
                    &dataset_id,
                    seq,
                    &dir,
                )?;
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
                (source, cached)
            }
        };
        let used_cache = cached.is_some();
        let restored = match cached {
            Some(r) => r,
            None => {
                // Imported again from the original under the plan the log recorded.
                let path = match &source {
                    crate::project::OriginalSource::File(path) => path.clone(),
                    crate::project::OriginalSource::Entry {
                        archive,
                        offset,
                        size,
                    } => {
                        // A stored original is its bytes at an offset of the archive.
                        let uploads = self.workdir.join("uploads");
                        std::fs::create_dir_all(&uploads)?;
                        let path = uploads.join(&file_id);
                        let mut input = std::fs::File::open(archive)?;
                        std::io::Seek::seek(&mut input, std::io::SeekFrom::Start(*offset))?;
                        let mut out = std::fs::File::create(&path)?;
                        std::io::copy(&mut std::io::Read::take(input, *size), &mut out)?;
                        path
                    }
                };
                let job = format!("open_{dataset_id}");
                let imported = import_source(
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
                if let Some(note) = assumed_encoding_note(&spec)
                    && !notes.iter().any(|n| n.code == "TW-IMP-004")
                {
                    notes.insert(0, note);
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
            steps: Vec::new(),
            output_rows: restored.row_count,
            recipe: Value::Null,
            reread: false,
        });
        if let Some(d) = p.datasets.last_mut() {
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
            // Why the log cannot be replayed at all, as the TypeScript engine words it.
            let unreadable = if read.manifest.is_none() {
                Some("the manifest could not be read")
            } else if text.is_none() {
                Some("audit.jsonl is missing or unreadable")
            } else {
                None
            };
            checks.push(if let Some(why) = unreadable {
                fail("audit-chain", format!("The audit chain cannot be verified because {why}."), "TW-PRJ-002")
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
                next_step: 1,
                system_issues: Vec::new(),
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
                journal: None,
            };
            let replayed = if unreadable.is_some() {
                Replayed::default()
            } else {
                reopen.replay(&mut p, &log, &read, &manifest, &mut progress)?
            };
            let (stopped, from_cache, checks_restored, checks_ran) = (
                replayed.stopped,
                replayed.from_cache,
                replayed.checks_restored,
                replayed.checks_ran,
            );
            if let Some(why) = unreadable {
                checks.push(fail(
                    "replay-digest",
                    format!("The datasets cannot be rebuilt because {why}."),
                    "TW-PRJ-003",
                ));
            } else if let Some(why) = &stopped {
                checks.push(fail(
                    "replay-digest",
                    format!("Rebuilding the project stopped at audit {why}"),
                    "TW-PRJ-003",
                ));
            } else {
                // Each saved dataset rebuilt with its saved digests, then any the log builds that
                // the manifest does not list (replayChecks).
                let saved: Vec<Value> =
                    manifest["datasets"].as_array().cloned().unwrap_or_default();
                let target_fail = |detail: String, target: &str| {
                    crate::project::integrity(
                        "replay-digest",
                        false,
                        detail,
                        Some("TW-PRJ-003"),
                        Some(target),
                    )
                };
                let mut bad = Vec::new();
                for s in &saved {
                    let (id, name) = (
                        s["id"].as_str().unwrap_or(""),
                        s["name"].as_str().unwrap_or(""),
                    );
                    let Some(d) = p.datasets.iter().find(|d| d.id == id) else {
                        bad.push(target_fail(
                            format!("Dataset {id} ({name}) is not rebuilt by the audit log."),
                            id,
                        ));
                        continue;
                    };
                    progress("Comparing the dataset digests", 0);
                    let stages = d.stages()?;
                    let working = crate::export::dataset_digest(
                        &conn,
                        &quote_ident(&d.view),
                        !d.edits.is_empty(),
                        &out_columns(&stages.working),
                        d.visible_rows(),
                        threads,
                    )?;
                    let output = crate::export::dataset_digest(
                        &conn,
                        &quote_ident(&d.out_view()),
                        !d.edits.is_empty(),
                        &out_columns(&stages.output),
                        d.output_rows,
                        threads,
                    )?;
                    let what = if s["rowCount"].as_u64() != Some(d.row_count) {
                        Some(format!(
                            "{} rows instead of the {} saved",
                            d.row_count, s["rowCount"]
                        ))
                    } else if s["workingDigest"].as_str() != Some(working.as_str()) {
                        Some("working data that differs from the saved digest".to_string())
                    } else if s["outputDigest"].as_str() != Some(output.as_str()) {
                        Some("output data that differs from the saved digest".to_string())
                    } else {
                        None
                    };
                    if let Some(what) = what {
                        bad.push(target_fail(
                            format!("Rebuilding dataset {id} ({name}) gives {what}."),
                            id,
                        ));
                    }
                }
                for d in p
                    .datasets
                    .iter()
                    .filter(|d| !saved.iter().any(|s| s["id"] == d.id.as_str()))
                {
                    bad.push(target_fail(
                        format!(
                            "The audit log builds dataset {}, which the manifest does not list.",
                            d.id
                        ),
                        &d.id,
                    ));
                }
                if bad.is_empty() {
                    let n = saved.len();
                    let how = if from_cache == n {
                        "restored from their saved working data".to_string()
                    } else if from_cache == 0 {
                        "rebuilt from the originals and the audit log".to_string()
                    } else {
                        format!(
                            "rebuilt ({from_cache} from their saved working data, {} from the originals)",
                            n - from_cache
                        )
                    };
                    let issues = match (checks_restored, checks_ran) {
                        (0, 0) => String::new(),
                        (_, 0) => {
                            " Their issues were restored from the saved check results.".to_string()
                        }
                        (0, 1) => " The recorded check run ran again.".to_string(),
                        (0, r) => format!(" The {r} recorded check runs ran again."),
                        (k, r) => format!(
                            " The issues of {k} datasets were restored from the saved check results, and {r} recorded check runs ran again."
                        ),
                    };
                    let detail = if n == 0 {
                        "The project has no datasets to rebuild.".to_string()
                    } else {
                        format!(
                            "All {n} datasets were {how} and match their saved digests.{issues}"
                        )
                    };
                    checks.push(crate::project::integrity(
                        "replay-digest",
                        true,
                        detail,
                        None,
                        None,
                    ));
                } else {
                    checks.extend(bad);
                }
            }
            let read_only = checks.iter().any(|c| c["ok"] == false);
            p.read_only = read_only;
            p.system_issues = integrity_issues(&p, &checks);
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
