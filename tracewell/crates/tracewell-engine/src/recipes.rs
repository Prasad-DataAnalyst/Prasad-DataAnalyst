//! Recipes (FR-RCP-01..03), as the TypeScript src/engine/recipes.ts builds, reads and plans them.
//! A recipe names the columns its steps use as they were imported; on another dataset each is
//! found by name among its imported columns and must have the same type and unit. Steps are
//! checked one after another against the dataset as the earlier ones leave it, so a recipe that
//! does not fit is refused before anything changes.

use crate::canonical::sha256_hex;
use crate::error::{EngineError, Result};
use crate::steps::StageColumn;
use serde_json::{Value, json};

/// The recipe of the same name keeps its ID through every version.
pub fn recipe_id(name: &str) -> String {
    format!("rcp_{}", &sha256_hex(name.as_bytes())[..12])
}

/// The base column of a column ID: 'c4' for 'c4' and for the converted 'c4~kPa'.
fn base_of(id: &str) -> (&str, &str) {
    match id.find('~') {
        Some(i) => (&id[..i], &id[i..]),
        None => (id, ""),
    }
}

fn predicate_columns(p: &Value, out: &mut Vec<String>) {
    for key in ["all", "any"] {
        if let Some(parts) = p.get(key).and_then(Value::as_array) {
            for x in parts {
                predicate_columns(x, out);
            }
            return;
        }
    }
    if let Some(inner) = p.get("not") {
        predicate_columns(inner, out);
    } else if let Some(g) = p.get("geometry").and_then(Value::as_str) {
        out.push(g.to_string());
    } else if let (Some(lat), Some(lon)) = (p["lat"].as_str(), p["lon"].as_str()) {
        out.push(lat.to_string());
        out.push(lon.to_string());
    } else if let Some(c) = p["column"].as_str() {
        out.push(c.to_string());
    }
}

fn step_columns(s: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match s["kind"].as_str() {
        Some("convert_unit") => out.extend(s["columnId"].as_str().map(String::from)),
        Some("filter") => predicate_columns(&s["predicate"], &mut out),
        _ => out.extend(
            s["columnIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c.as_str().map(String::from)),
        ),
    }
    out
}

fn map_predicate(p: &Value, f: &dyn Fn(&str) -> String) -> Value {
    for key in ["all", "any"] {
        if let Some(parts) = p.get(key).and_then(Value::as_array) {
            return json!({ key: parts.iter().map(|x| map_predicate(x, f)).collect::<Vec<_>>() });
        }
    }
    if let Some(inner) = p.get("not") {
        return json!({ "not": map_predicate(inner, f) });
    }
    let mut out = p.clone();
    for key in ["geometry", "lat", "lon", "column"] {
        if let Some(c) = p.get(key).and_then(Value::as_str) {
            out[key] = json!(f(c));
        }
    }
    out
}

/// The step with every column ID passed through `f` (mapStepColumns).
pub fn map_step_columns(s: &Value, f: &dyn Fn(&str) -> String) -> Value {
    let mut out = s.clone();
    match s["kind"].as_str() {
        Some("convert_unit") => out["columnId"] = json!(f(s["columnId"].as_str().unwrap_or(""))),
        Some("filter") => out["predicate"] = map_predicate(&s["predicate"], f),
        _ => {
            out["columnIds"] = s["columnIds"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| json!(f(c.as_str().unwrap_or(""))))
                .collect();
        }
    }
    out
}

fn issue_key(rule: &str, columns: &[String]) -> String {
    format!("{rule}\u{0}{}", columns.join("\u{1}"))
}

fn names_of(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|c| c.as_str().unwrap_or("").to_string())
        .collect()
}

/// The dataset's issues as a baseline: rule, column names, severity and count, no values.
pub fn baseline_of(issues: &[Value], name: &dyn Fn(&str) -> String) -> Vec<Value> {
    let mut out: Vec<(String, Value)> = issues
        .iter()
        .map(|i| {
            let columns: Vec<String> = names_of(&i["columns"]).iter().map(|c| name(c)).collect();
            let rule = i["ruleId"].as_str().unwrap_or("").to_string();
            (
                issue_key(&rule, &columns),
                json!({ "ruleId": rule, "columns": columns, "severity": i["severity"], "flagged": i["counts"]["flagged"] }),
            )
        })
        .collect();
    out.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    out.into_iter().map(|(_, v)| v).collect()
}

/// What a recipe is built from.
pub struct Source<'a> {
    pub dataset_name: &'a str,
    /// The dataset's columns as imported.
    pub base: &'a [StageColumn],
    pub steps: &'a [Value],
    pub check_packs: &'a [Value],
    pub row_count: u64,
    /// The dataset's issues as the protocol carries them.
    pub issues: &'a [Value],
    pub name: &'a dyn Fn(&str) -> String,
}

/// A recipe of the dataset's steps, checks and issues (buildRecipe).
#[allow(clippy::too_many_arguments)]
pub fn build(
    src: &Source,
    name: &str,
    version: u64,
    saved_at: &str,
    saved_by: &Value,
    app_version: &str,
    export: Value,
) -> Result<Value> {
    let steps: Vec<Value> = src
        .steps
        .iter()
        .map(|s| {
            let mut input = s.clone();
            if let Some(o) = input.as_object_mut() {
                o.remove("id");
                o.remove("seq");
            }
            input
        })
        .collect();
    let mut keys: Vec<String> = Vec::new();
    for c in steps.iter().flat_map(step_columns) {
        let base = base_of(&c).0.to_string();
        if !keys.contains(&base) {
            keys.push(base);
        }
    }
    let columns = keys
        .iter()
        .map(|key| {
            let c = src.base.iter().find(|c| c.id() == key).ok_or_else(|| {
                EngineError::internal(format!(
                    "Step column {key} is not in {}.",
                    src.dataset_name
                ))
            })?;
            Ok(json!({ "key": key, "name": c.schema["name"], "type": c.schema["type"]["value"], "unit": c.schema["unit"]["value"] }))
        })
        .collect::<Result<Vec<_>>>()?;
    let checked = !src.check_packs.is_empty();
    Ok(json!({
        "format": "tracewell-recipe",
        "formatVersion": 1,
        "id": recipe_id(name),
        "name": name,
        "version": version,
        "savedAt": saved_at,
        "savedBy": saved_by,
        "appVersion": app_version,
        "columns": columns,
        "check": if checked { json!({ "packs": src.check_packs }) } else { Value::Null },
        "steps": steps,
        "export": export,
        "baseline": if checked {
            json!({ "rows": src.row_count, "issues": baseline_of(src.issues, src.name) })
        } else {
            Value::Null
        },
    }))
}

/// 'Name v3.twr', with characters no file system accepts in a name, and control characters, as '_'.
pub fn file_name(recipe: &Value) -> String {
    let stem: String = recipe["name"]
        .as_str()
        .unwrap_or("")
        .chars()
        .map(|ch| {
            if ch < ' ' || "\\/:*?\"<>|".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let stem = stem.trim_matches(crate::units::is_js_space);
    format!(
        "{} v{}.twr",
        if stem.is_empty() { "recipe" } else { stem },
        recipe["version"]
    )
}

pub fn bytes(recipe: &Value) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(recipe).unwrap_or_default();
    text.push('\n');
    text.into_bytes()
}

fn fix() -> &'static str {
    "Choose a .twr file saved by Tracewell, or ask its author to save it again."
}

fn shape_problem(r: &Value) -> Option<String> {
    let is_str = |v: &Value| v.is_string();
    let str_or_null = |v: &Value| v.is_string() || v.is_null();
    if r["format"] != "tracewell-recipe" {
        return Some("format: it is not a Tracewell recipe".into());
    }
    if r["formatVersion"] != 1 {
        return Some("formatVersion: this version of Tracewell reads format 1".into());
    }
    for k in ["id", "name", "savedAt", "savedBy", "appVersion"] {
        if !is_str(&r[k]) {
            return Some(format!("{k}: text is required"));
        }
    }
    if !r["version"].as_u64().is_some_and(|v| v >= 1) {
        return Some("version: a whole number of at least 1 is required".into());
    }
    let columns_ok = r["columns"].as_array().is_some_and(|cs| {
        cs.iter().all(|c| {
            is_str(&c["key"]) && is_str(&c["name"]) && is_str(&c["type"]) && str_or_null(&c["unit"])
        })
    });
    if !columns_ok {
        return Some("columns: each needs a key, a name, a type and a unit".into());
    }
    if !r["check"].is_null() && !r["check"]["packs"].is_array() {
        return Some("check: the rule packs are missing".into());
    }
    if !r["steps"]
        .as_array()
        .is_some_and(|s| s.iter().all(|x| x["kind"].is_string()))
    {
        return Some("steps: each step needs a kind".into());
    }
    if !r["export"].is_null()
        && !(is_str(&r["export"]["profile"]) && r["export"]["neutralizeFormulas"].is_boolean())
    {
        return Some("export: a profile and the formula setting are required".into());
    }
    if !r["baseline"].is_null()
        && !(r["baseline"]["rows"].is_u64() && r["baseline"]["issues"].is_array())
    {
        return Some("baseline: the row count and the issues are required".into());
    }
    None
}

/// Reads a .twr file (parseRecipe); anything that is not a valid recipe is refused with what is
/// wrong.
pub fn parse(bytes: &[u8], file_name: &str) -> Result<Value> {
    let doc: Value = std::str::from_utf8(bytes)
        .ok()
        .and_then(|t| serde_json::from_str(t).ok())
        .ok_or_else(|| {
            EngineError::new(
                "FORMAT_UNSUPPORTED",
                format!("{file_name} is not a Tracewell recipe: it is not JSON text."),
                fix(),
            )
        })?;
    if let Some(problem) = shape_problem(&doc) {
        let (path, message) = problem.split_once(": ").unwrap_or(("", problem.as_str()));
        return Err(EngineError::new(
            "FORMAT_UNSUPPORTED",
            format!("{file_name} is not a valid Tracewell recipe at {path}: {message}."),
            fix(),
        ));
    }
    let name = doc["name"].as_str().unwrap_or("");
    if doc["id"] != recipe_id(name).as_str() {
        return Err(EngineError::new(
            "FORMAT_UNSUPPORTED",
            format!(
                "{file_name} has an ID that does not belong to its name \"{name}\", so it was changed by hand."
            ),
            fix(),
        ));
    }
    Ok(doc)
}

/// How the recipe maps onto a dataset, and the steps as they would be applied there (planRecipe).
/// `available` are the rule packs this engine checks with.
pub fn plan(
    recipe: &Value,
    dataset_id: &str,
    dataset_name: &str,
    base: &[StageColumn],
    applied: &[Value],
    available: &[Value],
) -> (Value, Vec<Value>) {
    let mut problems: Vec<String> = Vec::new();
    for p in recipe["check"]["packs"].as_array().into_iter().flatten() {
        let known = available.iter().any(|a| {
            a["id"] == p["id"] && a["version"] == p["version"] && a["sha256"] == p["sha256"]
        });
        if !known {
            problems.push(format!(
                "The recipe checks with the rule pack {} {}, which this copy of Tracewell does not have, so its checks cannot be repeated.",
                p["id"].as_str().unwrap_or(""),
                p["version"].as_str().unwrap_or("")
            ));
        }
    }
    let mut target: Vec<(String, String)> = Vec::new();
    let columns: Vec<Value> = recipe["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|rc| {
            let name = rc["name"].as_str().unwrap_or("");
            let typ = rc["type"].as_str().unwrap_or("");
            let c = base
                .iter()
                .find(|c| c.derived_from().is_none() && c.schema["name"] == name);
            let problem = match c {
                None => Some(format!("{dataset_name} has no column named \"{name}\".")),
                Some(c) if c.schema["type"]["value"] != typ => Some(format!(
                    "\"{name}\" holds {} values here, {typ} in the recipe.",
                    c.schema["type"]["value"].as_str().unwrap_or("")
                )),
                Some(c) if c.schema["unit"]["value"] != rc["unit"] => Some(format!(
                    "\"{name}\" is in {} here, {} in the recipe; its thresholds and conversions would mean something else.",
                    c.schema["unit"]["value"].as_str().unwrap_or("no unit"),
                    rc["unit"].as_str().unwrap_or("no unit")
                )),
                Some(_) => None,
            };
            if let Some(p) = &problem {
                problems.push(p.clone());
            }
            if let (Some(c), None) = (c, &problem) {
                target.push((rc["key"].as_str().unwrap_or("").to_string(), c.id().to_string()));
            }
            json!({ "key": rc["key"], "name": name, "columnId": c.map(|c| c.id()), "problem": problem })
        })
        .collect();
    let mut steps = Vec::new();
    let mut descriptions = Vec::new();
    if problems.is_empty() {
        let map = |id: &str| -> String {
            let (base_id, suffix) = base_of(id);
            let mapped = target
                .iter()
                .find(|(k, _)| k == base_id)
                .map_or(base_id, |(_, c)| c.as_str());
            format!("{mapped}{suffix}")
        };
        let mut so_far: Vec<Value> = applied.to_vec();
        for (i, raw) in recipe["steps"].as_array().into_iter().flatten().enumerate() {
            let input = map_step_columns(raw, &map);
            let checked = crate::steps::build(base, &so_far)
                .and_then(|stages| crate::steps::validate(&input, &stages).map(|()| stages));
            let stages = match checked {
                Ok(s) => s,
                Err(e) => {
                    problems.push(format!("Step {} cannot be applied: {}", i + 1, e.message));
                    break;
                }
            };
            let seen = if input["kind"] == "convert_unit" {
                &stages.working
            } else {
                &stages.output
            };
            descriptions.push(crate::steps::describe(&input, seen));
            let mut placed = input.clone();
            placed["id"] = json!(format!("s_plan_{i}"));
            placed["seq"] = json!(1);
            so_far.push(placed);
            steps.push(input);
        }
    }
    let fits = problems.is_empty();
    (
        json!({
            "recipe": recipe,
            "datasetId": dataset_id,
            "columns": columns,
            "steps": descriptions,
            "problems": problems,
            "fits": fits,
        }),
        steps,
    )
}

/// An issue compared with a baseline: new, changed (another count) or unchanged (deltaOf).
pub fn delta_of(issue: &Value, names: &[String], baseline: &[Value]) -> Value {
    let key = issue_key(issue["ruleId"].as_str().unwrap_or(""), names);
    match baseline
        .iter()
        .find(|b| issue_key(b["ruleId"].as_str().unwrap_or(""), &names_of(&b["columns"])) == key)
    {
        None => json!({ "state": "new", "previous": null }),
        Some(b) => json!({
            "state": if b["flagged"] == issue["counts"]["flagged"] { "unchanged" } else { "changed" },
            "previous": b["flagged"],
        }),
    }
}

/// Baseline issues no current issue matches: what the new data no longer has (resolvedSince).
pub fn resolved_since(current: &[Value], baseline: &[Value]) -> Vec<Value> {
    let now: Vec<String> = current
        .iter()
        .map(|c| issue_key(c["ruleId"].as_str().unwrap_or(""), &names_of(&c["columns"])))
        .collect();
    baseline
        .iter()
        .filter(|b| {
            !now.contains(&issue_key(
                b["ruleId"].as_str().unwrap_or(""),
                &names_of(&b["columns"]),
            ))
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_names_and_files_follow_the_typescript_rules() {
        assert!(recipe_id("Monthly wells").starts_with("rcp_"));
        assert_eq!(recipe_id("Monthly wells").len(), 16);
        assert_eq!(
            file_name(&json!({ "name": " A/B: x ", "version": 3 })),
            "A_B_ x v3.twr"
        );
        assert_eq!(
            file_name(&json!({ "name": "   ", "version": 1 })),
            "recipe v1.twr"
        );
        let mapped = map_step_columns(
            &json!({ "kind": "filter", "predicate": { "all": [{ "column": "c4~kPa", "op": "is_null" }, { "not": { "column": "c1", "op": "is_null" } }] } }),
            &|c| c.replace("c4", "c9"),
        );
        assert_eq!(mapped["predicate"]["all"][0]["column"], "c9~kPa");
        assert_eq!(mapped["predicate"]["all"][1]["not"]["column"], "c1");
    }

    #[test]
    fn a_recipe_with_a_changed_id_is_refused() {
        let mut r = json!({
            "format": "tracewell-recipe", "formatVersion": 1, "id": recipe_id("A"), "name": "A", "version": 1,
            "savedAt": "2026-01-01T00:00:00.000Z", "savedBy": "Prasad", "appVersion": "0.1.0", "columns": [],
            "check": null, "steps": [], "export": null, "baseline": null
        });
        assert!(parse(&bytes(&r), "a.twr").is_ok());
        r["name"] = json!("B");
        assert!(
            parse(&bytes(&r), "a.twr")
                .err()
                .is_some_and(|e| e.message.contains("changed by hand"))
        );
        assert!(
            parse(b"not json", "a.twr")
                .err()
                .is_some_and(|e| e.code == "FORMAT_UNSUPPORTED")
        );
    }
}
