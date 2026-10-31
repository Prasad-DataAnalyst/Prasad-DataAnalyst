//! Rule packs, row sets and issue drafts (SAD sections 7.7 and 7.8), as the TypeScript rules
//! module: the packs are the same JSON files, byte for byte, so their SHA-256 in a project means
//! the same rules whichever engine ran them.

use crate::canonical::{canonical_number, sha256_hex};
use serde_json::{Value, json};
use std::sync::OnceLock;

pub const GENERIC_DQ_JSON: &str = include_str!("../../../src/rules/packs/generic-dq-0.1.0.json");
pub const SYSTEM_JSON: &str = include_str!("../../../src/rules/packs/system-0.1.0.json");

pub struct Rule {
    pub id: String,
    pub version: String,
    pub title: String,
    pub severity: String,
    pub category: String,
    pub message: String,
    pub explanation: String,
    pub source: String,
    pub applies_to: Value,
    pub check: Value,
}

impl Rule {
    pub fn kind(&self) -> &str {
        self.check["kind"].as_str().unwrap_or("")
    }
}

pub struct Pack {
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub rules: Vec<Rule>,
}

impl Pack {
    fn parse(text: &str) -> Pack {
        let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        let s = |r: &Value, k: &str| r[k].as_str().unwrap_or_default().to_string();
        Pack {
            id: s(&v, "id"),
            version: s(&v, "version"),
            sha256: sha256_hex(text.as_bytes()),
            rules: v["rules"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| Rule {
                    id: s(r, "id"),
                    version: s(r, "version"),
                    title: s(r, "title"),
                    severity: s(r, "severity"),
                    category: s(r, "category"),
                    message: s(r, "message"),
                    explanation: s(r, "explanation"),
                    source: s(r, "source"),
                    applies_to: r["appliesTo"].clone(),
                    check: r["check"].clone(),
                })
                .collect(),
        }
    }

    pub fn reference(&self) -> Value {
        json!({ "id": self.id, "version": self.version, "sha256": self.sha256 })
    }
}

/// The packs a check run uses, in the order they run.
/** The exact text of a built-in pack, as a project file stores it. */
pub fn pack_json(id: &str) -> Option<&'static str> {
    [GENERIC_DQ_JSON, SYSTEM_JSON]
        .into_iter()
        .zip(check_packs())
        .find(|(_, p)| p.id == id)
        .map(|(text, _)| text)
}

pub fn check_packs() -> &'static [Pack] {
    static PACKS: OnceLock<Vec<Pack>> = OnceLock::new();
    PACKS.get_or_init(|| vec![Pack::parse(GENERIC_DQ_JSON), Pack::parse(SYSTEM_JSON)])
}

pub fn find_rule(rule_id: &str) -> Option<(&'static Pack, &'static Rule)> {
    check_packs()
        .iter()
        .find_map(|p| p.rules.iter().find(|r| r.id == rule_id).map(|r| (p, r)))
}

/// Rows of a dataset, as a bitset (the TypeScript RowSet).
#[derive(Clone, Debug, PartialEq)]
pub struct RowSet {
    words: Vec<u64>,
    n: u64,
}

impl RowSet {
    pub fn new(n: u64) -> RowSet {
        RowSet {
            words: vec![0; n.div_ceil(64) as usize],
            n,
        }
    }

    pub fn insert(&mut self, r: u64) {
        if r < self.n {
            self.words[(r / 64) as usize] |= 1 << (r % 64);
        }
    }

    pub fn contains(&self, r: u64) -> bool {
        r < self.n && self.words[(r / 64) as usize] & (1 << (r % 64)) != 0
    }

    pub fn count(&self) -> u64 {
        self.words.iter().map(|w| w.count_ones() as u64).sum()
    }

    fn combine(&self, o: &RowSet, op: impl Fn(u64, u64) -> u64) -> RowSet {
        RowSet {
            words: self
                .words
                .iter()
                .enumerate()
                .map(|(i, w)| op(*w, o.words.get(i).copied().unwrap_or(0)))
                .collect(),
            n: self.n,
        }
    }

    pub fn union(&self, o: &RowSet) -> RowSet {
        self.combine(o, |a, b| a | b)
    }

    pub fn minus(&self, o: &RowSet) -> RowSet {
        self.combine(o, |a, b| a & !b)
    }

    pub fn intersect(&self, o: &RowSet) -> RowSet {
        self.combine(o, |a, b| a & b)
    }

    pub fn iter(&self) -> impl Iterator<Item = u64> + '_ {
        self.words.iter().enumerate().flat_map(|(i, &w)| {
            let mut bits = w;
            std::iter::from_fn(move || {
                if bits == 0 {
                    return None;
                }
                let b = bits.trailing_zeros() as u64;
                bits &= bits - 1;
                Some(i as u64 * 64 + b)
            })
        })
    }

    /// `{ count, ranges }` with at most `max` inclusive ranges, as RowSet.toRanges.
    pub fn to_ranges(&self, max: usize) -> Value {
        let mut ranges: Vec<[u64; 2]> = Vec::new();
        let mut current: Option<[u64; 2]> = None;
        for r in self.iter() {
            match current {
                Some([lo, hi]) if r == hi + 1 => current = Some([lo, r]),
                Some(range) => {
                    if ranges.len() >= max {
                        current = None;
                        break;
                    }
                    ranges.push(range);
                    current = Some([r, r]);
                }
                None => current = Some([r, r]),
            }
        }
        if let Some(range) = current {
            if ranges.len() < max {
                ranges.push(range);
            }
        }
        json!({ "count": self.count(), "ranges": ranges })
    }
}

/// A message variable: text, or a number written as JavaScript writes it.
#[derive(Clone)]
pub enum Var {
    Text(String),
    Num(f64),
}

impl Var {
    fn render(&self) -> String {
        match self {
            Var::Text(s) => s.clone(),
            Var::Num(n) => canonical_number(*n),
        }
    }
}

/// Fills `{name}` placeholders; unknown placeholders stay visible (message.ts).
pub fn render_message(template: &str, vars: &[(&str, Var)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        if name_len > 0 && after[name_len..].starts_with('}') {
            let name = &after[..name_len];
            // The last value given for a name wins, as later keys win in a JavaScript object spread.
            match vars.iter().rev().find(|(k, _)| *k == name) {
                Some((_, v)) => out.push_str(&v.render()),
                None => out.push_str(&rest[open..open + name_len + 2]),
            }
            rest = &after[name_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// What a check found, before it becomes or updates an issue (IssueDraft).
#[derive(Clone)]
pub struct Draft {
    pub rule_id: String,
    pub rule_version: String,
    pub pack_id: String,
    pub severity: String,
    pub category: String,
    pub dataset_id: String,
    pub columns: Vec<String>,
    pub scope: &'static str,
    pub rows: RowSet,
    pub message: String,
    /// Kept as the TypeScript IssueDraft keeps it; no protocol answer carries it yet.
    #[allow(dead_code)]
    pub detail: Option<Value>,
}

impl Draft {
    /// The stable issue ID: the same rule, dataset and columns always give the same ID (id.ts).
    pub fn issue_id(&self) -> String {
        let mut cols = self.columns.clone();
        cols.sort();
        let h = sha256_hex(
            format!("{}|{}|{}", self.rule_id, self.dataset_id, cols.join(",")).as_bytes(),
        );
        format!("I-{}", &h[..12])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_both_packs_byte_for_byte() {
        let packs = check_packs();
        assert_eq!(packs[0].id, "tracewell.generic-dq");
        assert_eq!(packs[1].id, "tracewell.system");
        assert_eq!(packs[0].sha256, sha256_hex(GENERIC_DQ_JSON.as_bytes()));
        assert!(find_rule("TW-DQ-005").is_some());
    }

    #[test]
    fn row_sets_combine_and_list_ranges() {
        let mut a = RowSet::new(200);
        for r in [0, 1, 2, 5, 64, 65, 199] {
            a.insert(r);
        }
        let mut b = RowSet::new(200);
        b.insert(1);
        b.insert(65);
        assert_eq!(a.count(), 7);
        assert_eq!(
            a.minus(&b).iter().collect::<Vec<_>>(),
            vec![0, 2, 5, 64, 199]
        );
        assert_eq!(a.intersect(&b).count(), 2);
        assert_eq!(
            a.to_ranges(1000),
            json!({ "count": 7, "ranges": [[0, 2], [5, 5], [64, 65], [199, 199]] })
        );
        assert_eq!(
            a.to_ranges(2),
            json!({ "count": 7, "ranges": [[0, 2], [5, 5]] })
        );
    }

    #[test]
    fn renders_messages_like_the_typescript_template() {
        let vars = [
            ("count", Var::Num(3.0)),
            ("column", Var::Text("Pressure".into())),
            ("min", Var::Num(-459.67)),
        ];
        assert_eq!(
            render_message("{count} in {column} below {min}; {other} {", &vars),
            "3 in Pressure below -459.67; {other} {"
        );
    }
}
