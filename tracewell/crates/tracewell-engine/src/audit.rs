//! The audit log (SAD section 9): append-only and SHA-256 hash-chained, in exactly the format the
//! TypeScript engine writes, so either engine can verify and replay the other's log.

use crate::canonical::{canonical_json, sha256_hex};
use serde_json::{Map, Value, json};

pub const GENESIS_PREFIX: &str = "tracewell-audit-v1:";

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
        let entry = Value::Object(entry);
        self.entries.push(entry.clone());
        entry
    }

    /// A log read from audit.jsonl: the entries in order, as written. A line that is not JSON ends
    /// the reading and is reported with its number; whether the chain holds is verify()'s question.
    pub fn from_jsonl(project_id: &str, text: &str) -> (AuditLog, Option<(usize, String)>) {
        let mut log = AuditLog::new(project_id);
        for (i, line) in text.lines().enumerate() {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(v) if v.is_object() => log.entries.push(v),
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
