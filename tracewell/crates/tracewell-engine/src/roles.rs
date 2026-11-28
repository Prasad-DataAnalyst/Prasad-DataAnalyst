//! Local profiles, roles and review (FR-AUD-03, FR-AUD-04, SAD decision D-18), as
//! model/review.ts defines them: what each role may do, the refusal when it may not, and the
//! sign-off stamps the log holds.

use crate::error::{EngineError, Result};
use crate::units::is_js_space;
use serde_json::{Value, json};
use std::collections::HashMap;

pub const ROLES: [&str; 3] = ["Analyst", "Reviewer", "Viewer"];

/// The longest assignee name, in UTF-16 code units.
pub const ASSIGNEE_MAX_LENGTH: usize = 100;

/// Every operation a role can be refused: what it is, and the roles that may do it (OPERATIONS).
const OPERATIONS: [(&str, &str, &[&str]); 22] = [
    ("create_project", "create projects", &["Analyst"]),
    ("import", "import files", &["Analyst"]),
    ("check", "run checks", &["Analyst"]),
    ("apply_step", "apply steps", &["Analyst"]),
    ("remove_step", "remove steps", &["Analyst"]),
    ("run_recipe", "run recipes", &["Analyst"]),
    ("save_recipe", "save recipes", &["Analyst"]),
    ("export", "export data", &["Analyst"]),
    ("install_rulepack", "install rule-packs", &["Analyst"]),
    ("save_template", "save mapping templates", &["Analyst"]),
    ("delete_template", "delete mapping templates", &["Analyst"]),
    ("save", "save the project", &["Analyst", "Reviewer"]),
    ("edit_cell", "edit cells", &["Analyst"]),
    ("accept_issue", "accept issues", &["Analyst"]),
    ("exclude_rows", "exclude rows", &["Analyst"]),
    (
        "comment_issue",
        "comment on issues",
        &["Analyst", "Reviewer"],
    ),
    ("assign_issue", "assign issues", &["Analyst", "Reviewer"]),
    ("sign_off", "sign off datasets", &["Reviewer"]),
    ("override_detection", "override detections", &["Analyst"]),
    ("set_project_area", "set the project area", &["Analyst"]),
    ("set_conventions", "set the conventions", &["Analyst"]),
    ("revert", "revert changes", &["Analyst"]),
];

/// The decisions, each the operation of its own name (DECISION_OPERATIONS).
const DECISION_KINDS: [&str; 10] = [
    "edit_cell",
    "accept_issue",
    "exclude_rows",
    "comment_issue",
    "assign_issue",
    "sign_off",
    "override_detection",
    "set_project_area",
    "set_conventions",
    "revert",
];

/// The operation a decision is, by its kind; None for a kind that is not a decision.
pub fn decision_operation(kind: &str) -> Option<&'static str> {
    DECISION_KINDS.iter().find(|k| **k == kind).copied()
}

fn article(role: &str) -> &'static str {
    if role == "Analyst" { "an" } else { "a" }
}

/// The refusal of an operation the profile's role may not do (roleRefusal), or None when it may.
pub fn refusal(profile: &Value, op: &str) -> Option<EngineError> {
    let (_, what, roles) = OPERATIONS.iter().find(|(o, _, _)| *o == op)?;
    let role = profile["role"].as_str().unwrap_or("");
    if roles.contains(&role) {
        return None;
    }
    let name = profile["name"].as_str().unwrap_or("");
    Some(EngineError::new(
        "ROLE_NOT_ALLOWED",
        format!(
            "{name} is working as {} {role}, who cannot {what}.",
            article(role)
        ),
        format!(
            "Switch to {} {} profile to {what}.",
            article(roles[0]),
            roles.join(" or ")
        ),
    ))
}

/// A profile as the engines take it (checkedProfile): an id, a name and a role, the name trimmed.
pub fn checked_profile(p: &Value) -> Result<Value> {
    let id = p["id"].as_str().unwrap_or("");
    let name = p["name"].as_str().unwrap_or("").trim_matches(is_js_space);
    let role = p["role"].as_str().filter(|r| ROLES.contains(r));
    match role {
        Some(role) if !id.is_empty() && !name.is_empty() => {
            Ok(json!({ "id": id, "name": name, "role": role }))
        }
        _ => Err(EngineError::invalid(
            "The user profile is incomplete.",
            "Pass a profile with an id, a name and a role: Analyst, Reviewer or Viewer.",
        )),
    }
}

/// Entries that change a dataset's data or issues, and with them what a sign-off covered.
const CHANGES: [&str; 10] = [
    "source.add",
    "detection.assume",
    "detection.override",
    "check.run",
    "cell.edit",
    "rows.exclude",
    "issue.accept",
    "step.apply",
    "step.remove",
    "recipe.apply",
];

enum Touched {
    All,
    Datasets(Vec<String>),
}

fn touched(e: &Value, by_seq: &HashMap<u64, &Value>) -> Touched {
    let action = e["action"].as_str().unwrap_or("");
    if action == "project.area" {
        return Touched::All;
    }
    if action == "entry.revert" {
        return match e["target"]["seq"].as_u64().and_then(|s| by_seq.get(&s)) {
            Some(target) => touched(target, by_seq),
            None => Touched::Datasets(Vec::new()),
        };
    }
    match e["target"]["datasetId"].as_str() {
        Some(id) if CHANGES.contains(&action) => Touched::Datasets(vec![id.to_string()]),
        _ => Touched::Datasets(Vec::new()),
    }
}

/// Every dataset's sign-offs from the log alone (signOffsOf): a dataset.signoff entry stamps its
/// dataset, and the first later entry that changes the dataset's data or issues is recorded on
/// each stamp it supersedes.
pub fn sign_offs(entries: &[Value]) -> HashMap<String, Vec<Value>> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    let mut by_seq: HashMap<u64, &Value> = HashMap::new();
    for e in entries {
        let seq = e["seq"].as_u64().unwrap_or(0);
        let dataset = e["target"]["datasetId"].as_str();
        if e["action"] == "dataset.signoff" && e["actor"]["kind"] == "user" && dataset.is_some() {
            out.entry(dataset.unwrap_or_default().to_string())
                .or_default()
                .push(json!({
                    "seq": seq,
                    "at": e["at"],
                    "by": { "profileId": e["actor"]["profileId"], "name": e["actor"]["name"], "role": e["actor"]["role"] },
                    "status": e["new"]["status"],
                    "statement": e["reason"].as_str().unwrap_or(""),
                    "changedSeq": null,
                }));
        } else {
            let t = touched(e, &by_seq);
            for (id, list) in out.iter_mut() {
                if let Touched::Datasets(ids) = &t
                    && !ids.contains(id)
                {
                    continue;
                }
                for s in list.iter_mut().filter(|s| s["changedSeq"].is_null()) {
                    s["changedSeq"] = json!(seq);
                }
            }
        }
        by_seq.insert(seq, e);
    }
    out
}

/// A sign-off in one line, as an export's README states it (signOffText).
pub fn sign_off_text(s: &Value) -> String {
    let verdict = if s["status"] == "approved" {
        "approved"
    } else {
        "changes requested"
    };
    let since = match s["changedSeq"].as_u64() {
        None => "the dataset has not changed since".to_string(),
        Some(seq) => format!("the dataset changed after it, at entry {seq}"),
    };
    format!(
        "{verdict} by {} ({}) at {}, entry {}; {since}",
        s["by"]["name"].as_str().unwrap_or(""),
        s["by"]["role"].as_str().unwrap_or(""),
        s["at"].as_str().unwrap_or(""),
        s["seq"]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_as_the_typescript_role_table_does() {
        let jane = json!({ "id": "u_jane", "name": "Jane", "role": "Reviewer" });
        let e = refusal(&jane, "edit_cell").unwrap();
        assert_eq!(e.code, "ROLE_NOT_ALLOWED");
        assert_eq!(
            e.message,
            "Jane is working as a Reviewer, who cannot edit cells."
        );
        assert_eq!(e.fix, "Switch to an Analyst profile to edit cells.");
        assert!(refusal(&jane, "sign_off").is_none());
        let sam = json!({ "id": "u_sam", "name": "Sam", "role": "Viewer" });
        assert_eq!(
            refusal(&sam, "comment_issue").unwrap().fix,
            "Switch to an Analyst or Reviewer profile to comment on issues."
        );
        let prasad = json!({ "id": "u_p", "name": "Prasad", "role": "Analyst" });
        assert_eq!(
            refusal(&prasad, "sign_off").unwrap().message,
            "Prasad is working as an Analyst, who cannot sign off datasets."
        );
        assert_eq!(decision_operation("sign_off"), Some("sign_off"));
        assert_eq!(decision_operation("import"), None);
        assert_eq!(decision_operation("no_such_kind"), None);
        assert_eq!(
            checked_profile(&json!({ "id": "u", "name": " J ", "role": "Viewer" })).unwrap(),
            json!({ "id": "u", "name": "J", "role": "Viewer" })
        );
        assert!(checked_profile(&json!({ "id": "u", "name": "J", "role": "Admin" })).is_err());
    }

    #[test]
    fn reads_sign_offs_and_what_superseded_them_from_the_log() {
        let user =
            json!({ "kind": "user", "profileId": "u_jane", "name": "Jane", "role": "Reviewer" });
        let entries = vec![
            json!({ "seq": 1, "action": "check.run", "target": { "datasetId": "d1" } }),
            json!({ "seq": 2, "at": "T2", "action": "dataset.signoff", "actor": user, "target": { "datasetId": "d1" }, "new": { "status": "approved" }, "reason": "Fine" }),
            json!({ "seq": 3, "action": "issue.comment", "target": { "datasetId": "d1" } }),
            json!({ "seq": 4, "action": "cell.edit", "target": { "datasetId": "d2" } }),
            json!({ "seq": 5, "action": "project.conventions", "target": {} }),
            json!({ "seq": 6, "action": "entry.revert", "target": { "seq": 5 } }),
            json!({ "seq": 7, "action": "project.area", "target": {} }),
        ];
        let s = &sign_offs(&entries)["d1"][0];
        assert_eq!(s["changedSeq"], 7);
        assert_eq!(s["by"]["name"], "Jane");
        assert_eq!(
            sign_off_text(s),
            "approved by Jane (Reviewer) at T2, entry 2; the dataset changed after it, at entry 7"
        );
    }
}
