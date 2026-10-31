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
    /// Each original's manifest record (fileId, name, size, mediaType, addedSeq) and its file.
    pub originals: Vec<(Value, PathBuf)>,
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
            source: Source::File(source),
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
            Source::File(src) => {
                let phase = if item.path.starts_with("originals/") {
                    "Copying the original files"
                } else {
                    "Copying the working data"
                };
                let base = written;
                let sha = zip.add_file(&item.path, &src, &mut |n| progress(phase, base + n))?;
                if sha != item.sha256 {
                    return Err(EngineError::new(
                        "INVALID_INPUT",
                        format!(
                            "{} has changed since it was imported, so it cannot be saved as the project's original.",
                            src.display()
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
