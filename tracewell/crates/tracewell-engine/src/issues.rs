//! The issues register (SAD section 7.7), as the TypeScript issues-state.ts and queries.ts: issues
//! grouped per (rule, dataset, columns), with flagged, current and accepted rows, from which the
//! counts and the status follow. The native engine takes no decisions yet, so nothing is accepted
//! or excluded; the counts still follow the same formulas.

use crate::error::{EngineError, Result};
use crate::rules::{Draft, RowSet, find_rule};
use serde_json::{Value, json};
use std::cmp::Ordering;

const MAX_OPEN_RANGES: usize = 1000;

pub struct IssueState {
    pub id: String,
    pub draft: Draft,
    pub flagged: RowSet,
    pub current: RowSet,
    pub accepted: RowSet,
    pub present: bool,
    pub accepted_whole: bool,
    pub comments: Vec<Value>,
    pub first_seen_seq: u64,
    pub last_checked_seq: u64,
}

/// Merges a check run's drafts: issues it raised are updated, issues it did not raise are no
/// longer flagged (mergeCheckRun).
pub fn merge_check_run(issues: &mut Vec<IssueState>, drafts: Vec<Draft>, seq: u64, n: u64) {
    let mut seen = Vec::new();
    for d in drafts {
        let id = d.issue_id();
        seen.push(id.clone());
        let rows = d.rows.clone();
        match issues.iter_mut().find(|s| s.id == id) {
            Some(st) => {
                st.flagged = st.flagged.union(&rows);
                st.current = rows;
                st.draft = d;
                st.present = true;
                st.last_checked_seq = seq;
            }
            None => issues.push(IssueState {
                id,
                flagged: rows.clone(),
                current: rows,
                draft: d,
                accepted: RowSet::new(n),
                present: true,
                accepted_whole: false,
                comments: Vec::new(),
                first_seen_seq: seq,
                last_checked_seq: seq,
            }),
        }
    }
    for st in issues.iter_mut().filter(|s| !seen.contains(&s.id)) {
        st.current = RowSet::new(n);
        st.present = false;
        st.last_checked_seq = seq;
    }
}

struct Counts {
    flagged: u64,
    open: u64,
    accepted: u64,
    excluded: u64,
    fixed: u64,
}

fn counts(st: &IssueState) -> Counts {
    if st.draft.scope != "rows" {
        return Counts {
            flagged: 1,
            open: u64::from(st.present && !st.accepted_whole),
            accepted: u64::from(st.present && st.accepted_whole),
            excluded: 0,
            fixed: u64::from(!st.present),
        };
    }
    Counts {
        flagged: st.flagged.count(),
        open: st.current.minus(&st.accepted).count(),
        accepted: st.current.intersect(&st.accepted).count(),
        excluded: 0,
        fixed: st.flagged.minus(&st.current).count(),
    }
}

fn status(c: &Counts) -> &'static str {
    if c.open == 0 {
        "resolved"
    } else if c.accepted == 0 && c.excluded == 0 && c.fixed == 0 {
        "open"
    } else {
        "partly_resolved"
    }
}

/// The issue as the protocol carries it (toIssue).
pub fn to_issue(st: &IssueState) -> Value {
    let rule = find_rule(&st.draft.rule_id).map(|(_, r)| r);
    let c = counts(st);
    let open_rows = if st.draft.scope == "rows" {
        st.current.minus(&st.accepted).to_ranges(MAX_OPEN_RANGES)
    } else {
        json!({ "count": 0, "ranges": [] })
    };
    let d = &st.draft;
    json!({
        "id": st.id,
        "ruleId": d.rule_id,
        "ruleVersion": d.rule_version,
        "packId": d.pack_id,
        "severity": d.severity,
        "category": d.category,
        "datasetId": d.dataset_id,
        "columns": d.columns,
        "scope": d.scope,
        "title": rule.map_or(d.rule_id.clone(), |r| r.title.clone()),
        "message": d.message,
        "explanation": rule.map_or(String::new(), |r| r.explanation.clone()),
        "source": rule.map_or(String::new(), |r| r.source.clone()),
        "status": status(&c),
        "counts": {
            "flagged": c.flagged,
            "open": c.open,
            "accepted": c.accepted,
            "excluded": c.excluded,
            "fixed": c.fixed,
        },
        "openRows": open_rows,
        "comments": st.comments,
        "firstSeenSeq": st.first_seen_seq,
        "lastCheckedSeq": st.last_checked_seq,
    })
}

/// The state of one flagged row (occurrenceState).
pub fn occurrence_state(st: &IssueState, row: u64) -> &'static str {
    if !st.current.contains(row) {
        "fixed"
    } else if st.accepted.contains(row) {
        "accepted"
    } else {
        "open"
    }
}

fn severity_rank(s: &str) -> i32 {
    match s {
        "error" => 3,
        "warning" => 2,
        _ => 1,
    }
}

/// An issue listed with the names of its columns, for filtering and sorting.
pub struct Listed {
    pub issue: Value,
    pub names: String,
}

/// Whether an issue passes the query's filters (queries.ts matches).
pub fn matches(l: &Listed, q: &Value) -> bool {
    let i = &l.issue;
    let in_list = |key: &str, field: &str| {
        q[key]
            .as_array()
            .is_none_or(|a| a.is_empty() || a.iter().any(|x| *x == i[field]))
    };
    if !in_list("severity", "severity") || !in_list("status", "status") {
        return false;
    }
    if !q["ruleId"].is_null() && q["ruleId"] != i["ruleId"] {
        return false;
    }
    if let Some(col) = q["columnId"].as_str() {
        let has = i["columns"]
            .as_array()
            .is_some_and(|cs| cs.iter().any(|c| c.as_str() == Some(col)));
        if !has {
            return false;
        }
    }
    let text = q["text"].as_str().unwrap_or("").trim().to_lowercase();
    if text.is_empty() {
        return true;
    }
    let field = |k: &str| i[k].as_str().unwrap_or("").to_lowercase();
    [
        field("title"),
        field("message"),
        field("ruleId"),
        l.names.to_lowercase(),
    ]
    .iter()
    .any(|s| s.contains(&text))
}

/// Sorts issues by the query's sort key, ties broken by severity, rule and ID (issueOrder).
pub fn sort(list: &mut [Listed], sort: &Value) -> Result<()> {
    let key = match sort {
        Value::Null => "severity",
        Value::String(s) if matches!(s.as_str(), "severity" | "rule" | "count" | "column") => {
            s.as_str()
        }
        other => {
            return Err(EngineError::invalid(
                format!("The issue sort {other} does not exist."),
                "Sort by one of: severity, rule, count, column.",
            ));
        }
    };
    let text = |l: &Listed, k: &str| l.issue[k].as_str().unwrap_or("").to_string();
    let by_severity = |a: &Listed, b: &Listed| {
        severity_rank(&text(b, "severity")).cmp(&severity_rank(&text(a, "severity")))
    };
    let by_rule = |a: &Listed, b: &Listed| text(a, "ruleId").cmp(&text(b, "ruleId"));
    let primary = |a: &Listed, b: &Listed| -> Ordering {
        match key {
            "rule" => by_rule(a, b),
            "count" => {
                let open = |l: &Listed| l.issue["counts"]["open"].as_u64().unwrap_or(0);
                open(b).cmp(&open(a))
            }
            "column" => a.names.cmp(&b.names),
            _ => by_severity(a, b),
        }
    };
    list.sort_by(|a, b| {
        primary(a, b)
            .then_with(|| by_severity(a, b))
            .then_with(|| by_rule(a, b))
            .then_with(|| text(a, "id").cmp(&text(b, "id")))
    });
    Ok(())
}
