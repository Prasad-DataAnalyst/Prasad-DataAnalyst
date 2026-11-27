//! Signed rule-pack files (.twrules, FR-RUL-01, FR-RUL-02) and the administrator's policy
//! (FR-RUL-04), SAD decision D-17, as rules/signed.ts checks them. A file holds a pack, its
//! publisher and an Ed25519 signature of the UTF-8 canonical JSON of the pack; it installs only
//! when a publisher the policy trusts signed it, the pack follows the rule-pack format, and the
//! policy's locked version, if any, is the file's. The checks run in the TypeScript engine's order
//! and refuse with its messages.

use crate::canonical::{array_index, canonical_json, sha256_hex, stringify};
use crate::error::{EngineError, Result};
use crate::rules::{PackSet, base64_decode, check_packs};
use crate::units::is_js_space;
use ed25519_dalek::{Signature, VerifyingKey};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

/// The largest rule-pack file read.
pub const RULEPACK_FILE_MAX_BYTES: usize = 1 << 20;

/// The packs built into Tracewell, which no file replaces.
const BUILTIN_PACK_IDS: [&str; 2] = ["tracewell.generic-dq", "tracewell.system"];

const FIX_FILE: &str =
    "Get the rule-pack file again from its publisher, made with the Tracewell signing tool.";

// The rule-pack format, as model/schemas.ts lists it.
const COLUMN_ROLES: [&str; 10] = [
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
const LOGICAL_TYPES: [&str; 7] = [
    "string", "integer", "number", "boolean", "date", "datetime", "geometry",
];
const QUANTITY_KINDS: [&str; 21] = [
    "length",
    "area",
    "volume",
    "std_volume",
    "mass",
    "time",
    "temperature",
    "temperature_diff",
    "pressure_abs",
    "pressure_gauge",
    "pressure_diff",
    "energy",
    "power",
    "density",
    "mass_rate",
    "volume_rate",
    "std_volume_rate",
    "energy_rate",
    "fraction",
    "velocity",
    "dimensionless",
];
const SEVERITIES: [&str; 3] = ["error", "warning", "note"];
const RULE_CATEGORIES: [&str; 10] = [
    "completeness",
    "uniqueness",
    "validity",
    "range",
    "units",
    "time",
    "spatial",
    "import",
    "project",
    "export",
];
/// Check primitives that take no parameters.
const SIMPLE_CHECK_KINDS: [&str; 20] = [
    "not_null",
    "duplicate_rows",
    "duplicate_key",
    "type_conformance",
    "below_detection_limit",
    "physical_range",
    "null_marker",
    "unit_known",
    "unit_consistent",
    "ts_duplicate",
    "ts_order",
    "tz_specified",
    "date_ambiguous",
    "geometry_valid",
    "coord_range",
    "latlon_swapped",
    "within_area",
    "crs_wgs84",
    "geometry_present",
    "system",
];
const IMPORT_NOTE_CODES: [&str; 6] = [
    "TW-IMP-001",
    "TW-IMP-002",
    "TW-IMP-003",
    "TW-IMP-004",
    "TW-IMP-005",
    "TW-IMP-006",
];
const RULE_KEYS: [&str; 10] = [
    "id",
    "version",
    "title",
    "category",
    "severity",
    "appliesTo",
    "check",
    "message",
    "explanation",
    "source",
];
/// The largest integer JavaScript holds exactly (Number.MAX_SAFE_INTEGER).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn semver() -> &'static Regex {
    static SEMVER: OnceLock<Regex> = OnceLock::new();
    SEMVER.get_or_init(|| {
        Regex::new(
            r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$",
        )
        .expect("the version pattern compiles")
    })
}

/// The administrator's policy: the publishers whose keys are trusted, and locked pack versions.
#[derive(Debug, Default, PartialEq)]
pub struct Policy {
    /// Each trusted publisher's name and raw public key, as base64.
    trusted_keys: Vec<(String, String)>,
    locked_versions: Vec<(String, String)>,
}

impl Policy {
    fn locked(&self, id: &str) -> Option<&str> {
        self.locked_versions
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, v)| v.as_str())
    }
}

fn policy_failed(why: &str) -> EngineError {
    EngineError::invalid(
        format!("The rule-pack policy is not valid: {why}."),
        "Correct the policy file, or ask the administrator for one that follows the policy format.",
    )
}

/// The text after a UTF-8 byte order mark, which TextDecoder drops.
fn without_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

/// An object's members in the order JavaScript lists them: array indices first, ascending.
fn js_order(o: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let (mut indices, names): (Vec<_>, Vec<_>) =
        o.iter().partition(|(k, _)| array_index(k).is_some());
    indices.sort_by_key(|(k, _)| array_index(k));
    indices.extend(names);
    indices
}

/// Parses an administrator's policy file (tracewell-policy.json), as parsePolicy does.
pub fn parse_policy(text: &str) -> Result<Policy> {
    let v: Value = serde_json::from_str(text).map_err(|_| policy_failed("it is not JSON text"))?;
    let Some(o) = v
        .as_object()
        .filter(|o| o.get("format") == Some(&json!("tracewell-policy")))
    else {
        return Err(policy_failed("it is not a Tracewell policy file"));
    };
    if o.get("formatVersion") != Some(&json!("0.1")) {
        let shown = o
            .get("formatVersion")
            .map_or_else(|| "undefined".to_string(), stringify);
        return Err(policy_failed(&format!(
            "its format version {shown} is not 0.1"
        )));
    }
    let keys = match o.get("trustedKeys") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(_) => return Err(policy_failed("trustedKeys is not a list")),
    };
    let mut trusted_keys = Vec::new();
    for (i, k) in keys.iter().enumerate() {
        let name = k.get("name").and_then(Value::as_str);
        let Some(name) = name.filter(|n| !n.trim_matches(is_js_space).is_empty()) else {
            return Err(policy_failed(&format!("trusted key {} has no name", i + 1)));
        };
        let key = k.get("publicKey").and_then(Value::as_str);
        let Some(key) = key.filter(|key| base64_decode(key).is_some_and(|b| b.len() == 32)) else {
            return Err(policy_failed(&format!(
                "the key of {name} is not 32 bytes of base64"
            )));
        };
        trusted_keys.push((name.trim_matches(is_js_space).to_string(), key.to_string()));
    }
    let locked = match o.get("lockedVersions") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err(policy_failed("lockedVersions is not an object")),
    };
    let mut locked_versions = Vec::new();
    for (id, version) in js_order(&locked) {
        let Some(version) = version.as_str().filter(|v| semver().is_match(v)) else {
            return Err(policy_failed(&format!(
                "the locked version of {id} is not a version"
            )));
        };
        locked_versions.push((id.clone(), version.to_string()));
    }
    Ok(Policy {
        trusted_keys,
        locked_versions,
    })
}

/// The policy in the file at `path`: none when no file is named or the file is not there, so
/// that no publisher is trusted.
pub fn read_policy(path: Option<&Path>) -> Result<Policy> {
    let Some(path) = path else {
        return Ok(Policy::default());
    };
    match std::fs::read(path) {
        Ok(bytes) => match std::str::from_utf8(without_bom(&bytes)) {
            Ok(text) => parse_policy(text),
            Err(_) => Err(policy_failed("it is not JSON text")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Policy::default()),
        Err(e) => Err(EngineError::invalid(
            format!(
                "The rule-pack policy {} could not be read: {e}.",
                path.display()
            ),
            "Ask the administrator to check that the policy file can be read.",
        )),
    }
}

/// A publisher key's ID: the first 16 hex digits of the SHA-256 of its 32 raw bytes.
pub fn key_id(public_key: &[u8]) -> String {
    sha256_hex(public_key)[..16].to_string()
}

fn non_empty(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

fn version(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| semver().is_match(s))
}

fn one_of(v: Option<&Value>, choices: &[&str]) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| choices.contains(&s))
}

/// Whether an object has every required member and no other than the optional ones (strictObject).
fn exactly(o: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|k| o.contains_key(*k))
        && o.keys()
            .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
}

/// A whole number JavaScript holds exactly, at least `min` (z.int().min).
fn int_at_least(v: Option<&Value>, min: f64) -> bool {
    v.and_then(Value::as_f64)
        .is_some_and(|f| f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER && f >= min)
}

fn positive(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64)
        .is_some_and(|f| f.is_finite() && f > 0.0)
}

/// A column selector: the dataset, or at least one filter, none of them an empty list.
fn selector_ok(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    if exactly(o, &["dataset"], &[]) {
        return o["dataset"] == json!(true);
    }
    let list = |key: &str, choices: &[&str]| {
        o.get(key).is_none_or(|v| {
            v.as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(|x| one_of(Some(x), choices)))
        })
    };
    !o.is_empty()
        && exactly(o, &[], &["roles", "types", "quantities", "all"])
        && list("roles", &COLUMN_ROLES)
        && list("types", &LOGICAL_TYPES)
        && list("quantities", &QUANTITY_KINDS)
        && o.get("all").is_none_or(|a| *a == json!(true))
}

fn check_ok(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    match o.get("kind").and_then(Value::as_str) {
        Some("ts_gap") => exactly(o, &["kind", "factor"], &[]) && positive(o.get("factor")),
        Some("flatline") => {
            exactly(o, &["kind", "minRun"], &[]) && int_at_least(o.get("minRun"), 2.0)
        }
        Some("spike") => {
            exactly(o, &["kind", "window", "k"], &[])
                && int_at_least(o.get("window"), 1.0)
                && positive(o.get("k"))
        }
        Some("import_note") => {
            exactly(o, &["kind", "code"], &[]) && one_of(o.get("code"), &IMPORT_NOTE_CODES)
        }
        Some(kind) => SIMPLE_CHECK_KINDS.contains(&kind) && exactly(o, &["kind"], &[]),
        None => false,
    }
}

fn rule_ok(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    exactly(o, &RULE_KEYS, &[])
        && non_empty(o.get("id"))
        && version(o.get("version"))
        && non_empty(o.get("title"))
        && one_of(o.get("category"), &RULE_CATEGORIES)
        && one_of(o.get("severity"), &SEVERITIES)
        && selector_ok(&o["appliesTo"])
        && check_ok(&o["check"])
        && non_empty(o.get("message"))
        && non_empty(o.get("explanation"))
        && non_empty(o.get("source"))
}

/// Whether a value follows the rule-pack format (schemas.rulePack): every member as the format
/// defines it, no other member, and no two rules with one ID.
pub fn pack_valid(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    if !(exactly(o, &["id", "version", "title", "source", "rules"], &[])
        && non_empty(o.get("id"))
        && version(o.get("version"))
        && non_empty(o.get("title"))
        && non_empty(o.get("source")))
    {
        return false;
    }
    let Some(rules) = o["rules"].as_array() else {
        return false;
    };
    let mut ids = HashSet::new();
    rules.iter().all(rule_ok) && rules.iter().all(|r| ids.insert(r["id"].as_str()))
}

/// A pack that passed every check, ready to install: the pack as the file holds it, and what the
/// log records of it (InstalledRulePack).
pub struct Verified {
    pub pack: Value,
    pub info: Value,
}

fn refused(message: impl Into<String>, fix: impl Into<String>) -> EngineError {
    EngineError::invalid(message, fix)
}

fn signature_valid(public_key: &str, signature: &str, message: &[u8]) -> bool {
    let (Some(key), Some(sig)) = (base64_decode(public_key), base64_decode(signature)) else {
        return false;
    };
    let (Ok(key), Ok(sig)) = (<[u8; 32]>::try_from(key), <[u8; 64]>::try_from(sig)) else {
        return false;
    };
    VerifyingKey::from_bytes(&key).is_ok_and(|k| {
        k.verify_strict(message, &Signature::from_bytes(&sig))
            .is_ok()
    })
}

/// Checks a .twrules file against the policy and the project's packs (verifyRulePackFile), in
/// this order: its size, JSON, envelope and pack format, a built-in ID, the policy's lock, a
/// trusted publisher, the signature, rule IDs taken by other packs, and the same version
/// installed already.
pub fn verify(bytes: &[u8], policy: &Policy, packs: &PackSet) -> Result<Verified> {
    if bytes.len() > RULEPACK_FILE_MAX_BYTES {
        return Err(refused(
            format!(
                "The rule-pack file is larger than the {} MiB that is read.",
                RULEPACK_FILE_MAX_BYTES >> 20
            ),
            FIX_FILE,
        ));
    }
    let v: Value = std::str::from_utf8(without_bom(bytes))
        .ok()
        .and_then(|t| serde_json::from_str(t).ok())
        .ok_or_else(|| {
            refused(
                "The file is not a rule-pack: it is not JSON text in UTF-8.",
                FIX_FILE,
            )
        })?;
    let publisher = &v["publisher"];
    let envelope = v.as_object().is_some_and(|o| {
        o.get("format") == Some(&json!("tracewell-rules"))
            && o.get("formatVersion") == Some(&json!("0.1"))
            && o.get("pack").is_some_and(|p| p.is_object() || p.is_array())
            && o.get("signature").is_some_and(Value::is_string)
    }) && publisher.get("name").is_some_and(Value::is_string)
        && publisher.get("keyId").is_some_and(Value::is_string);
    if !envelope {
        return Err(refused(
            "The file is not a Tracewell rule-pack (.twrules) of format 0.1.",
            FIX_FILE,
        ));
    }
    let pack = v["pack"].clone();
    let rules = pack["rules"].as_array().cloned().unwrap_or_default();
    if !pack_valid(&pack) || rules.iter().any(|r| r["check"]["kind"] == "system") {
        return Err(refused(
            "The rule-pack does not follow the rule-pack format.",
            FIX_FILE,
        ));
    }
    let id = pack["id"].as_str().unwrap_or("");
    let ver = pack["version"].as_str().unwrap_or("");
    if BUILTIN_PACK_IDS.contains(&id) {
        return Err(refused(
            format!("The rule-pack {id} is built into Tracewell, and no file replaces it."),
            "Install a rule-pack with another ID.",
        ));
    }
    if let Some(locked) = policy.locked(id).filter(|l| *l != ver) {
        return Err(refused(
            format!("The policy locks {id} at version {locked}, and this file is version {ver}."),
            format!("Install version {locked}, or ask the administrator to change the policy."),
        ));
    }
    let name = publisher["name"]
        .as_str()
        .unwrap_or("")
        .trim_matches(is_js_space);
    let claimed = publisher["keyId"].as_str().unwrap_or("");
    let Some((_, public_key)) = policy
        .trusted_keys
        .iter()
        .find(|(_, k)| base64_decode(k).is_some_and(|raw| key_id(&raw) == claimed))
    else {
        return Err(refused(
            format!(
                "The rule-pack is signed by {} (key {claimed}), a publisher the policy does not trust.",
                stringify(&json!(name))
            ),
            "Ask the administrator to add the publisher's key to the policy file, or get the pack from a trusted publisher.",
        ));
    };
    let canonical = canonical_json(&pack);
    if !signature_valid(
        public_key,
        v["signature"].as_str().unwrap_or(""),
        canonical.as_bytes(),
    ) {
        return Err(refused(
            format!(
                "The signature of the rule-pack {id} {ver} does not verify: the file was changed after it was signed, or signed with another key."
            ),
            FIX_FILE,
        ));
    }
    let others: Vec<(&str, Vec<&str>)> = check_packs()
        .iter()
        .map(|p| {
            (
                p.id.as_str(),
                p.rules.iter().map(|r| r.id.as_str()).collect(),
            )
        })
        .chain(packs.installed().filter(|i| i.pack.id != id).map(|i| {
            (
                i.pack.id.as_str(),
                i.pack.rules.iter().map(|r| r.id.as_str()).collect(),
            )
        }))
        .collect();
    for rule in &rules {
        let rule_id = rule["id"].as_str().unwrap_or("");
        if let Some((owner, _)) = others.iter().find(|(_, ids)| ids.contains(&rule_id)) {
            return Err(refused(
                format!("The rule {rule_id} of {id} has the ID of a rule of {owner}."),
                "Ask the publisher for a pack whose rule IDs are its own.",
            ));
        }
    }
    if packs
        .installed()
        .any(|i| i.pack.id == id && i.pack.version == ver)
    {
        return Err(refused(
            format!("The rule-pack {id} {ver} is installed already."),
            "Install another version, or close the dialog.",
        ));
    }
    let info = json!({
        "id": id,
        "version": ver,
        "title": pack["title"],
        "sha256": sha256_hex(canonical.as_bytes()),
        "publisher": name,
        "keyId": claimed,
        "rules": rules.len(),
    });
    Ok(Verified { pack, info })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::Installed;
    use ed25519_dalek::{Signer, SigningKey};

    const PUBLISHER_SECRET: [u8; 32] = [7; 32];

    fn base64(bytes: &[u8]) -> String {
        crate::rules::base64_encode(bytes)
    }

    fn pack() -> Value {
        json!({
            "id": "acme.methane",
            "version": "1.0.0",
            "title": "ACME methane reporting",
            "source": "ACME internal standard MR-7",
            "rules": [{
                "id": "ACME-001",
                "version": "1.0.0",
                "title": "Measured value present",
                "category": "completeness",
                "severity": "error",
                "appliesTo": { "roles": ["measure"] },
                "check": { "kind": "not_null" },
                "message": "{column} has {count} empty values.",
                "explanation": "Every measurement needs a value for the methane report.",
                "source": "MR-7 section 4.2",
            }],
        })
    }

    fn signed(pack: &Value, secret: [u8; 32]) -> Vec<u8> {
        let key = SigningKey::from_bytes(&secret);
        let signature = key.sign(canonical_json(pack).as_bytes());
        let file = json!({
            "format": "tracewell-rules",
            "formatVersion": "0.1",
            "pack": pack,
            "publisher": { "name": " ACME Ltd ", "keyId": key_id(key.verifying_key().as_bytes()) },
            "signature": base64(&signature.to_bytes()),
        });
        serde_json::to_vec(&file).unwrap()
    }

    fn policy() -> Policy {
        let public = SigningKey::from_bytes(&PUBLISHER_SECRET).verifying_key();
        parse_policy(
            &json!({
                "format": "tracewell-policy",
                "formatVersion": "0.1",
                "trustedKeys": [{ "name": "ACME", "publicKey": base64(public.as_bytes()) }],
            })
            .to_string(),
        )
        .unwrap()
    }

    fn message(r: Result<Verified>) -> String {
        r.err().map(|e| e.message).unwrap_or_default()
    }

    #[test]
    fn verifies_a_trusted_publishers_pack_and_refuses_everything_else() {
        let none = PackSet::default();
        let v = verify(&signed(&pack(), PUBLISHER_SECRET), &policy(), &none).unwrap();
        assert_eq!(v.info["publisher"], "ACME Ltd");
        assert_eq!(v.info["rules"], 1);
        assert_eq!(
            v.info["sha256"],
            sha256_hex(canonical_json(&pack()).as_bytes())
        );
        let mut tampered: Value =
            serde_json::from_slice(&signed(&pack(), PUBLISHER_SECRET)).unwrap();
        tampered["pack"]["title"] = json!("Changed after signing");
        assert!(
            message(verify(
                &serde_json::to_vec(&tampered).unwrap(),
                &policy(),
                &none
            ))
            .starts_with("The signature of the rule-pack acme.methane 1.0.0 does not verify")
        );
        assert!(
            message(verify(&signed(&pack(), [9; 32]), &policy(), &none))
                .ends_with("a publisher the policy does not trust.")
        );
        assert!(
            message(verify(
                &signed(&pack(), PUBLISHER_SECRET),
                &Policy::default(),
                &none
            ))
            .starts_with("The rule-pack is signed by \"ACME Ltd\" (key ")
        );
        assert_eq!(
            message(verify(b"\xff", &policy(), &none)),
            "The file is not a rule-pack: it is not JSON text in UTF-8."
        );
        let mut locked = policy();
        locked.locked_versions = vec![("acme.methane".into(), "0.9.0".into())];
        assert_eq!(
            message(verify(&signed(&pack(), PUBLISHER_SECRET), &locked, &none)),
            "The policy locks acme.methane at version 0.9.0, and this file is version 1.0.0."
        );
        let mut clash = pack();
        clash["rules"][0]["id"] = json!("TW-DQ-001");
        assert_eq!(
            message(verify(&signed(&clash, PUBLISHER_SECRET), &policy(), &none)),
            "The rule TW-DQ-001 of acme.methane has the ID of a rule of tracewell.generic-dq."
        );
        let mut installed = PackSet::default();
        installed.install(Installed::new(v.info.clone(), v.pack.clone()));
        assert_eq!(
            message(verify(
                &signed(&pack(), PUBLISHER_SECRET),
                &policy(),
                &installed
            )),
            "The rule-pack acme.methane 1.0.0 is installed already."
        );
    }

    #[test]
    fn follows_the_rule_pack_format_as_the_typescript_schema_does() {
        assert!(pack_valid(&pack()));
        let with = |f: &dyn Fn(&mut Value)| {
            let mut p = pack();
            f(&mut p);
            pack_valid(&p)
        };
        assert!(with(&|p| p["rules"] = json!([])));
        assert!(with(
            &|p| p["rules"][0]["appliesTo"] = json!({ "all": true })
        ));
        assert!(with(
            &|p| p["rules"][0]["appliesTo"] = json!({ "dataset": true })
        ));
        assert!(with(
            &|p| p["rules"][0]["check"] = json!({ "kind": "spike", "window": 5.0, "k": 3.5 })
        ));
        assert!(!with(&|p| p["rules"][0]["appliesTo"] = json!({})));
        assert!(!with(
            &|p| p["rules"][0]["appliesTo"] = json!({ "roles": [] })
        ));
        assert!(!with(
            &|p| p["rules"][0]["appliesTo"] = json!({ "dataset": false })
        ));
        assert!(!with(
            &|p| p["rules"][0]["appliesTo"] = json!({ "dataset": true, "all": true })
        ));
        assert!(!with(
            &|p| p["rules"][0]["check"] = json!({ "kind": "flatline", "minRun": 1 })
        ));
        assert!(!with(
            &|p| p["rules"][0]["check"] = json!({ "kind": "spike", "window": 1.5, "k": 3 })
        ));
        assert!(!with(
            &|p| p["rules"][0]["check"] = json!({ "kind": "not_null", "extra": 1 })
        ));
        assert!(!with(
            &|p| p["rules"][0]["check"] = json!({ "kind": "no_such_check" })
        ));
        assert!(!with(&|p| p["version"] = json!("1.0")));
        assert!(!with(&|p| p["version"] = json!("01.0.0")));
        assert!(!with(&|p| p["title"] = json!("")));
        assert!(!with(&|p| p["extra"] = json!(1)));
        assert!(!with(&|p| {
            let rule = p["rules"][0].clone();
            p["rules"] = json!([rule.clone(), rule]);
        }));
    }

    #[test]
    fn reads_a_policy_and_refuses_one_that_is_not_one() {
        let key = base64(&[1; 32]);
        let text = json!({
            "format": "tracewell-policy",
            "formatVersion": "0.1",
            "trustedKeys": [{ "name": " ACME ", "publicKey": key }],
            "lockedVersions": { "acme.methane": "1.0.0" },
        });
        let p = parse_policy(&text.to_string()).unwrap();
        assert_eq!(p.trusted_keys, vec![("ACME".to_string(), key.clone())]);
        assert_eq!(p.locked("acme.methane"), Some("1.0.0"));
        let failed = |t: &str| parse_policy(t).err().map(|e| e.message).unwrap_or_default();
        assert_eq!(
            failed(
                r#"{"format":"tracewell-policy","formatVersion":"0.1","trustedKeys":[{"name":"x","publicKey":"AAAA"}]}"#
            ),
            "The rule-pack policy is not valid: the key of x is not 32 bytes of base64."
        );
        assert_eq!(
            failed(r#"{"format":"tracewell-policy","formatVersion":1}"#),
            "The rule-pack policy is not valid: its format version 1 is not 0.1."
        );
        assert_eq!(
            failed(r#"{"format":"tracewell-policy"}"#),
            "The rule-pack policy is not valid: its format version undefined is not 0.1."
        );
        assert_eq!(
            failed("[]"),
            "The rule-pack policy is not valid: it is not a Tracewell policy file."
        );
        assert_eq!(read_policy(None).unwrap(), Policy::default());
        assert_eq!(
            read_policy(Some(Path::new("/nonexistent/tracewell-policy.json"))).unwrap(),
            Policy::default()
        );
    }
}
