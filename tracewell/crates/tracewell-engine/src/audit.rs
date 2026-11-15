//! The audit log (SAD section 9): append-only and SHA-256 hash-chained, in exactly the format the
//! TypeScript engine writes, so either engine can verify and replay the other's log.

use crate::canonical::{canonical_json, in_order, round_tripped, sha256_hex};
use serde_json::{Map, Value, json};

pub const GENESIS_PREFIX: &str = "tracewell-audit-v1:";

/// The members of an entry and of its fixed parts, in the order the audit schema lists them.
const ENTRY: &[&str] = &[
    "seq", "at", "actor", "action", "target", "old", "new", "reason", "method", "rule", "payload",
    "prev", "hash",
];
const ACTOR: &[&str] = &["kind", "profileId", "name", "role", "component"];
const TARGET: &[&str] = &[
    "datasetId",
    "rowId",
    "columnId",
    "issueId",
    "stepId",
    "seq",
    "fileId",
    "locator",
];
const METHOD: &[&str] = &[
    "from",
    "to",
    "fromFactor",
    "fromOffset",
    "toFactor",
    "toOffset",
    "formula",
    "source",
    "registryVersion",
];
const RULE: &[&str] = &["id", "version"];

/// An entry in the form the TypeScript engine holds it (log.ts normalise): read back from its
/// canonical JSON text, then laid out as the audit schema lists the members of an entry and of its
/// actor, target, method and rule. Old, new and payload keep the order of the canonical text. The
/// two engines then show the same text wherever an entry's values are written out as JSON.
fn normalise(entry: Value) -> Value {
    let Value::Object(members) = in_order(round_tripped(entry), ENTRY) else {
        unreachable!("an audit entry is an object");
    };
    Value::Object(
        members
            .into_iter()
            .map(|(k, v)| {
                let v = match k.as_str() {
                    "actor" => in_order(v, ACTOR),
                    "target" => in_order(v, TARGET),
                    "method" => in_order(v, METHOD),
                    "rule" => in_order(v, RULE),
                    _ => v,
                };
                (k, v)
            })
            .collect(),
    )
}

pub struct AuditLog {
    genesis: String,
    entries: Vec<Value>,
}

impl AuditLog {
    pub fn new(project_id: &str) -> Self {
        AuditLog {
            genesis: sha256_hex(format!("{GENESIS_PREFIX}{project_id}").as_bytes()),
            entries: Vec::new(),
        }
    }

    pub fn head(&self) -> (u64, String) {
        match self.entries.last() {
            Some(e) => (
                e["seq"].as_u64().unwrap_or(0),
                e["hash"].as_str().unwrap_or_default().to_string(),
            ),
            None => (0, self.genesis.clone()),
        }
    }

    /// Appends a draft (action, target, old, new, reason, method, rule, payload) after the head.
    pub fn append(&mut self, draft: Map<String, Value>, at: String, actor: Value) -> Value {
        let (seq, prev) = self.head();
        let mut entry = draft;
        entry.insert("seq".into(), json!(seq + 1));
        entry.insert("at".into(), Value::String(at));
        entry.insert("actor".into(), actor);
        entry.insert("prev".into(), Value::String(prev));
        let hash = sha256_hex(canonical_json(&Value::Object(entry.clone())).as_bytes());
        entry.insert("hash".into(), Value::String(hash));
        let entry = normalise(Value::Object(entry));
        self.entries.push(entry.clone());
        entry
    }

    /// A log read from audit.jsonl: the entries in order, with the values written. A line that is
    /// not JSON ends the reading and is reported with its number; whether the chain holds is
    /// verify()'s question.
    pub fn from_jsonl(project_id: &str, text: &str) -> (AuditLog, Option<(usize, String)>) {
        let mut log = AuditLog::new(project_id);
        for (i, line) in text.lines().enumerate() {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(v) if v.is_object() => log.entries.push(normalise(v)),
                _ => return (log, Some((i + 1, "the line is not a JSON object".into()))),
            }
        }
        (log, None)
    }

    pub fn entries(&self) -> &[Value] {
        &self.entries
    }

    /// The ChainReport: every entry's hash recomputed and every link checked.
    pub fn verify(&self) -> Value {
        let mut prev = self.genesis.clone();
        for (i, e) in self.entries.iter().enumerate() {
            let seq = e["seq"].as_u64().unwrap_or(0);
            let mut unsealed = e.as_object().cloned().unwrap_or_default();
            let hash = unsealed
                .remove("hash")
                .and_then(|h| h.as_str().map(String::from))
                .unwrap_or_default();
            let broken = |reason: &str| json!({ "ok": false, "entries": self.entries.len(), "brokenAt": seq, "reason": reason });
            if seq != i as u64 + 1 {
                return broken("the sequence numbers are not consecutive");
            }
            if e["prev"].as_str() != Some(prev.as_str()) {
                return broken("the entry does not link to the one before it");
            }
            if sha256_hex(canonical_json(&Value::Object(unsealed)).as_bytes()) != hash {
                return broken("the entry's content does not match its hash");
            }
            prev = hash;
        }
        json!({ "ok": true, "entries": self.entries.len() })
    }

    /// The JSON Lines text of the log, as audit.jsonl holds it.
    pub fn to_jsonl(&self) -> String {
        self.entries
            .iter()
            .map(|e| format!("{}\n", canonical_json(e)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An entry reads as the TypeScript engine writes it out as JSON text, whatever order it was
    /// put together in: its own members and those of its fixed parts as the schema lists them, the
    /// free values as their canonical text reads back in JavaScript.
    #[test]
    fn an_entry_holds_its_members_as_the_typescript_engine_does() {
        let mut log = AuditLog::new("p_1");
        let genesis = log.head().1;
        let mut draft = Map::new();
        draft.insert(
            "payload".into(),
            json!({ "rows": [2, 1], "z": -0.0, "count": 2, "10": "a", "9": "b", "é": { "b": 1, "a": 2 } }),
        );
        draft.insert(
            "new".into(),
            json!({ "name": "wells", "fileName": "wells.csv" }),
        );
        draft.insert(
            "method".into(),
            json!({ "registryVersion": "2026.1", "to": "kPa", "from": "psia", "formula": "y = x" }),
        );
        draft.insert(
            "target".into(),
            json!({ "locator": "line 2", "stepId": "s1", "columnId": "c1", "datasetId": "d1", "rowId": 0 }),
        );
        draft.insert("reason".into(), json!("Checked by hand"));
        draft.insert("action".into(), json!("cell.edit"));
        let entry = log.append(
            draft,
            "2026-01-01T00:00:00.000Z".into(),
            json!({ "role": "Analyst", "name": "P", "profileId": "u_p", "kind": "user" }),
        );
        let hash = entry["hash"].as_str().unwrap().to_string();
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            format!(
                concat!(
                    r#"{{"seq":1,"at":"2026-01-01T00:00:00.000Z","#,
                    r#""actor":{{"kind":"user","profileId":"u_p","name":"P","role":"Analyst"}},"#,
                    r#""action":"cell.edit","#,
                    r#""target":{{"datasetId":"d1","rowId":0,"columnId":"c1","stepId":"s1","locator":"line 2"}},"#,
                    r#""new":{{"fileName":"wells.csv","name":"wells"}},"reason":"Checked by hand","#,
                    r#""method":{{"from":"psia","to":"kPa","formula":"y = x","registryVersion":"2026.1"}},"#,
                    r#""payload":{{"9":"b","10":"a","count":2,"rows":[2,1],"z":0,"é":{{"a":2,"b":1}}}},"#,
                    r#""prev":"{}","hash":"{}"}}"#
                ),
                genesis, hash
            )
        );
        // The chain holds, and a log read back from its file holds the same entries.
        assert_eq!(log.verify()["ok"], true);
        let (read, bad) = AuditLog::from_jsonl("p_1", &log.to_jsonl());
        assert!(bad.is_none());
        assert_eq!(
            serde_json::to_string(read.entries()).unwrap(),
            serde_json::to_string(log.entries()).unwrap()
        );
        assert_eq!(read.verify()["ok"], true);
    }
}
