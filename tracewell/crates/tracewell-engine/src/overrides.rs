//! Detection overrides (decisions.ts overrideDraft, reducer.ts overrideSpec and overrideOutcome):
//! the user changes how a column or the whole file is read, and the dataset is planned again and,
//! where its values change, read again from the original, as the TypeScript engine does.
//!
//! Name, unit, role, time zone and coordinate system change only what the plan says, so the rows
//! stay as they are. Type, null markers and date format change values, so the original is parsed
//! again into the same rows. A reading setting (encoding, delimiter, decimal separator, header
//! rows, lines to skip) plans the whole file again and reads it into new rows.

use crate::csv::Note;
use crate::engine::{Dataset, assumed_encoding_note};
use crate::error::{EngineError, Result};
use crate::import::{EXCEPTIONS_SUFFIX, import_plan, import_source, quote_ident};
use crate::parse::Kind;
use crate::project::OriginalSource;
use crate::sniff::{Source, apply_overrides, plan_spec};
use crate::steps::StageColumn;
use duckdb::Connection;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// Properties that only change how a column is read, in the order an import lists a column's
/// overrides (OVERRIDE_ORDER).
pub const COLUMN_PROPERTIES: [&str; 7] = [
    "name",
    "type",
    "unit",
    "role",
    "nullMarkers",
    "dateFormat",
    "timezone",
];
/// Column properties that change the parsed values.
const VALUE_PROPERTIES: [&str; 3] = ["type", "nullMarkers", "dateFormat"];
/// Reading settings of delimited text that an import records as overrides (CSV_SETTINGS).
pub const CSV_SETTINGS: [&str; 5] = [
    "encoding",
    "delimiter",
    "decimalSeparator",
    "headerRows",
    "skipLines",
];
/// The order of a delimited file's detections, which is the order of its assumptions.
const DETECTION_ORDER: [&str; 7] = [
    "encoding",
    "delimiter",
    "quote",
    "skipLines",
    "headerRows",
    "decimalSeparator",
    "thousandsSeparator",
];
const LOGICAL_TYPES: [&str; 7] = [
    "string", "integer", "number", "boolean", "date", "datetime", "geometry",
];
const ROLES: [&str; 10] = [
    "measure",
    "id",
    "time",
    "latitude",
    "longitude",
    "easting",
    "northing",
    "geometry",
    "unit",
    "text",
];

pub fn is_column_property(property: &str) -> bool {
    COLUMN_PROPERTIES.contains(&property)
}

/// True when an override of `property` reads the file into a different set of rows.
pub fn changes_rows(property: &str) -> bool {
    !is_column_property(property) && property != "crs"
}

/// A value as JavaScript's JSON.stringify writes it in a message.
fn stringify(v: &Value) -> String {
    crate::canonical::canonical_json(v)
}

/// Refuses a value that no column could take (checkOverrideValue).
pub fn check_override_value(property: &str, value: &Value) -> Result<()> {
    let bad = |what: &str| {
        Err(EngineError::invalid(
            format!("{} is not a valid {what}.", stringify(value)),
            format!("Choose a valid {what}."),
        ))
    };
    let text = value.as_str();
    match property {
        "name" => match text {
            Some(t) if !crate::units::js_trim(t).is_empty() => Ok(()),
            _ => bad("column name"),
        },
        "type" => match text {
            Some(t) if LOGICAL_TYPES.contains(&t) => Ok(()),
            _ => bad("column type"),
        },
        "unit" => {
            if value.is_null() || text.is_some_and(|t| crate::units::get_unit(t).is_some()) {
                Ok(())
            } else {
                Err(EngineError::new(
                    "UNIT_UNKNOWN",
                    format!("The unit {} is not in the unit registry.", stringify(value)),
                    "Choose a unit from the list.",
                ))
            }
        }
        "role" => match text {
            Some(t) if ROLES.contains(&t) => Ok(()),
            _ => bad("column role"),
        },
        "nullMarkers" => match value.as_array() {
            Some(a) if a.iter().all(Value::is_string) => Ok(()),
            _ => bad("list of null markers"),
        },
        "dateFormat" => match text {
            Some("iso" | "dmy" | "mdy" | "ymd-slash" | "excel-serial") => Ok(()),
            _ => bad("date format"),
        },
        "timezone" => match text {
            Some("utc" | "offset" | "naive-assumed-utc") => Ok(()),
            _ => bad("time zone setting"),
        },
        "crs" => {
            if value.is_object() && value["code"].is_string() {
                Ok(())
            } else {
                bad("coordinate reference system")
            }
        }
        _ => Ok(()),
    }
}

/// The reading options with one setting changed (withOption); a new encoding drops the byte-order
/// mark, which the new encoding detects again.
pub fn with_option(options: &Value, property: &str, value: &Value) -> Result<Value> {
    let format = options["format"].as_str().unwrap_or("");
    let unsupported = || {
        EngineError::invalid(
            format!(
                "The setting \"{property}\" does not apply to {} files.",
                format.to_uppercase()
            ),
            "Choose a setting that applies to this file.",
        )
    };
    if format != "csv" && format != "tsv" {
        return Err(unsupported());
    }
    if !CSV_SETTINGS.contains(&property) {
        return Err(unsupported());
    }
    let mut next = options.clone();
    next["csv"][property] = value.clone();
    if property == "encoding" {
        next["csv"]["bomLength"] = json!(0);
    }
    Ok(next)
}

/// The setting's current value (current()).
pub fn current_option(options: &Value, property: &str) -> Value {
    match options["format"].as_str() {
        Some("csv" | "tsv") => options["csv"].get(property).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// True when the dataset has edits, exclusions or steps that a re-read into new rows would lose.
pub fn has_work(d: &Dataset) -> bool {
    !d.edits.is_empty() || d.excluded.count() > 0 || !d.steps.is_empty()
}

pub fn require_no_work(d: &Dataset, property: &str) -> Result<()> {
    if !has_work(d) {
        return Ok(());
    }
    Err(EngineError::invalid(
        format!(
            "Changing the {property} reads the file into different rows, and this dataset already has edits, exclusions or steps."
        ),
        "Import the file again as a new dataset with this setting, so the existing work is kept.",
    ))
}

/// A value the user set through audit entry `seq` (userDetection): never assumed.
pub fn user_detection(value: Value, seq: u64) -> Value {
    json!({
        "value": value,
        "confidence": "high",
        "assumed": false,
        "source": "user",
        "method": "user-override",
        "evidence": format!("Set by the user in audit entry {seq}."),
        "overriddenBy": seq,
    })
}

/// The `old` value of an override: what the dataset reads now.
pub fn old_value(d: &Dataset, property: &str, column: Option<&str>) -> Result<Value> {
    if is_column_property(property) {
        let plan = d.spec["columns"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| column.is_some() && c["id"].as_str() == column)
            .ok_or_else(|| {
                EngineError::not_found(
                    format!(
                        "Dataset {} has no column {}.",
                        d.id,
                        column.unwrap_or("undefined")
                    ),
                    "Choose a listed column.",
                )
            })?;
        return Ok(if property == "name" {
            plan["name"].clone()
        } else {
            plan.get(property)
                .map(|d| d["value"].clone())
                .unwrap_or(Value::Null)
        });
    }
    if property == "crs" {
        return Ok(d.spec["crs"]["value"].clone());
    }
    require_no_work(d, property)?;
    with_option(&d.spec["options"], property, &Value::Null)?;
    Ok(current_option(&d.spec["options"], property))
}

/// Every assumed detection of a spec, the file's first in the order the TypeScript lists them.
pub fn spec_assumptions(dataset_id: &str, spec: &Value) -> Vec<Value> {
    let detections = spec["detections"].as_object().cloned().unwrap_or_default();
    let mut keys: Vec<&str> = DETECTION_ORDER
        .iter()
        .copied()
        .filter(|k| detections.contains_key(*k))
        .collect();
    let mut rest: Vec<&str> = detections
        .keys()
        .map(String::as_str)
        .filter(|k| !DETECTION_ORDER.contains(k))
        .collect();
    rest.sort_unstable();
    keys.extend(rest);
    let mut extra: Vec<(&str, &Value)> = keys.iter().map(|k| (*k, &detections[*k])).collect();
    if !spec["crs"].is_null() {
        extra.push(("crs", &spec["crs"]));
    }
    let columns = spec["columns"].as_array().cloned().unwrap_or_default();
    crate::detect::collect_assumptions(dataset_id, &columns, &extra)
}

/// The original file to read again: a file on disk, or the bytes of a stored project entry,
/// copied out once.
pub fn original_file(source: &OriginalSource, workdir: &Path, file_id: &str) -> Result<PathBuf> {
    match source {
        OriginalSource::File(path) => Ok(path.clone()),
        OriginalSource::Entry {
            archive,
            offset,
            size,
        } => {
            let uploads = workdir.join("uploads");
            std::fs::create_dir_all(&uploads)?;
            let path = uploads.join(file_id);
            if std::fs::metadata(&path).is_ok_and(|m| m.len() == *size) {
                return Ok(path);
            }
            let mut input = std::fs::File::open(archive)?;
            std::io::Seek::seek(&mut input, std::io::SeekFrom::Start(*offset))?;
            let mut out = std::fs::File::create(&path)?;
            std::io::copy(&mut std::io::Read::take(input, *size), &mut out)?;
            Ok(path)
        }
    }
}

/// Where a dataset's original is and what the engine may use to read it again.
pub struct ReadEnv<'a> {
    pub workdir: &'a Path,
    pub threads: usize,
}

/// Data read again under the new plan.
pub struct Reread {
    pub rows_file: PathBuf,
    pub exceptions_file: PathBuf,
    pub row_count: u64,
    pub notes: Vec<Note>,
}

/// What an override makes of a dataset, worked out before its entry is appended, so a file that
/// cannot be read that way leaves no entry behind.
pub struct Outcome {
    pub spec: Value,
    pub columns: Vec<(String, Kind)>,
    pub assumptions: Vec<Value>,
    pub reread: Option<Reread>,
    pub rows_change: bool,
}

/// The override's property, column and value, from its entry, or from the entry a revert undoes
/// with the value that entry replaced.
pub fn override_of(e: &Value, reverted: Option<&Value>) -> Option<(String, Option<String>, Value)> {
    let (source, value) = match e["action"].as_str() {
        Some("detection.override") => (e, e["new"].clone()),
        Some("entry.revert") => {
            let t = reverted.filter(|t| t["action"] == "detection.override")?;
            (t, t["old"].clone())
        }
        _ => return None,
    };
    Some((
        source["payload"]["property"].as_str()?.to_string(),
        source["target"]["columnId"].as_str().map(String::from),
        value,
    ))
}

/// Plans and, where values change, reads the dataset again as entry `seq` says (overrideSpec and
/// overrideOutcome).
#[allow(clippy::too_many_arguments)]
pub fn outcome(
    conn: &Connection,
    d: &Dataset,
    original: &Path,
    original_name: &str,
    env: &ReadEnv,
    project_dir: &Path,
    property: &str,
    column: Option<&str>,
    value: &Value,
    seq: u64,
) -> Result<Outcome> {
    let mut spec = d.spec.clone();
    if property == "crs" {
        spec["crs"] = user_detection(value.clone(), seq);
    } else if is_column_property(property) {
        let mut o = Map::new();
        o.insert("columnId".into(), json!(column.unwrap_or("")));
        o.insert(property.into(), value.clone());
        let columns = spec["columns"].as_array().cloned().unwrap_or_default();
        let mut columns = apply_overrides(columns, &[Value::Object(o)])?;
        if property != "name" {
            for c in columns.iter_mut().filter(|c| c["id"].as_str() == column) {
                if let Some(v) = c.get(property).map(|d| d["value"].clone()) {
                    c[property] = user_detection(v, seq);
                }
            }
        }
        spec["columns"] = Value::from(columns);
    } else {
        let options = with_option(&spec["options"], property, value)?;
        let src = Source {
            path: original,
            name: original_name,
            size: std::fs::metadata(original)?.len(),
        };
        let mut planned = plan_spec(conn, &src, &options)?;
        planned["fileId"] = spec["fileId"].clone();
        planned["datasetName"] = spec["datasetName"].clone();
        spec = planned;
    }
    let plan = import_plan(&spec)?;
    let columns: Vec<(String, Kind)> = plan
        .columns
        .iter()
        .map(|c| (c.id.clone(), c.kind))
        .collect();
    // What the native engine cannot represent is refused rather than read differently: an edit
    // is stored in its column's storage type.
    let stored = |cols: &[(String, Kind)]| {
        cols.iter()
            .find(|(c, _)| Some(c.as_str()) == column)
            .map(|(_, k)| crate::import::sql_type(*k))
    };
    if property == "type"
        && d.edits.keys().any(|(c, _)| Some(c.as_str()) == column)
        && stored(&d.columns) != stored(&columns)
    {
        return Err(EngineError::unsupported(
            "changing how a column with edits is stored",
        ));
    }
    let base: Vec<StageColumn> = spec["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .zip(&columns)
        .map(|(c, (_, kind))| StageColumn {
            schema: c.clone(),
            kind: *kind,
        })
        .collect();
    if !changes_rows(property)
        && !d.steps.is_empty()
        && crate::steps::build(&base, &d.steps).is_err()
    {
        let later = (0..d.steps.len())
            .find(|&i| crate::steps::build(&base, &d.steps[..=i]).is_err())
            .and_then(|i| d.steps[i]["id"].as_str().map(String::from))
            .unwrap_or_else(|| "a later step".into());
        return Err(EngineError::invalid(
            format!("Changing the {property} would break step {later}, which uses this column."),
            format!("Remove step {later} first."),
        ));
    }
    let reread = if changes_rows(property) || VALUE_PROPERTIES.contains(&property) {
        let job = format!("ovr_{}_{seq}", d.id);
        std::fs::create_dir_all(project_dir)?;
        let imported = import_source(
            conn,
            original,
            &plan,
            &job,
            project_dir,
            env.threads,
            &AtomicBool::new(false),
            &mut |_| {},
        )?;
        conn.execute_batch(&format!(
            "DROP VIEW IF EXISTS {}; DROP VIEW IF EXISTS {};",
            quote_ident(&imported.view),
            quote_ident(&format!("{}{EXCEPTIONS_SUFFIX}", imported.view)),
        ))?;
        if spec["fileId"].as_str() != Some(imported.sha256.as_str()) {
            return Err(EngineError::invalid(
                format!(
                    "The file {} is not the file this import was planned for (its SHA-256 differs).",
                    spec["fileName"].as_str().unwrap_or_default()
                ),
                "Import the file again so the plan matches its contents.",
            ));
        }
        let mut notes = imported.notes;
        if let Some(note) = assumed_encoding_note(&spec)
            && !notes.iter().any(|n| n.code == "TW-IMP-004")
        {
            notes.insert(0, note);
        }
        Some(Reread {
            rows_file: project_dir.join(format!("{job}.parquet")),
            exceptions_file: project_dir.join(format!("{job}{EXCEPTIONS_SUFFIX}.parquet")),
            row_count: imported.row_count,
            notes,
        })
    } else {
        None
    };
    Ok(Outcome {
        assumptions: spec_assumptions(&d.id, &spec),
        spec,
        columns,
        reread,
        rows_change: changes_rows(property),
    })
}
