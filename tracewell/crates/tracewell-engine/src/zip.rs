//! Export packages and project files as ZIP archives, written and re-read the way io/zip-write.ts
//! and zip-read.ts do: a fixed 1980-01-01 timestamp, no host attributes, entries in path order.
//! Entries are written stored (the data files are large, and Parquet is compressed already), and
//! an entry or offset of 4 GiB or more uses ZIP64 fields, so an archive of any size opens in
//! standard tools. Reading also inflates deflated entries, as the TypeScript engine writes the
//! small entries of a project file, up to a size guard.

use crate::error::{EngineError, Result};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::OnceLock;

const SIG_LOCAL: u32 = 0x0403_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_END: u32 = 0x0605_4b50;
const SIG_ZIP64_END: u32 = 0x0606_4b50;
const SIG_ZIP64_LOCATOR: u32 = 0x0706_4b50;
const DOS_DATE_1980_01_01: u16 = (1 << 5) | 1;
const FLAG_UTF8_NAME: u16 = 0x0800;
const VERSION_STORED: u16 = 10;
const VERSION_ZIP64: u16 = 45;
const VERSION_MADE_BY: u16 = 20;
const MAX_U32: u64 = 0xffff_ffff;
const COPY_BYTES: usize = 4 << 20;
/** A deflated entry is inflated in memory, so it may expand to this much at most. */
const MAX_INFLATED: u64 = 512 << 20;

fn crc_tables() -> &'static [[u32; 256]; 8] {
    static TABLES: OnceLock<[[u32; 256]; 8]> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut t = [[0u32; 256]; 8];
        for i in 0..256u32 {
            let mut c = i;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            t[0][i as usize] = c;
        }
        for i in 0..256 {
            for k in 1..8 {
                let prev = t[k - 1][i];
                t[k][i] = (prev >> 8) ^ t[0][(prev & 0xff) as usize];
            }
        }
        t
    })
}

/// CRC-32 (IEEE), updated over `data` (slicing by eight).
pub fn crc32_update(crc: u32, data: &[u8]) -> u32 {
    let t = crc_tables();
    let mut c = !crc;
    let mut chunks = data.chunks_exact(8);
    for b in &mut chunks {
        let lo = c ^ u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        let hi = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
        c = t[7][(lo & 0xff) as usize]
            ^ t[6][((lo >> 8) & 0xff) as usize]
            ^ t[5][((lo >> 16) & 0xff) as usize]
            ^ t[4][(lo >> 24) as usize]
            ^ t[3][(hi & 0xff) as usize]
            ^ t[2][((hi >> 8) & 0xff) as usize]
            ^ t[1][((hi >> 16) & 0xff) as usize]
            ^ t[0][(hi >> 24) as usize];
    }
    for &b in chunks.remainder() {
        c = t[0][((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Central {
    name: Vec<u8>,
    crc: u32,
    size: u64,
    offset: u64,
}

/// A package being written.
pub struct ZipWriter {
    out: BufWriter<File>,
    pos: u64,
    entries: Vec<Central>,
}

fn invalid(msg: String) -> EngineError {
    EngineError::internal(msg)
}

impl ZipWriter {
    pub fn create(path: &Path) -> Result<ZipWriter> {
        Ok(ZipWriter {
            out: BufWriter::with_capacity(1 << 20, File::create(path)?),
            pos: 0,
            entries: Vec::new(),
        })
    }

    fn put(&mut self, bytes: &[u8]) -> Result<()> {
        self.out.write_all(bytes)?;
        self.pos += bytes.len() as u64;
        Ok(())
    }

    fn local_header(&mut self, name: &[u8], crc: u32, size: u64) -> Result<()> {
        let zip64 = size >= MAX_U32;
        let mut h = Vec::with_capacity(30 + name.len() + 20);
        h.extend_from_slice(&SIG_LOCAL.to_le_bytes());
        h.extend_from_slice(&(if zip64 { VERSION_ZIP64 } else { VERSION_STORED }).to_le_bytes());
        let flags = if name.is_ascii() { 0 } else { FLAG_UTF8_NAME };
        h.extend_from_slice(&flags.to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes()); // stored
        h.extend_from_slice(&0u16.to_le_bytes()); // midnight
        h.extend_from_slice(&DOS_DATE_1980_01_01.to_le_bytes());
        h.extend_from_slice(&crc.to_le_bytes());
        let short = if zip64 { MAX_U32 as u32 } else { size as u32 };
        h.extend_from_slice(&short.to_le_bytes());
        h.extend_from_slice(&short.to_le_bytes());
        h.extend_from_slice(&(name.len() as u16).to_le_bytes());
        h.extend_from_slice(&(if zip64 { 20u16 } else { 0 }).to_le_bytes());
        h.extend_from_slice(name);
        if zip64 {
            h.extend_from_slice(&1u16.to_le_bytes());
            h.extend_from_slice(&16u16.to_le_bytes());
            h.extend_from_slice(&size.to_le_bytes());
            h.extend_from_slice(&size.to_le_bytes());
        }
        self.put(&h)
    }

    /// Adds an entry from memory.
    pub fn add_bytes(&mut self, name: &str, data: &[u8]) -> Result<()> {
        let crc = crc32_update(0, data);
        let offset = self.pos;
        self.local_header(name.as_bytes(), crc, data.len() as u64)?;
        self.put(data)?;
        self.entries.push(Central {
            name: name.as_bytes().to_vec(),
            crc,
            size: data.len() as u64,
            offset,
        });
        Ok(())
    }

    /// Adds an entry copied from a file, returning the SHA-256 of its bytes. The CRC is written
    /// into the header once the copy is done.
    pub fn add_file(
        &mut self,
        name: &str,
        src: &Path,
        progress: &mut dyn FnMut(u64),
    ) -> Result<String> {
        let size = std::fs::metadata(src)?.len();
        let offset = self.pos;
        self.local_header(name.as_bytes(), 0, size)?;
        let mut input = File::open(src)?;
        let mut buf = vec![0u8; COPY_BYTES];
        let (mut crc, mut hash, mut copied) = (0u32, Sha256::new(), 0u64);
        loop {
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            crc = crc32_update(crc, &buf[..n]);
            hash.update(&buf[..n]);
            self.put(&buf[..n])?;
            copied += n as u64;
            progress(copied);
        }
        if copied != size {
            return Err(invalid(format!("{name} changed while it was packaged.")));
        }
        self.out.flush()?;
        let file = self.out.get_mut();
        file.seek(SeekFrom::Start(offset + 14))?;
        file.write_all(&crc.to_le_bytes())?;
        file.seek(SeekFrom::Start(self.pos))?;
        self.entries.push(Central {
            name: name.as_bytes().to_vec(),
            crc,
            size,
            offset,
        });
        Ok(hex(&hash.finalize()))
    }

    /// Adds an entry copied from `len` bytes of `src` at `offset` (an entry stored in another
    /// archive), returning the SHA-256 of the bytes.
    pub fn add_range(
        &mut self,
        name: &str,
        src: &Path,
        offset: u64,
        len: u64,
        progress: &mut dyn FnMut(u64),
    ) -> Result<String> {
        let start = self.pos;
        self.local_header(name.as_bytes(), 0, len)?;
        let mut input = File::open(src)?;
        input.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; COPY_BYTES];
        let (mut crc, mut hash, mut left) = (0u32, Sha256::new(), len);
        while left > 0 {
            let n = (left as usize).min(buf.len());
            input.read_exact(&mut buf[..n])?;
            crc = crc32_update(crc, &buf[..n]);
            hash.update(&buf[..n]);
            self.put(&buf[..n])?;
            left -= n as u64;
            progress(len - left);
        }
        self.out.flush()?;
        let file = self.out.get_mut();
        file.seek(SeekFrom::Start(start + 14))?;
        file.write_all(&crc.to_le_bytes())?;
        file.seek(SeekFrom::Start(self.pos))?;
        self.entries.push(Central {
            name: name.as_bytes().to_vec(),
            crc,
            size: len,
            offset: start,
        });
        Ok(hex(&hash.finalize()))
    }

    /// Writes the central directory and returns the archive's size.
    pub fn finish(mut self) -> Result<u64> {
        let start = self.pos;
        let entries = std::mem::take(&mut self.entries);
        for e in &entries {
            let (big_size, big_offset) = (e.size >= MAX_U32, e.offset >= MAX_U32);
            let mut extra = Vec::new();
            if big_size {
                extra.extend_from_slice(&e.size.to_le_bytes());
                extra.extend_from_slice(&e.size.to_le_bytes());
            }
            if big_offset {
                extra.extend_from_slice(&e.offset.to_le_bytes());
            }
            let mut h = Vec::with_capacity(46 + e.name.len() + 4 + extra.len());
            h.extend_from_slice(&SIG_CENTRAL.to_le_bytes());
            h.extend_from_slice(&VERSION_MADE_BY.to_le_bytes());
            let needed = if big_size || big_offset {
                VERSION_ZIP64
            } else {
                VERSION_STORED
            };
            h.extend_from_slice(&needed.to_le_bytes());
            let flags = if e.name.is_ascii() { 0 } else { FLAG_UTF8_NAME };
            h.extend_from_slice(&flags.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            h.extend_from_slice(&DOS_DATE_1980_01_01.to_le_bytes());
            h.extend_from_slice(&e.crc.to_le_bytes());
            let short = if big_size {
                MAX_U32 as u32
            } else {
                e.size as u32
            };
            h.extend_from_slice(&short.to_le_bytes());
            h.extend_from_slice(&short.to_le_bytes());
            h.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            let extra_len = if extra.is_empty() { 0 } else { 4 + extra.len() };
            h.extend_from_slice(&(extra_len as u16).to_le_bytes());
            h.extend_from_slice(&[0u8; 8]); // comment length, disk, internal and external attributes
            h.extend_from_slice(&[0u8; 2]);
            let offset = if big_offset {
                MAX_U32 as u32
            } else {
                e.offset as u32
            };
            h.extend_from_slice(&offset.to_le_bytes());
            h.extend_from_slice(&e.name);
            if !extra.is_empty() {
                h.extend_from_slice(&1u16.to_le_bytes());
                h.extend_from_slice(&(extra.len() as u16).to_le_bytes());
                h.extend_from_slice(&extra);
            }
            self.put(&h)?;
        }
        let size = self.pos - start;
        let count = entries.len() as u64;
        if start >= MAX_U32 || size >= MAX_U32 || count >= 0xffff {
            let at = self.pos;
            let mut z = Vec::with_capacity(76);
            z.extend_from_slice(&SIG_ZIP64_END.to_le_bytes());
            z.extend_from_slice(&44u64.to_le_bytes());
            z.extend_from_slice(&VERSION_ZIP64.to_le_bytes());
            z.extend_from_slice(&VERSION_ZIP64.to_le_bytes());
            z.extend_from_slice(&[0u8; 8]);
            z.extend_from_slice(&count.to_le_bytes());
            z.extend_from_slice(&count.to_le_bytes());
            z.extend_from_slice(&size.to_le_bytes());
            z.extend_from_slice(&start.to_le_bytes());
            z.extend_from_slice(&SIG_ZIP64_LOCATOR.to_le_bytes());
            z.extend_from_slice(&0u32.to_le_bytes());
            z.extend_from_slice(&at.to_le_bytes());
            z.extend_from_slice(&1u32.to_le_bytes());
            self.put(&z)?;
        }
        let mut end = Vec::with_capacity(22);
        end.extend_from_slice(&SIG_END.to_le_bytes());
        end.extend_from_slice(&[0u8; 4]);
        let short_count = count.min(0xffff) as u16;
        end.extend_from_slice(&short_count.to_le_bytes());
        end.extend_from_slice(&short_count.to_le_bytes());
        end.extend_from_slice(&(size.min(MAX_U32) as u32).to_le_bytes());
        end.extend_from_slice(&(start.min(MAX_U32) as u32).to_le_bytes());
        end.extend_from_slice(&0u16.to_le_bytes());
        self.put(&end)?;
        self.out.flush()?;
        Ok(self.pos)
    }
}

/// An entry of an archive being re-read: where its stored bytes are.
#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub method: u16,
    pub crc: u32,
    pub size: u64,
    /// The bytes it takes in the archive: its size when stored.
    pub compressed: u64,
    pub data_offset: u64,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

fn u64_at(b: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(b[i..i + 8].try_into().unwrap_or([0; 8]))
}

fn broken(why: &str) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The package is not a valid ZIP archive: {why}."),
        "Export the data again.",
    )
}

/// Lists an archive's entries from its central directory, ZIP64 records included.
pub fn read_entries(path: &Path) -> Result<Vec<Entry>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let tail_len = len.min(22 + 0xffff + 20) as usize;
    let mut tail = vec![0u8; tail_len];
    f.seek(SeekFrom::Start(len - tail_len as u64))?;
    f.read_exact(&mut tail)?;
    let end = (0..=tail_len.saturating_sub(22))
        .rev()
        .find(|&i| u32_at(&tail, i) == SIG_END)
        .ok_or_else(|| broken("the end of central directory record is missing"))?;
    let mut count = u16_at(&tail, end + 10) as u64;
    let mut size = u32_at(&tail, end + 12) as u64;
    let mut start = u32_at(&tail, end + 16) as u64;
    if end >= 20 && u32_at(&tail, end - 20) == SIG_ZIP64_LOCATOR {
        let at = u64_at(&tail, end - 12);
        let mut z = [0u8; 56];
        f.seek(SeekFrom::Start(at))?;
        f.read_exact(&mut z)?;
        if u32_at(&z, 0) != SIG_ZIP64_END {
            return Err(broken(
                "the ZIP64 end of central directory record is missing",
            ));
        }
        count = u64_at(&z, 32);
        size = u64_at(&z, 40);
        start = u64_at(&z, 48);
    }
    if start + size > len {
        return Err(broken("the central directory lies outside the file"));
    }
    let mut dir = vec![0u8; size as usize];
    f.seek(SeekFrom::Start(start))?;
    f.read_exact(&mut dir)?;
    let mut entries = Vec::new();
    let mut i = 0;
    for _ in 0..count {
        if i + 46 > dir.len() || u32_at(&dir, i) != SIG_CENTRAL {
            return Err(broken("a central directory entry is damaged"));
        }
        let method = u16_at(&dir, i + 10);
        let crc = u32_at(&dir, i + 16);
        let mut csize = u32_at(&dir, i + 20) as u64;
        let mut usize_ = u32_at(&dir, i + 24) as u64;
        let (name_len, extra_len, comment_len) = (
            u16_at(&dir, i + 28) as usize,
            u16_at(&dir, i + 30) as usize,
            u16_at(&dir, i + 32) as usize,
        );
        let mut offset = u32_at(&dir, i + 42) as u64;
        let name = String::from_utf8_lossy(&dir[i + 46..i + 46 + name_len]).into_owned();
        let mut x = i + 46 + name_len;
        let extra_end = x + extra_len;
        while x + 4 <= extra_end {
            let (id, n) = (u16_at(&dir, x), u16_at(&dir, x + 2) as usize);
            if id == 1 {
                let mut p = x + 4;
                if usize_ == MAX_U32 {
                    usize_ = u64_at(&dir, p);
                    p += 8;
                }
                if csize == MAX_U32 {
                    csize = u64_at(&dir, p);
                    p += 8;
                }
                if offset == MAX_U32 {
                    offset = u64_at(&dir, p);
                }
            }
            x += 4 + n;
        }
        let mut local = [0u8; 30];
        f.seek(SeekFrom::Start(offset))?;
        f.read_exact(&mut local)?;
        if u32_at(&local, 0) != SIG_LOCAL {
            return Err(broken(&format!("the local header of {name} is missing")));
        }
        let data_offset = offset + 30 + u16_at(&local, 26) as u64 + u16_at(&local, 28) as u64;
        if data_offset + csize > len {
            return Err(broken(&format!("{name} runs past the end of the file")));
        }
        entries.push(Entry {
            name,
            method,
            crc,
            size: usize_,
            compressed: csize,
            data_offset,
        });
        i = extra_end + comment_len;
    }
    Ok(entries)
}

/// Streams an entry's stored bytes to `sink`, checking its CRC; returns their SHA-256.
pub fn read_entry(
    path: &Path,
    e: &Entry,
    sink: &mut dyn FnMut(&[u8]) -> Result<()>,
) -> Result<String> {
    if e.method == 8 {
        return read_deflated(path, e, sink);
    }
    if e.method != 0 {
        return Err(broken(&format!(
            "{} uses a compression method other than store or deflate",
            e.name
        )));
    }
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(e.data_offset))?;
    let mut left = e.size;
    let mut buf = vec![0u8; COPY_BYTES];
    let (mut crc, mut hash) = (0u32, Sha256::new());
    while left > 0 {
        let n = (left as usize).min(buf.len());
        f.read_exact(&mut buf[..n])?;
        crc = crc32_update(crc, &buf[..n]);
        hash.update(&buf[..n]);
        sink(&buf[..n])?;
        left -= n as u64;
    }
    if crc != e.crc {
        return Err(broken(&format!("{} does not match its CRC-32", e.name)));
    }
    Ok(hex(&hash.finalize()))
}

fn read_deflated(
    path: &Path,
    e: &Entry,
    sink: &mut dyn FnMut(&[u8]) -> Result<()>,
) -> Result<String> {
    if e.size > MAX_INFLATED || e.compressed > MAX_INFLATED {
        return Err(broken(&format!(
            "{} would expand beyond {} bytes",
            e.name, MAX_INFLATED
        )));
    }
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(e.data_offset))?;
    let mut packed = vec![0u8; e.compressed as usize];
    f.read_exact(&mut packed)?;
    let data = miniz_oxide::inflate::decompress_to_vec_with_limit(&packed, e.size as usize)
        .map_err(|_| broken(&format!("{} cannot be inflated", e.name)))?;
    if data.len() as u64 != e.size || crc32_update(0, &data) != e.crc {
        return Err(broken(&format!("{} does not match its CRC-32", e.name)));
    }
    sink(&data)?;
    Ok(hex(&Sha256::digest(&data)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32_update(0, b"123456789"), 0xcbf4_3926);
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7) as u8).collect();
        let whole = crc32_update(0, &data);
        assert_eq!(
            crc32_update(crc32_update(0, &data[..333]), &data[333..]),
            whole
        );
    }

    #[test]
    fn writes_and_rereads_a_package() {
        let dir = std::env::temp_dir().join(format!("tw-zip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("data.bin");
        std::fs::write(&src, vec![7u8; 100_000]).unwrap();
        let zip = dir.join("p.zip");
        let mut w = ZipWriter::create(&zip).unwrap();
        w.add_bytes("README.txt", b"hello").unwrap();
        let sha = w.add_file("data.bin", &src, &mut |_| {}).unwrap();
        w.add_bytes("\u{fc}.txt", b"").unwrap();
        w.finish().unwrap();
        let entries = read_entries(&zip).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["README.txt", "data.bin", "\u{fc}.txt"]
        );
        let mut out = Vec::new();
        let got = read_entry(&zip, &entries[1], &mut |b| {
            out.extend_from_slice(b);
            Ok(())
        })
        .unwrap();
        assert_eq!(got, sha);
        assert_eq!(out.len(), 100_000);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
