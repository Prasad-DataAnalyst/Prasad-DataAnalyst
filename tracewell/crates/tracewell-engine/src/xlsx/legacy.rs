//! Legacy Excel workbooks (cfb.ts and biff.ts): BIFF8 records in the "Workbook" stream of an OLE
//! compound file, read into the same workbook model as .xlsx, so layout detection and the importer
//! treat both alike. The globals give the sheets, the date system, the number formats and the
//! shared strings; each sheet's records give its cells and merged ranges. Formulas keep their
//! cached results and are never evaluated. Excel 5.0/95 files and encrypted ones are refused with
//! what to do instead.
//!
//! Every sector number is checked and every chain is bounded by the number of sectors in the file,
//! so a damaged or hostile file ends in an error, never in a loop or a read outside the bytes.

use super::book::{CellFormat, cell_format, serial_to_date_value};
use super::{Cell, CellRange, Row, Sheet, damaged, not_a_workbook, used_range};
use crate::error::Result;
use crate::parse::Raw;
use std::collections::{BTreeMap, HashMap};

pub const SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const END_OF_CHAIN: u32 = 0xFFFF_FFFE;
const FREE: u32 = 0xFFFF_FFFF;
const HEADER_DIFAT: usize = 109;
const DIRECTORY_ENTRY: usize = 128;

// ---------------------------------------------------------------------------------------------
// The compound file (cfb.ts)

struct CfbEntry {
    name: String,
    /// 1 storage, 2 stream, 5 root.
    kind: u8,
    start: u32,
    size: u64,
}

struct CompoundFile<'a> {
    bytes: &'a [u8],
    sector_size: usize,
    mini_cutoff: u32,
    fat: Vec<u32>,
    mini_fat: Vec<u32>,
    entries: Vec<CfbEntry>,
    mini_stream: Option<Vec<u8>>,
}

fn words(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect()
}

impl<'a> CompoundFile<'a> {
    fn new(bytes: &'a [u8]) -> Result<CompoundFile<'a>> {
        let mut cfb = CompoundFile {
            bytes,
            sector_size: 512,
            mini_cutoff: 0,
            fat: Vec::new(),
            mini_fat: Vec::new(),
            entries: Vec::new(),
            mini_stream: None,
        };
        let sector_shift = cfb.u16(0x1E)?;
        let mini_shift = cfb.u16(0x20)?;
        if (sector_shift != 9 && sector_shift != 12) || mini_shift != 6 {
            return Err(damaged(format!(
                "the compound file has sectors of 2^{sector_shift} bytes, which is not valid."
            )));
        }
        cfb.sector_size = 1 << sector_shift;
        cfb.mini_cutoff = cfb.u32(0x38)?;
        cfb.fat = cfb.read_fat()?;
        let mini_fat_start = cfb.u32(0x3C)?;
        cfb.mini_fat = words(&cfb.chain(mini_fat_start, FREE)?);
        cfb.entries = cfb.read_directory()?;
        Ok(cfb)
    }

    fn u16(&self, at: usize) -> Result<u16> {
        self.bytes
            .get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .ok_or_else(|| damaged("the compound file is cut short."))
    }

    fn u32(&self, at: usize) -> Result<u32> {
        self.bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| damaged("the compound file is cut short."))
    }

    /// Sectors after the header sector; a last sector cut short still counts.
    fn sector_count(&self) -> usize {
        self.bytes
            .len()
            .saturating_sub(self.sector_size)
            .div_ceil(self.sector_size)
    }

    fn sector(&self, n: u32) -> Result<&'a [u8]> {
        if n as usize >= self.sector_count() {
            return Err(damaged(format!(
                "the compound file refers to sector {n}, which it does not have."
            )));
        }
        let start = (n as usize + 1) * self.sector_size;
        Ok(&self.bytes[start..(start + self.sector_size).min(self.bytes.len())])
    }

    /// The FAT sectors named by the header and the DIFAT chain, joined.
    fn read_fat(&self) -> Result<Vec<u32>> {
        let count = self.u32(0x2C)? as usize;
        let mut ids: Vec<u32> = Vec::new();
        for i in 0..count.min(HEADER_DIFAT) {
            ids.push(self.u32(0x4C + i * 4)?);
        }
        let mut next = self.u32(0x44)?;
        let per_difat = self.sector_size / 4 - 1;
        let mut guard = 0;
        while ids.len() < count && next != END_OF_CHAIN && next != FREE {
            if guard > self.sector_count() {
                return Err(damaged("the compound file allocation table loops."));
            }
            guard += 1;
            let w = words(self.sector(next)?);
            for &id in w.iter().take(per_difat) {
                if ids.len() >= count {
                    break;
                }
                ids.push(id);
            }
            next = w.get(per_difat).copied().unwrap_or(END_OF_CHAIN);
        }
        if ids.len() < count {
            return Err(damaged("the compound file allocation table is incomplete."));
        }
        let per_sector = self.sector_size / 4;
        let mut fat = vec![0u32; count * per_sector];
        for (i, &id) in ids.iter().enumerate() {
            let w = words(self.sector(id)?);
            fat[i * per_sector..i * per_sector + w.len()].copy_from_slice(&w);
        }
        Ok(fat)
    }

    /// The sectors of a chain, joined; `none` is the start value that means an empty chain.
    fn chain(&self, start: u32, none: u32) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut n = start;
        let mut guard = 0;
        while n != END_OF_CHAIN && n != none {
            if guard > self.sector_count() || n as usize >= self.fat.len() {
                return Err(damaged(
                    "a sector chain in the compound file is broken or loops.",
                ));
            }
            guard += 1;
            out.extend_from_slice(self.sector(n)?);
            n = self.fat[n as usize];
        }
        Ok(out)
    }

    fn read_directory(&self) -> Result<Vec<CfbEntry>> {
        let dir = self.chain(self.u32(0x30)?, FREE)?;
        let u16_at = |at: usize| u16::from_le_bytes([dir[at], dir[at + 1]]);
        let u32_at =
            |at: usize| u32::from_le_bytes([dir[at], dir[at + 1], dir[at + 2], dir[at + 3]]);
        let mut entries = Vec::new();
        let mut at = 0;
        while at + DIRECTORY_ENTRY <= dir.len() {
            let name_bytes = (u16_at(at + 0x40) as usize).min(64);
            let mut units = Vec::new();
            let mut i = 0;
            while i + 2 + 2 <= name_bytes {
                units.push(u16_at(at + i));
                i += 2;
            }
            let (low, high) = (u32_at(at + 0x78) as u64, u32_at(at + 0x7C) as u64);
            entries.push(CfbEntry {
                name: String::from_utf16_lossy(&units),
                kind: dir[at + 0x42],
                start: u32_at(at + 0x74),
                // Version 3 files leave the high half undefined; no stream here nears 4 GiB.
                size: if self.sector_size == 512 {
                    low
                } else {
                    (high << 32) + low
                },
            });
            at += DIRECTORY_ENTRY;
        }
        if entries.first().map(|e| e.kind) != Some(5) {
            return Err(damaged("the compound file has no root entry."));
        }
        Ok(entries)
    }

    fn has(&self, name: &str) -> bool {
        let name = name.to_lowercase();
        self.entries.iter().any(|e| e.name.to_lowercase() == name)
    }

    /// The bytes of the first stream with this name (compared without case).
    fn stream(&mut self, name: &str) -> Result<Option<Vec<u8>>> {
        let wanted = name.to_lowercase();
        let Some(i) = self
            .entries
            .iter()
            .position(|e| e.kind == 2 && e.name.to_lowercase() == wanted)
        else {
            return Ok(None);
        };
        let (start, size, name) = (
            self.entries[i].start,
            self.entries[i].size,
            self.entries[i].name.clone(),
        );
        if size > self.bytes.len() as u64 * 2 {
            return Err(damaged(format!(
                "the stream \"{name}\" claims {size} bytes, more than the file holds."
            )));
        }
        let mut data = if size < self.mini_cutoff as u64 {
            self.read_mini(start, size)?
        } else {
            self.chain(start, FREE)?
        };
        if (data.len() as u64) < size {
            return Err(damaged(format!("the stream \"{name}\" is cut short.")));
        }
        data.truncate(size as usize);
        Ok(Some(data))
    }

    fn read_mini(&mut self, start: u32, size: u64) -> Result<Vec<u8>> {
        if size == 0 {
            return Ok(Vec::new());
        }
        if self.mini_stream.is_none() {
            let root = self.entries[0].start;
            self.mini_stream = Some(self.chain(root, FREE)?);
        }
        let mini = self.mini_stream.as_deref().unwrap_or(&[]);
        let limit = mini.len() / 64;
        let mut out = Vec::new();
        let mut n = start;
        let mut guard = 0;
        while n != END_OF_CHAIN {
            if guard > limit || n as usize >= self.mini_fat.len() || n as usize >= limit {
                return Err(damaged(
                    "a mini-sector chain in the compound file is broken or loops.",
                ));
            }
            guard += 1;
            let at = n as usize * 64;
            out.extend_from_slice(&mini[at..(at + 64).min(mini.len())]);
            n = self.mini_fat[n as usize];
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------------------------
// BIFF8 records (biff.ts)

const BOF: u16 = 0x0809;
const EOF: u16 = 0x000A;
const CONTINUE: u16 = 0x003C;
const FILEPASS: u16 = 0x002F;
const DATEMODE: u16 = 0x0022;
const FORMAT: u16 = 0x041E;
const XF: u16 = 0x00E0;
const BOUNDSHEET: u16 = 0x0085;
const SST: u16 = 0x00FC;
const LABELSST: u16 = 0x00FD;
const LABEL: u16 = 0x0204;
const NUMBER: u16 = 0x0203;
const RK: u16 = 0x027E;
const MULRK: u16 = 0x00BD;
const BOOLERR: u16 = 0x0205;
const FORMULA: u16 = 0x0006;
const STRING: u16 = 0x0207;
const MERGEDCELLS: u16 = 0x00E5;
const WINDOW2: u16 = 0x023E;
const PANE: u16 = 0x0041;
const BIFF8: u16 = 0x0600;

const RESAVE_FIX: &str = "Open the file in Excel or LibreOffice and save it as an Excel workbook (.xlsx), then import the new copy.";

/// The text Excel shows for a BIFF error code.
fn error_text(code: Option<u8>) -> &'static str {
    match code {
        Some(0x00) => "#NULL!",
        Some(0x07) => "#DIV/0!",
        Some(0x0F) => "#VALUE!",
        Some(0x17) => "#REF!",
        Some(0x1D) => "#NAME?",
        Some(0x24) => "#NUM!",
        Some(0x2A) => "#N/A",
        Some(0x2B) => "#GETTING_DATA",
        _ => "#VALUE!",
    }
}

fn short() -> crate::error::EngineError {
    damaged("a record is shorter than its content.")
}

fn u16_at(b: &[u8], at: usize) -> Result<u16> {
    b.get(at..at + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .ok_or_else(short)
}

fn u32_at(b: &[u8], at: usize) -> Result<u32> {
    Ok(u16_at(b, at)? as u32 | (u16_at(b, at + 2)? as u32) << 16)
}

fn f64_at(b: &[u8], at: usize) -> Result<f64> {
    let s = b.get(at..at + 8).ok_or_else(short)?;
    Ok(f64::from_le_bytes([
        s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
    ]))
}

struct Record<'a> {
    kind: u16,
    data: &'a [u8],
    /// The data of the CONTINUE records that follow, which belong to this record.
    continues: Vec<&'a [u8]>,
}

/// The records of a stream from `at`, each with its CONTINUE records.
struct Records<'a> {
    stream: &'a [u8],
    at: usize,
}

impl<'a> Iterator for Records<'a> {
    type Item = Result<Record<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        let s = self.stream;
        if self.at + 4 > s.len() {
            return None;
        }
        let step = (|| -> Result<Record<'a>> {
            let at = self.at;
            let kind = u16_at(s, at)?;
            let end = at + 4 + u16_at(s, at + 2)? as usize;
            if end > s.len() {
                return Err(damaged(format!(
                    "the record at byte {at} of the workbook runs past its end."
                )));
            }
            let mut record = Record {
                kind,
                data: &s[at + 4..end],
                continues: Vec::new(),
            };
            self.at = end;
            while self.at + 4 <= s.len() && u16_at(s, self.at)? == CONTINUE {
                let next = self.at + 4 + u16_at(s, self.at + 2)? as usize;
                if next > s.len() {
                    return Err(damaged(format!(
                        "the record at byte {} of the workbook runs past its end.",
                        self.at
                    )));
                }
                record.continues.push(&s[self.at + 4..next]);
                self.at = next;
            }
            Ok(record)
        })();
        if step.is_err() {
            self.at = s.len();
        }
        Some(step)
    }
}

fn records(stream: &[u8], from: usize) -> Records<'_> {
    Records { stream, at: from }
}

/// Reads across a record and its CONTINUE records, as the shared strings need.
struct Segments<'a> {
    segs: Vec<&'a [u8]>,
    i: usize,
    pos: usize,
}

impl<'a> Segments<'a> {
    fn new(data: &'a [u8], continues: &[&'a [u8]], start: usize) -> Segments<'a> {
        let mut segs = vec![data];
        segs.extend_from_slice(continues);
        Segments {
            segs,
            i: 0,
            pos: start,
        }
    }

    fn current(&mut self) -> Result<&'a [u8]> {
        while self.i < self.segs.len() && self.pos >= self.segs[self.i].len() {
            self.i += 1;
            self.pos = 0;
        }
        self.segs
            .get(self.i)
            .copied()
            .ok_or_else(|| damaged("a record ends in the middle of a value."))
    }

    fn u8(&mut self) -> Result<u8> {
        let seg = self.current()?;
        let b = seg[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(self.u8()? as u16 | (self.u8()? as u16) << 8)
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(self.u16()? as u32 | (self.u16()? as u32) << 16)
    }

    fn skip(&mut self, n: usize) -> Result<()> {
        let mut left = n;
        while left > 0 {
            let seg = self.current()?;
            let take = left.min(seg.len() - self.pos);
            self.pos += take;
            left -= take;
        }
        Ok(())
    }

    /// `cch` characters; where they cross into a CONTINUE record, its first byte gives their width
    /// again. A character cut in two by the end of a record is a damaged record.
    fn chars(&mut self, cch: usize, high: bool) -> Result<String> {
        let mut units: Vec<u16> = Vec::with_capacity(cch);
        let mut wide = high;
        let past_end = || damaged("a string runs past the end of its record.");
        while units.len() < cch {
            let mut seg = self.segs.get(self.i).copied().unwrap_or(&[]);
            if self.i >= self.segs.len() || self.pos >= seg.len() {
                self.i += 1;
                self.pos = 0;
                seg = self.segs.get(self.i).copied().ok_or_else(past_end)?;
                let flags = *seg.first().ok_or_else(past_end)?;
                self.pos = 1;
                wide = flags & 1 == 1;
            }
            let before = units.len();
            let width = if wide { 2 } else { 1 };
            while units.len() < cch && self.pos + width <= seg.len() {
                units.push(if wide {
                    u16::from_le_bytes([seg[self.pos], seg[self.pos + 1]])
                } else {
                    seg[self.pos] as u16
                });
                self.pos += width;
            }
            if units.len() == before && self.pos < seg.len() {
                return Err(past_end());
            }
        }
        Ok(String::from_utf16_lossy(&units))
    }

    /// XLUnicodeRichExtendedString: the text, without its formatting runs and phonetic data.
    fn rich_string(&mut self) -> Result<String> {
        let cch = self.u16()? as usize;
        let flags = self.u8()?;
        let runs = if flags & 0x08 != 0 {
            self.u16()? as usize
        } else {
            0
        };
        let ext = if flags & 0x04 != 0 {
            self.u32()? as usize
        } else {
            0
        };
        let text = self.chars(cch, flags & 0x01 != 0)?;
        self.skip(runs * 4 + ext)?;
        Ok(text)
    }
}

/// XLUnicodeString (a 16-bit length) or ShortXLUnicodeString (an 8-bit one) inside one record.
fn simple_string(data: &[u8], at: usize, short_length: bool) -> Result<String> {
    let cch = if short_length {
        *data.get(at).unwrap_or(&0) as usize
    } else {
        u16_at(data, at)? as usize
    };
    let flags_at = at + if short_length { 1 } else { 2 };
    let wide = data.get(flags_at).is_some_and(|f| f & 1 != 0);
    Segments::new(data, &[], flags_at + 1).chars(cch, wide)
}

/// RkNumber: a 30-bit integer or the top 30 bits of a double, optionally divided by 100.
fn rk_value(rk: u32) -> f64 {
    let value = if rk & 0x02 != 0 {
        ((rk as i32) >> 2) as f64
    } else {
        f64::from_bits(((rk & 0xFFFF_FFFC) as u64) << 32)
    };
    if rk & 0x01 != 0 { value / 100.0 } else { value }
}

struct SheetEntry {
    name: String,
    state: &'static str,
    offset: u32,
    worksheet: bool,
}

/// An open legacy workbook: its Workbook stream, sheets, shared strings and cell formats.
pub struct LegacyBook {
    stream: Vec<u8>,
    entries: Vec<SheetEntry>,
    strings: Vec<String>,
    formats: Vec<CellFormat>,
    pub date1904: bool,
}

/// Opens a workbook in an OLE compound file: a legacy .xls is read; a password-protected .xlsx,
/// an Excel 5.0/95 workbook or another Office document is refused, saying what it is.
pub fn open(bytes: &[u8]) -> Result<LegacyBook> {
    let mut cfb = CompoundFile::new(bytes)?;
    if cfb.has("EncryptedPackage") || cfb.has("EncryptionInfo") {
        return Err(not_a_workbook(
            "The file is a password-protected workbook, which cannot be read.",
            "Open the file in Excel or LibreOffice and save it as an Excel workbook (.xlsx) without a password, then import the new copy.",
        ));
    }
    if let Some(stream) = cfb.stream("Workbook")? {
        return LegacyBook::new(stream);
    }
    if cfb.has("Book") {
        return Err(not_a_workbook(
            "The file is an Excel 5.0/95 workbook, which is too old to be read.",
            RESAVE_FIX,
        ));
    }
    Err(not_a_workbook(
        "The file is an Office 97-2003 document but not an Excel workbook (it may be a Word or PowerPoint file).",
        "Choose an Excel workbook (.xls or .xlsx), a CSV, GeoJSON, JSON or Parquet file.",
    ))
}

impl LegacyBook {
    fn new(stream: Vec<u8>) -> Result<LegacyBook> {
        let mut custom: HashMap<i64, String> = HashMap::new();
        let mut xf_formats: Vec<i64> = Vec::new();
        let mut entries = Vec::new();
        let mut strings = Vec::new();
        let mut date1904 = false;
        let mut first = true;
        for r in records(&stream, 0) {
            let r = r?;
            if first {
                first = false;
                if r.kind != BOF || u16_at(r.data, 0)? != BIFF8 {
                    return Err(not_a_workbook(
                        "The file is an Excel workbook from before Excel 97 (BIFF5 or older), which cannot be read.",
                        RESAVE_FIX,
                    ));
                }
                continue;
            }
            match r.kind {
                EOF => break,
                FILEPASS => {
                    return Err(not_a_workbook(
                        "The workbook is protected with a password, so it cannot be read.",
                        RESAVE_FIX.replace("(.xlsx)", "(.xlsx) without a password"),
                    ));
                }
                DATEMODE => date1904 = u16_at(r.data, 0)? == 1,
                FORMAT => {
                    custom.insert(u16_at(r.data, 0)? as i64, simple_string(r.data, 2, false)?);
                }
                XF => xf_formats.push(u16_at(r.data, 2)? as i64),
                BOUNDSHEET => {
                    let visibility = r.data.get(4).copied().unwrap_or(0) & 0x03;
                    entries.push(SheetEntry {
                        name: simple_string(r.data, 6, true)?,
                        state: match visibility {
                            1 => "hidden",
                            2 => "veryHidden",
                            _ => "visible",
                        },
                        offset: u32_at(r.data, 0)?,
                        worksheet: r.data.get(5) == Some(&0),
                    });
                }
                SST => {
                    let mut seg = Segments::new(r.data, &r.continues, 8);
                    let unique = u32_at(r.data, 4)?;
                    strings = Vec::new();
                    for _ in 0..unique {
                        strings.push(seg.rich_string()?);
                    }
                }
                _ => {}
            }
        }
        let formats = xf_formats
            .iter()
            .map(|&id| cell_format(id, &custom))
            .collect();
        Ok(LegacyBook {
            stream,
            entries,
            strings,
            formats,
            date1904,
        })
    }

    pub fn sheets(&self) -> Vec<(String, &'static str)> {
        self.entries
            .iter()
            .map(|e| (e.name.clone(), e.state))
            .collect()
    }

    pub fn read_sheet(&self, name: &str) -> Result<Sheet> {
        let Some(entry) = self.entries.iter().find(|e| e.name == name) else {
            return Err(damaged(format!("the sheet \"{name}\" has no part.")));
        };
        // Chart sheets and macro sheets are sheets of the workbook but hold no cells.
        if !entry.worksheet {
            return Ok(Sheet::empty(name, entry.state));
        }
        if entry.offset as usize >= self.stream.len() {
            return Err(damaged(format!(
                "the sheet \"{name}\" starts past the end of the file."
            )));
        }
        self.parse_sheet(entry)
    }

    fn parse_sheet(&self, entry: &SheetEntry) -> Result<Sheet> {
        let mut cells: BTreeMap<u32, BTreeMap<u32, Cell>> = BTreeMap::new();
        let mut merges: Vec<CellRange> = Vec::new();
        let mut pending: Option<(u32, u32)> = None;
        let mut depth = 0i64;
        let date_kind = |ixfe: u16| self.formats.get(ixfe as usize).and_then(|f| f.date_kind);
        let mut frozen_flag = false;
        let mut pane: Option<(u32, u32)> = None;
        fn put(
            cells: &mut BTreeMap<u32, BTreeMap<u32, Cell>>,
            r: u16,
            c: u16,
            (v, t): (Raw, &'static str),
            formula: bool,
        ) {
            cells.entry(r as u32).or_default().insert(
                c as u32,
                Cell {
                    c: c as u32,
                    is_date: matches!(v, Raw::Date(_) | Raw::DateTime(_)),
                    v,
                    formula,
                    t,
                },
            );
        }
        let number = |ixfe: u16, n: f64| -> (Raw, &'static str) {
            let v = date_kind(ixfe)
                .and_then(|k| serial_to_date_value(n, self.date1904, k))
                .unwrap_or(Raw::Number(n));
            (v, "n")
        };
        for rec in records(&self.stream, entry.offset as usize) {
            let rec = rec?;
            let d = rec.data;
            if rec.kind == BOF {
                depth += 1;
                continue;
            }
            if rec.kind == EOF {
                depth -= 1;
                if depth <= 0 {
                    break;
                }
                continue;
            }
            // Records of an embedded chart belong to the chart, not to the sheet.
            if depth != 1 {
                continue;
            }
            match rec.kind {
                NUMBER => {
                    let v = number(u16_at(d, 4)?, f64_at(d, 6)?);
                    put(&mut cells, u16_at(d, 0)?, u16_at(d, 2)?, v, false);
                }
                RK => {
                    let v = number(u16_at(d, 4)?, rk_value(u32_at(d, 6)?));
                    put(&mut cells, u16_at(d, 0)?, u16_at(d, 2)?, v, false);
                }
                MULRK => {
                    let (r, first) = (u16_at(d, 0)?, u16_at(d, 2)?);
                    let count = d.len().saturating_sub(6) / 6;
                    for i in 0..count {
                        let v = number(u16_at(d, 4 + i * 6)?, rk_value(u32_at(d, 6 + i * 6)?));
                        put(&mut cells, r, first.wrapping_add(i as u16), v, false);
                    }
                }
                LABELSST => {
                    let index = u32_at(d, 6)?;
                    let Some(text) = self.strings.get(index as usize) else {
                        return Err(damaged(format!(
                            "a cell of sheet \"{}\" refers to shared string {index}, which the workbook does not have.",
                            entry.name
                        )));
                    };
                    put(
                        &mut cells,
                        u16_at(d, 0)?,
                        u16_at(d, 2)?,
                        (Raw::Text(text.clone()), "s"),
                        false,
                    );
                }
                LABEL => {
                    let text = simple_string(d, 6, false)?;
                    put(
                        &mut cells,
                        u16_at(d, 0)?,
                        u16_at(d, 2)?,
                        (Raw::Text(text), "str"),
                        false,
                    );
                }
                BOOLERR => {
                    let value = d.get(6).copied();
                    let v = if d.get(7) == Some(&1) {
                        (Raw::Error(error_text(value).to_string()), "e")
                    } else {
                        (Raw::Bool(value != Some(0)), "b")
                    };
                    put(&mut cells, u16_at(d, 0)?, u16_at(d, 2)?, v, false);
                }
                FORMULA => {
                    let (r, c, ixfe) = (u16_at(d, 0)?, u16_at(d, 2)?, u16_at(d, 4)?);
                    if d.get(12) == Some(&0xFF) && d.get(13) == Some(&0xFF) {
                        // Not a number: a string (in the STRING record that follows), a boolean,
                        // an error or empty.
                        let kind = d.get(6).copied();
                        if kind == Some(0) {
                            pending = Some((r as u32, c as u32));
                        }
                        let v = match kind {
                            Some(1) => (Raw::Bool(d.get(8).is_some_and(|b| *b != 0)), "b"),
                            Some(2) => (Raw::Error(error_text(d.get(8).copied()).to_string()), "e"),
                            _ => (Raw::Null, "str"),
                        };
                        put(&mut cells, r, c, v, true);
                    } else {
                        put(&mut cells, r, c, number(ixfe, f64_at(d, 6)?), true);
                    }
                }
                STRING => {
                    // The text result of the formula just before it.
                    if let Some((r, c)) = pending.take() {
                        let text = simple_string(d, 0, false)?;
                        if let Some(cell) = cells.get_mut(&r).and_then(|row| row.get_mut(&c)) {
                            cell.v = Raw::Text(text);
                        }
                    }
                }
                WINDOW2 => frozen_flag = u16_at(d, 0)? & 0x0008 != 0,
                PANE => pane = Some((u16_at(d, 2)? as u32, u16_at(d, 0)? as u32)),
                MERGEDCELLS => {
                    let count = u16_at(d, 0)? as usize;
                    let mut i = 0;
                    while i < count && 2 + i * 8 + 8 <= d.len() {
                        let at = 2 + i * 8;
                        merges.push(CellRange {
                            sr: u16_at(d, at)? as u32,
                            er: u16_at(d, at + 2)? as u32,
                            sc: u16_at(d, at + 4)? as u32,
                            ec: u16_at(d, at + 6)? as u32,
                        });
                        i += 1;
                    }
                }
                _ => {}
            }
        }
        let rows: Vec<Row> = cells
            .into_iter()
            .map(|(r, row)| Row {
                r,
                cells: row
                    .into_values()
                    .filter(|cell| !matches!(cell.v, Raw::Null) || cell.formula)
                    .collect(),
            })
            .filter(|row| !row.cells.is_empty())
            .collect();
        Ok(Sheet {
            name: entry.name.clone(),
            state: entry.state,
            dimension: used_range(&rows),
            merges,
            frozen: pane.filter(|&(r, c)| frozen_flag && (r > 0 || c > 0)),
            auto_filter: None,
            rows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_rk_numbers() {
        assert_eq!(rk_value((5 << 2) | 0x02), 5.0);
        assert_eq!(rk_value((1234 << 2) | 0x03), 12.34);
        assert_eq!(rk_value((-8i32 << 2) as u32 | 0x02), -8.0);
        let bits = 1.5f64.to_bits();
        assert_eq!(rk_value((bits >> 32) as u32 & 0xFFFF_FFFC), 1.5);
    }

    #[test]
    fn reads_strings_across_records() {
        // Three characters: two in the record, the third in a CONTINUE record whose first byte
        // says it is two bytes wide.
        let data: &[u8] = &[3, 0, 0, b'a', b'b'];
        let cont: &[u8] = &[1, b'c', 0];
        let mut s = Segments::new(data, &[cont], 0);
        assert_eq!(s.rich_string().unwrap(), "abc");
        // A wide character cut in two by the end of the record is refused, never looped over.
        let cut: &[u8] = &[2, 0, 1, b'a', 0, b'b'];
        assert!(Segments::new(cut, &[], 0).rich_string().is_err());
    }
}
