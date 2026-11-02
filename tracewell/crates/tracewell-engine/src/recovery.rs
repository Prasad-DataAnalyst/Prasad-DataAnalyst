//! Crash recovery journals (FR-PRJ-03, SAD section 11.2) on disk, as journal-store.ts keeps them
//! in the browser. Each engine session has a folder under the recovery folder holding its
//! project's audit log, copies of the originals the engine itself holds (uploads into its working
//! folder), and `journal.json`, which names the project and every original and is written last.
//! An original the user imported from their own disk is named by its path rather than copied, so a
//! 10 GB file is not written twice; recovery checks it against its SHA-256 like any original.
//!
//! A session holds an exclusive lock on its folder's `lock` file for as long as it runs, and the
//! operating system releases it when the process ends, however it ends. A journal is offered for
//! recovery only when its lock can be taken, so a running engine never loses its work to another.

use crate::error::{EngineError, Result};
use crate::project::OriginalSource;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};

const FORMAT: &str = "tracewell-journal";
const JOURNAL: &str = "journal.json";
const AUDIT: &str = "audit.jsonl";
const ORIGINALS: &str = "originals";
const LOCK: &str = "lock";

/// A journal another session left behind.
pub struct Found {
    pub project_id: String,
    pub name: String,
    pub updated_at: String,
    pub audit_jsonl: String,
    /// Each original's info and where its bytes are.
    pub originals: Vec<(Value, OriginalSource)>,
}

/// This session's journal, and the orphan it found last.
pub struct Journal {
    root: PathBuf,
    dir: PathBuf,
    /// Held for the session's lifetime; dropping it releases the lock.
    _lock: File,
    copied: HashSet<String>,
    orphan: Option<PathBuf>,
}

fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    crate::time::iso_from_millis(ms)
}

/// Writes a file whole, then renames it into place, so a reader never sees half of it.
fn write_whole(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn is_file_id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

impl Journal {
    /// Starts this session's journal under `root`, locked until the process ends.
    pub fn open(root: &Path) -> Result<Journal> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = root.join(format!("{}-{nanos:x}", std::process::id()));
        std::fs::create_dir_all(dir.join(ORIGINALS))?;
        let lock = File::create(dir.join(LOCK))?;
        lock.try_lock().map_err(|_| {
            EngineError::internal("The recovery journal of this session could not be locked.")
        })?;
        Ok(Journal {
            root: root.to_path_buf(),
            dir,
            _lock: lock,
            copied: HashSet::new(),
            orphan: None,
        })
    }

    /// Whether a file lives in a recovery journal, which is deleted once recovered.
    pub fn holds(&self, path: &Path) -> bool {
        path.starts_with(&self.root)
    }

    /// Writes the journal: the audit log as it stands and every original, each copied once when
    /// `copy` says the engine holds the only copy.
    pub fn write(
        &mut self,
        project_id: &str,
        name: &str,
        audit_jsonl: &str,
        originals: &[(Value, OriginalSource, bool)],
    ) -> Result<()> {
        let mut listed = Vec::new();
        for (info, source, copy) in originals {
            let id = info["fileId"].as_str().unwrap_or_default().to_string();
            if *copy {
                if !self.copied.contains(&id) {
                    let dest = self.dir.join(ORIGINALS).join(&id);
                    match source {
                        OriginalSource::File(path) => {
                            std::fs::copy(path, &dest)?;
                        }
                        OriginalSource::Entry { .. } => {}
                    }
                    self.copied.insert(id.clone());
                }
                listed.push(json!({ "info": info, "copy": true }));
            } else {
                listed.push(match source {
                    OriginalSource::File(path) => {
                        json!({ "info": info, "path": path.to_string_lossy() })
                    }
                    OriginalSource::Entry {
                        archive,
                        offset,
                        size,
                    } => json!({
                        "info": info,
                        "archive": archive.to_string_lossy(),
                        "offset": offset,
                        "size": size,
                    }),
                });
            }
        }
        write_whole(&self.dir.join(AUDIT), audit_jsonl.as_bytes())?;
        let head = json!({
            "format": FORMAT,
            "projectId": project_id,
            "name": name,
            "updatedAt": now_iso(),
            "originals": listed,
        });
        write_whole(
            &self.dir.join(JOURNAL),
            serde_json::to_string_pretty(&head)
                .unwrap_or_default()
                .as_bytes(),
        )
    }

    /// Whether another session still holds a folder's lock.
    fn live(dir: &Path) -> bool {
        match File::open(dir.join(LOCK)) {
            Ok(f) => matches!(f.try_lock(), Err(TryLockError::WouldBlock)),
            Err(_) => false,
        }
    }

    fn read(dir: &Path) -> Option<Found> {
        let head: Value = serde_json::from_slice(&std::fs::read(dir.join(JOURNAL)).ok()?).ok()?;
        let project_id = head["projectId"].as_str()?;
        let valid_id = project_id.len() == 18
            && project_id.starts_with("p_")
            && project_id[2..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if head["format"] != FORMAT || !valid_id {
            return None;
        }
        let mut originals = Vec::new();
        for o in head["originals"].as_array()? {
            let info = &o["info"];
            if !is_file_id(&info["fileId"])
                || !info["name"].is_string()
                || !info["size"].is_number()
            {
                return None;
            }
            let source = if o["copy"] == true {
                OriginalSource::File(dir.join(ORIGINALS).join(info["fileId"].as_str()?))
            } else if let Some(path) = o["path"].as_str() {
                OriginalSource::File(PathBuf::from(path))
            } else {
                OriginalSource::Entry {
                    archive: PathBuf::from(o["archive"].as_str()?),
                    offset: o["offset"].as_u64()?,
                    size: o["size"].as_u64()?,
                }
            };
            originals.push((info.clone(), source));
        }
        Some(Found {
            project_id: project_id.to_string(),
            name: head["name"].as_str()?.to_string(),
            updated_at: head["updatedAt"].as_str()?.to_string(),
            audit_jsonl: std::fs::read_to_string(dir.join(AUDIT)).ok()?,
            originals,
        })
    }

    /// The most recent journal of a session that has ended, or None.
    pub fn find_orphan(&mut self) -> Option<Found> {
        let mut ended: Vec<(String, PathBuf, Found)> = Vec::new();
        for d in std::fs::read_dir(&self.root)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
        {
            if !d.is_dir() || d == self.dir || Self::live(&d) {
                continue;
            }
            match Self::read(&d) {
                Some(f) => ended.push((f.updated_at.clone(), d, f)),
                // A session that ended before it journalled anything, or a journal that cannot be
                // read, holds nothing to recover.
                None => {
                    let _ = std::fs::remove_dir_all(&d);
                }
            }
        }
        ended.sort_by(|a, b| b.0.cmp(&a.0));
        let (_, dir, found) = ended.into_iter().next()?;
        self.orphan = Some(dir);
        Some(found)
    }

    /// Deletes the journal find_orphan returned last, once it is recovered or discarded.
    pub fn drop_orphan(&mut self) {
        if let Some(dir) = self.orphan.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
