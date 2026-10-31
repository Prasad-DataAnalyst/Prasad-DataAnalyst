//! Project files (.twp, SAD section 11 and decision D-13), written in the container the TypeScript
//! engine writes and reads, so either engine opens the other's projects. Entries are STORED, with
//! ZIP64 fields once an entry or an offset passes 4 GiB, and each original is copied from disk with
//! its SHA-256 checked against its file ID, so a file that changed since it was imported is never
//! saved as if it had not. Format 0.2 adds each dataset's working Parquet files under data/, which
//! an opening engine may use instead of importing the originals again.

use crate::canonical::{canonical_json, sha256_hex};
use crate::error::{EngineError, Result};
use crate::units::is_js_space;
use crate::zip::ZipWriter;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const MIMETYPE: &str = "application/vnd.tracewell.project+zip";
pub const FORMAT_VERSION: &str = "0.2";

const MAX_STEM: usize = 100;

fn unsafe_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        || ('\u{0}'..='\u{1f}').contains(&c)
        || ('\u{7f}'..='\u{9f}').contains(&c)
}

fn trim_space_dots(s: &str) -> &str {
    s.trim_matches(|c: char| is_js_space(c) || c == '.')
}

/// A safe single path segment, as names.ts safeSegment makes it: unsafe characters become '_',
/// runs of white space one space, surrounding dots and spaces go, and Windows device names get a '_'.
pub fn safe_segment(text: &str, fallback: &str) -> String {
    let mut cleaned = String::new();
    let mut in_space = false;
    for c in text.nfc() {
        // Control characters are unsafe before they are white space, as in names.ts.
        if unsafe_char(c) {
            cleaned.push('_');
            in_space = false;
            continue;
        }
        if is_js_space(c) {
            if !in_space {
                cleaned.push(' ');
            }
            in_space = true;
            continue;
        }
        in_space = false;
        cleaned.push(c);
    }
    let trimmed = trim_space_dots(&cleaned);
    let bounded: String = trimmed.chars().take(MAX_STEM).collect();
    let bounded = bounded
        .trim_end_matches(|c: char| is_js_space(c) || c == '.')
        .to_string();
    if bounded.is_empty() || bounded.chars().all(|c| c == '_') {
        return fallback.to_string();
    }
    let stem = bounded.split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("_{bounded}")
    } else {
        bounded
    }
}

/// The download name of a project: its cleaned name with the .twp extension.
pub fn suggested_file_name(project_name: &str) -> String {
    let stem = if project_name.to_lowercase().ends_with(".twp") {
        &project_name[..project_name.len() - 4]
    } else {
        project_name
    };
    format!("{}.twp", safe_segment(stem, "project"))
}

pub fn original_path(file_id: &str, name: &str) -> String {
    format!("originals/{file_id}/{}", safe_segment(name, "file"))
}

pub fn cache_path(dataset_id: &str, kind: &str) -> String {
    let extension = if kind == "notes" { "json" } else { "parquet" };
    format!(
        "data/{}/{kind}.{extension}",
        safe_segment(dataset_id, "dataset")
    )
}

/// Everything a project file holds, gathered from the engine.
pub struct SaveInput {
    /// The manifest's own fields: appVersion, projectId, name, createdAt, savedAt, savedBy,
    /// unitSystem, projectArea, rulePacks, datasets and auditHead.
    pub manifest: Map<String, Value>,
    pub audit_jsonl: String,
    /// Each original's manifest record (fileId, name, size, mediaType, addedSeq) and its bytes.
    pub originals: Vec<(Value, OriginalSource)>,
    /// Each cache's manifest record (datasetId, sourceSeq, kind) and its Parquet file.
    pub caches: Vec<(Value, PathBuf)>,
    /// Caches held in memory: each dataset's notes as JSON.
    pub cache_bytes: Vec<(Value, Vec<u8>)>,
    pub rule_packs: Vec<(Value, &'static str)>,
    pub registry: (String, &'static str),
}

enum Source {
    Bytes(Vec<u8>),
    File(PathBuf),
    Range(PathBuf, u64, u64),
}

struct Item {
    path: String,
    size: u64,
    sha256: String,
    source: Source,
}

fn bytes_item(path: String, data: Vec<u8>) -> Item {
    Item {
        path,
        size: data.len() as u64,
        sha256: sha256_hex(&data),
        source: Source::Bytes(data),
    }
}

/// The SHA-256 and size of a file, read once.
pub fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        size += n as u64;
    }
    Ok((
        hash.finalize().iter().map(|b| format!("{b:02x}")).collect(),
        size,
    ))
}

/// README.txt: what the archive holds and how anyone can verify it without Tracewell.
fn readme(m: &Map<String, Value>) -> String {
    let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let list = |k: &str| {
        m.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut lines = vec![
        format!("Tracewell project: {}", s("name")),
        format!("Project ID: {}", s("projectId")),
        format!("Created: {}", s("createdAt")),
        format!("Saved: {} by {}", s("savedAt"), s("savedBy")),
        format!(
            "Format: {} {} (written by Tracewell {})",
            s("format"),
            s("formatVersion"),
            s("appVersion")
        ),
        format!("Unit system: {}", s("unitSystem")),
        format!(
            "Audit log: {} entries, last entry hash {}",
            m["auditHead"]["seq"], m["auditHead"]["hash"].as_str().unwrap_or("")
        ),
        String::new(),
        "WHAT THIS FILE IS".into(),
        "This .twp file is an ordinary ZIP archive. Rename it to .zip, or open it with any ZIP tool,".into(),
        "to look inside. Nothing in it is encrypted.".into(),
        String::new(),
        "CONTENTS".into(),
        "  mimetype            identifies the file as a Tracewell project".into(),
        "  manifest.json       project details and the SHA-256 of every other entry".into(),
        "  audit.jsonl         every action taken in the project, one JSON entry per line,".into(),
        "                      each linked to the one before it by its SHA-256 hash".into(),
        "  originals/          the imported files, byte for byte; each folder is named after".into(),
        "                      the SHA-256 of the file inside it".into(),
        "  data/               each dataset's imported data as Parquet, so Tracewell can open".into(),
        "                      the project without importing the originals again".into(),
        "  rulepacks/          the exact check rules used".into(),
        "  units/              the exact unit registry used".into(),
        "  CHECKSUMS.sha256    the SHA-256 of every entry except itself".into(),
        String::new(),
        "HOW TO VERIFY".into(),
        "  1. Extract the archive into an empty folder.".into(),
        "  2. In that folder run:  sha256sum -c CHECKSUMS.sha256".into(),
        "     Every line must end in OK. On Windows PowerShell, compare the output of".into(),
        "     Get-FileHash -Algorithm SHA256 <file> with the matching line instead.".into(),
        "  3. For each original, the folder name must equal the SHA-256 of the file inside it.".into(),
        "When Tracewell opens the project it repeats these checks, verifies the audit chain and".into(),
        "rebuilds every dataset from the originals and the audit log. If anything does not match,".into(),
        "the project opens read-only and the Open report says why; nothing is repaired silently.".into(),
        String::new(),
    ];
    let originals = list("originals");
    lines.push(format!("ORIGINAL FILES ({})", originals.len()));
    if originals.is_empty() {
        lines.push("  none".into());
    }
    for o in &originals {
        lines.push(format!(
            "  {}  {} bytes  SHA-256 {}",
            o["name"].as_str().unwrap_or(""),
            o["size"],
            o["fileId"].as_str().unwrap_or("")
        ));
    }
    lines.push(String::new());
    let packs = list("rulePacks");
    lines.push(format!("RULE PACKS ({})", packs.len()));
    if packs.is_empty() {
        lines.push("  none".into());
    }
    for p in &packs {
        lines.push(format!(
            "  {} {}  SHA-256 {}",
            p["id"].as_str().unwrap_or(""),
            p["version"].as_str().unwrap_or(""),
            p["sha256"].as_str().unwrap_or("")
        ));
    }
    lines.push(String::new());
    lines.push(format!(
        "UNIT REGISTRY: {}  SHA-256 {}",
        m["unitRegistry"]["version"].as_str().unwrap_or(""),
        m["unitRegistry"]["sha256"].as_str().unwrap_or("")
    ));
    lines.push(String::new());
    lines.join("\n")
}

/// Writes the project file at `target`; `progress` gets a phase and the bytes written so far.
pub fn write_twp(
    target: &Path,
    input: SaveInput,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<()> {
    let registry_sha = sha256_hex(input.registry.1.as_bytes());
    let mut items: Vec<Item> = vec![bytes_item(
        "audit.jsonl".into(),
        input.audit_jsonl.into_bytes(),
    )];
    for (pack, text) in &input.rule_packs {
        let path = format!(
            "rulepacks/{}-{}.json",
            safe_segment(pack["id"].as_str().unwrap_or(""), "pack"),
            safe_segment(pack["version"].as_str().unwrap_or(""), "0")
        );
        items.push(bytes_item(path, text.as_bytes().to_vec()));
    }
    items.push(bytes_item(
        format!(
            "units/registry-{}.json",
            safe_segment(&input.registry.0, "0")
        ),
        input.registry.1.as_bytes().to_vec(),
    ));
    let mut originals = Vec::new();
    for (info, source) in input.originals {
        let file_id = info["fileId"].as_str().unwrap_or("").to_string();
        let path = original_path(&file_id, info["name"].as_str().unwrap_or(""));
        let mut record = info.clone();
        record["path"] = json!(path);
        originals.push(record);
        items.push(Item {
            path,
            size: info["size"].as_u64().unwrap_or(0),
            // Checked as the file is copied: it must still be the file that was imported.
            sha256: file_id,
            source: match source {
                OriginalSource::File(path) => Source::File(path),
                OriginalSource::Entry {
                    archive,
                    offset,
                    size,
                } => Source::Range(archive, offset, size),
            },
        });
    }
    let mut caches = Vec::new();
    for (cache, data) in input.cache_bytes {
        let path = cache_path(
            cache["datasetId"].as_str().unwrap_or(""),
            cache["kind"].as_str().unwrap_or(""),
        );
        let mut record = cache.clone();
        record["path"] = json!(path);
        caches.push(record);
        items.push(bytes_item(path, data));
    }
    for (cache, source) in input.caches {
        progress("Reading the working data", 0);
        let path = cache_path(
            cache["datasetId"].as_str().unwrap_or(""),
            cache["kind"].as_str().unwrap_or(""),
        );
        let (sha256, size) = hash_file(&source)?;
        let mut record = cache.clone();
        record["path"] = json!(path);
        caches.push(record);
        items.push(Item {
            path,
            size,
            sha256,
            source: Source::File(source),
        });
    }

    let mut manifest = input.manifest;
    manifest.insert("format".into(), json!("tracewell-project"));
    manifest.insert("formatVersion".into(), json!(FORMAT_VERSION));
    manifest.insert(
        "unitRegistry".into(),
        json!({ "version": input.registry.0, "sha256": registry_sha }),
    );
    manifest.insert(
        "rulePacks".into(),
        json!(
            input
                .rule_packs
                .iter()
                .map(|(r, _)| r.clone())
                .collect::<Vec<_>>()
        ),
    );
    manifest.insert("originals".into(), json!(originals));
    manifest.insert("caches".into(), json!(caches));
    items.push(bytes_item(
        "README.txt".into(),
        readme(&manifest).into_bytes(),
    ));
    items.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    if items.windows(2).any(|w| w[0].path == w[1].path) {
        return Err(EngineError::internal(
            "Two entries of the project file have the same path.",
        ));
    }
    manifest.insert(
        "entries".into(),
        json!(
            items
                .iter()
                .map(|i| json!({ "path": i.path, "size": i.size, "sha256": i.sha256 }))
                .collect::<Vec<_>>()
        ),
    );
    let manifest_bytes = format!("{}\n", canonical_json(&Value::Object(manifest))).into_bytes();
    let mimetype = MIMETYPE.as_bytes();
    let mut listed: Vec<(String, String)> = vec![
        ("mimetype".into(), sha256_hex(mimetype)),
        ("manifest.json".into(), sha256_hex(&manifest_bytes)),
    ];
    listed.extend(items.iter().map(|i| (i.path.clone(), i.sha256.clone())));
    listed.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let checksums: String = listed.iter().map(|(p, h)| format!("{h}  {p}\n")).collect();

    // The mimetype first, then every other entry in path order, as the TypeScript writer orders them.
    let mut rest: Vec<Item> = items;
    rest.push(bytes_item("manifest.json".into(), manifest_bytes));
    rest.push(bytes_item(
        "CHECKSUMS.sha256".into(),
        checksums.into_bytes(),
    ));
    rest.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    let mut zip = ZipWriter::create(target)?;
    zip.add_bytes("mimetype", mimetype)?;
    let mut written = 0u64;
    for item in rest {
        match item.source {
            Source::Bytes(data) => zip.add_bytes(&item.path, &data)?,
            Source::File(_) | Source::Range(..) => {
                let phase = if item.path.starts_with("originals/") {
                    "Copying the original files"
                } else {
                    "Copying the working data"
                };
                let base = written;
                let (sha, from) = match &item.source {
                    Source::Range(archive, offset, size) => (
                        zip.add_range(&item.path, archive, *offset, *size, &mut |n| {
                            progress(phase, base + n)
                        })?,
                        archive.clone(),
                    ),
                    Source::File(src) => (
                        zip.add_file(&item.path, src, &mut |n| progress(phase, base + n))?,
                        src.clone(),
                    ),
                    Source::Bytes(_) => unreachable!(),
                };
                if sha != item.sha256 {
                    return Err(EngineError::new(
                        "INVALID_INPUT",
                        format!(
                            "{} has changed since it was imported, so it cannot be saved as the project's original.",
                            from.display()
                        ),
                        "Put the original file back as it was, or import the changed file as a new source.",
                    ));
                }
            }
        }
        written += item.size;
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_names_as_names_ts_does() {
        assert_eq!(
            safe_segment("  well: A/B?  .csv ", "file"),
            "well_ A_B_ .csv"
        );
        assert_eq!(safe_segment("...", "file"), "file");
        assert_eq!(safe_segment("con.txt", "file"), "_con.txt");
        assert_eq!(safe_segment("COM1", "file"), "_COM1");
        assert_eq!(safe_segment("tab\there", "file"), "tab_here");
        assert_eq!(safe_segment("a \u{3000} b", "file"), "a b");
        assert_eq!(suggested_file_name("North Sea.twp"), "North Sea.twp");
        assert_eq!(suggested_file_name("a/b"), "a_b.twp");
    }
}

// ---------------------------------------------------------------------------------------------
// Reading

/// Where an original's bytes are: a file on disk, or an entry stored in the project file it came from.
#[derive(Clone, Debug)]
pub enum OriginalSource {
    File(PathBuf),
    Entry {
        archive: PathBuf,
        offset: u64,
        size: u64,
    },
}

/// The SHA-256 of an original's bytes, read from wherever they are.
pub fn hash_source(source: &OriginalSource) -> Result<String> {
    match source {
        OriginalSource::File(path) => hash_file(path).map(|(sha, _)| sha),
        OriginalSource::Entry {
            archive,
            offset,
            size,
        } => {
            use std::io::{Seek, SeekFrom};
            let mut f = std::fs::File::open(archive)?;
            f.seek(SeekFrom::Start(*offset))?;
            let mut hash = Sha256::new();
            let mut buf = vec![0u8; 1 << 20];
            let mut left = *size;
            while left > 0 {
                let n = (left as usize).min(buf.len());
                f.read_exact(&mut buf[..n])?;
                hash.update(&buf[..n]);
                left -= n as u64;
            }
            Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
        }
    }
}

/// What reading a project file found: its entries, manifest and audit log, and one integrity
/// check result per check, in the order and with the IDs the TypeScript reader uses.
pub struct TwpRead {
    pub entries: Vec<crate::zip::Entry>,
    pub manifest: Option<Value>,
    pub audit_jsonl: Option<String>,
    pub checks: Vec<Value>,
    /// The paths whose bytes matched the manifest.
    pub verified: std::collections::HashSet<String>,
}

pub fn integrity(
    id: &str,
    ok: bool,
    detail: String,
    rule: Option<&str>,
    target: Option<&str>,
) -> Value {
    let mut c = json!({ "id": id, "ok": ok, "detail": detail });
    if !ok {
        if let Some(r) = rule {
            c["ruleId"] = json!(r);
        }
    }
    if let Some(t) = target {
        c["target"] = json!(t);
    }
    c
}

/// The bytes of a (small) entry.
pub fn entry_bytes(archive: &Path, e: &crate::zip::Entry) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    crate::zip::read_entry(archive, e, &mut |b| {
        out.extend_from_slice(b);
        Ok(())
    })?;
    Ok(out)
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The manifest's structure, as far as opening relies on it; an error says where it is wrong.
fn manifest_problem(m: &Value) -> Option<String> {
    let s = |k: &str| m[k].as_str().filter(|v| !v.is_empty());
    if s("projectId")
        .is_none_or(|id| !(id.len() == 18 && id.starts_with("p_") && is_hex(&id[2..], 16)))
    {
        return Some("projectId".into());
    }
    for k in ["name", "createdAt", "savedAt", "savedBy", "appVersion"] {
        if s(k).is_none() {
            return Some(k.into());
        }
    }
    let entries_ok = m["entries"].as_array().is_some_and(|a| {
        a.iter().all(|e| {
            e["path"].is_string()
                && e["size"].is_u64()
                && e["sha256"].as_str().is_some_and(|h| is_hex(h, 64))
        })
    });
    if !entries_ok {
        return Some("entries".into());
    }
    let originals_ok = m["originals"].as_array().is_some_and(|a| {
        a.iter().all(|o| {
            o["fileId"].as_str().is_some_and(|h| is_hex(h, 64))
                && o["name"].is_string()
                && o["size"].is_u64()
                && o["mediaType"].is_string()
                && o["path"].is_string()
                && o["addedSeq"].is_u64()
        })
    });
    if !originals_ok {
        return Some("originals".into());
    }
    if !m["datasets"].is_array()
        || !m["auditHead"]["seq"].is_u64()
        || !m["auditHead"]["hash"].is_string()
    {
        return Some("datasets or auditHead".into());
    }
    let caches_ok = m.get("caches").is_none_or(|c| {
        c.as_array().is_some_and(|a| {
            a.iter().all(|x| {
                x["datasetId"].is_string()
                    && x["sourceSeq"].is_u64()
                    && matches!(x["kind"].as_str(), Some("rows" | "exceptions" | "notes"))
                    && x["path"].is_string()
            })
        })
    });
    if !caches_ok {
        return Some("caches".into());
    }
    None
}

/// Reads and checks a project file. It never fails on bad content: what cannot be read is a
/// failed check, so a damaged project still opens read-only for inspection.
pub fn read_twp(archive: &Path, progress: &mut dyn FnMut(&str, u64)) -> TwpRead {
    let mut out = TwpRead {
        entries: Vec::new(),
        manifest: None,
        audit_jsonl: None,
        checks: Vec::new(),
        verified: Default::default(),
    };
    let prj4 = Some("TW-PRJ-004");
    match crate::zip::read_entries(archive) {
        Ok(entries) => out.entries = entries,
        Err(e) => {
            out.checks.push(integrity(
                "zip",
                false,
                format!("The file is not a readable ZIP archive: {}", e.message),
                prj4,
                None,
            ));
            return out;
        }
    }
    out.checks.push(integrity(
        "zip",
        true,
        "The file is a readable ZIP archive.".into(),
        None,
        None,
    ));
    let find = |name: &str| out.entries.iter().find(|e| e.name == name).cloned();
    let first_ok = out
        .entries
        .first()
        .is_some_and(|e| e.name == "mimetype" && e.method == 0)
        && find("mimetype")
            .and_then(|e| entry_bytes(archive, &e).ok())
            .is_some_and(|b| b == MIMETYPE.as_bytes());
    out.checks.push(if first_ok {
        integrity(
            "mimetype",
            true,
            "The first entry identifies a Tracewell project.".into(),
            None,
            None,
        )
    } else {
        integrity(
            "mimetype",
            false,
            format!("The first entry is not an uncompressed mimetype of \"{MIMETYPE}\"."),
            prj4,
            None,
        )
    });
    let manifest: Option<Value> = find("manifest.json")
        .and_then(|e| entry_bytes(archive, &e).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    let version = manifest
        .as_ref()
        .map(|m| (m["format"].clone(), m["formatVersion"].clone()));
    out.checks.push(match &version {
        None => integrity(
            "format-version",
            false,
            "The format version is unknown because manifest.json is missing or not JSON.".into(),
            prj4,
            None,
        ),
        Some((f, v)) if f == "tracewell-project" && (v == "0.1" || v == "0.2") => integrity(
            "format-version",
            true,
            format!(
                "Format tracewell-project {} is supported.",
                v.as_str().unwrap_or("")
            ),
            None,
            None,
        ),
        Some((_, v)) => integrity(
            "format-version",
            false,
            format!(
                "The project uses format version {v}; this version of Tracewell reads 0.1 and 0.2."
            ),
            prj4,
            None,
        ),
    });
    let manifest = match manifest {
        None => {
            out.checks.push(integrity(
                "manifest-schema",
                false,
                "The manifest cannot be checked because it is missing or not JSON.".into(),
                None,
                None,
            ));
            return out;
        }
        Some(m) => match manifest_problem(&m) {
            Some(at) => {
                out.checks.push(integrity(
                    "manifest-schema",
                    false,
                    format!("The manifest is not well formed at {at}."),
                    None,
                    None,
                ));
                return out;
            }
            None => {
                out.checks.push(integrity(
                    "manifest-schema",
                    true,
                    "The manifest is well formed.".into(),
                    None,
                    None,
                ));
                m
            }
        },
    };

    // Every listed entry present with its size and SHA-256, nothing else, and CHECKSUMS agreeing.
    let mut failures = Vec::new();
    let mut digests = std::collections::HashMap::new();
    let listed: Vec<Value> = manifest["entries"].as_array().cloned().unwrap_or_default();
    let mut done = 0u64;
    for l in &listed {
        let path = l["path"].as_str().unwrap_or("");
        let Some(e) = find(path) else {
            failures.push(integrity(
                "entry-checksum",
                false,
                format!("{path} is listed in the manifest but missing."),
                prj4,
                Some(path),
            ));
            continue;
        };
        if Some(e.size) != l["size"].as_u64() {
            failures.push(integrity(
                "entry-checksum",
                false,
                format!(
                    "{path} is {} bytes; the manifest says {}.",
                    e.size, l["size"]
                ),
                prj4,
                Some(path),
            ));
            continue;
        }
        let base = done;
        let mut seen = 0u64;
        let sha = crate::zip::read_entry(archive, &e, &mut |b| {
            seen += b.len() as u64;
            progress("Verifying the project file", base + seen);
            Ok(())
        });
        done += e.size;
        match sha {
            Ok(sha) if Some(sha.as_str()) == l["sha256"].as_str() => {
                digests.insert(path.to_string(), sha);
                out.verified.insert(path.to_string());
            }
            Ok(_) => failures.push(integrity(
                "entry-checksum",
                false,
                format!("{path} does not match its SHA-256 in the manifest."),
                prj4,
                Some(path),
            )),
            Err(err) => failures.push(integrity(
                "entry-checksum",
                false,
                format!("{path} cannot be read: {}", err.message),
                prj4,
                Some(path),
            )),
        }
    }
    let known: std::collections::HashSet<&str> =
        listed.iter().filter_map(|l| l["path"].as_str()).collect();
    for e in &out.entries {
        if !known.contains(e.name.as_str())
            && !matches!(
                e.name.as_str(),
                "mimetype" | "manifest.json" | "CHECKSUMS.sha256"
            )
        {
            failures.push(integrity(
                "entry-checksum",
                false,
                format!("{} is in the archive but not in the manifest.", e.name),
                prj4,
                Some(&e.name),
            ));
        }
    }
    let sums = find("CHECKSUMS.sha256")
        .and_then(|e| entry_bytes(archive, &e).ok())
        .map(|b| String::from_utf8_lossy(&b).into_owned());
    match sums {
        None => failures.push(integrity(
            "entry-checksum",
            false,
            "CHECKSUMS.sha256 is missing.".into(),
            prj4,
            Some("CHECKSUMS.sha256"),
        )),
        Some(text) => {
            for line in text.lines().filter(|l| !l.is_empty()) {
                let (sha, path) = line.split_once("  ").unwrap_or(("", line));
                let actual = match path {
                    "mimetype" | "manifest.json" => find(path)
                        .and_then(|e| entry_bytes(archive, &e).ok())
                        .map(|b| sha256_hex(&b)),
                    _ => digests.get(path).cloned(),
                };
                let covered = known.contains(path) || matches!(path, "mimetype" | "manifest.json");
                if covered && actual.as_deref() != Some(sha) {
                    failures.push(integrity(
                        "entry-checksum",
                        false,
                        format!("CHECKSUMS.sha256 does not agree with {path}."),
                        prj4,
                        Some(path),
                    ));
                }
            }
        }
    }
    // One finding per entry, as the TypeScript reader reports them.
    let mut seen = std::collections::HashSet::new();
    failures.retain(|f| seen.insert(f["target"].as_str().unwrap_or("").to_string()));
    if failures.is_empty() {
        out.checks.push(integrity(
            "entry-checksum",
            true,
            format!("All {} entries match their SHA-256.", listed.len()),
            None,
            None,
        ));
    } else {
        out.checks.extend(failures);
    }

    // Each original stored at its content address.
    let mut bad = Vec::new();
    for o in manifest["originals"].as_array().into_iter().flatten() {
        let (id, name, path) = (
            o["fileId"].as_str().unwrap_or(""),
            o["name"].as_str().unwrap_or(""),
            o["path"].as_str().unwrap_or(""),
        );
        if path != original_path(id, name) || digests.get(path).map(String::as_str) != Some(id) {
            bad.push(integrity(
                "original-checksum",
                false,
                format!("The original {path} does not match its content address."),
                Some("TW-PRJ-001"),
                Some(path),
            ));
        }
    }
    if bad.is_empty() {
        let n = manifest["originals"].as_array().map_or(0, Vec::len);
        out.checks.push(integrity(
            "original-checksum",
            true,
            format!("All {n} originals match their SHA-256."),
            None,
            None,
        ));
    } else {
        out.checks.extend(bad);
    }
    out.audit_jsonl = find("audit.jsonl")
        .and_then(|e| entry_bytes(archive, &e).ok())
        .map(|b| String::from_utf8_lossy(&b).into_owned());
    out.manifest = Some(manifest);
    out
}
