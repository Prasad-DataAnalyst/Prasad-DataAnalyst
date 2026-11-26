//! The SQLite database file format, as formats/geopackage/sqlite.ts writes and reads it (SAD
//! decision D-16): the same pages in the same order, so both engines write the same bytes. The
//! writer streams: every page but page 1 is written to the file as soon as it is finished, in the
//! order the pages are numbered, and page 1, the schema, is written last; only the current leaf
//! and one (page, key) pair per finished page are held. The reader reads one page at a time from
//! the file and checks every page number and offset it follows.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

pub const PAGE_SIZE: usize = 4096;
/// The library version the header names: 3.7.0, the first to read the in-header page count.
const SQLITE_VERSION_NUMBER: u32 = 3_007_000;

const LEAF_TABLE: u8 = 0x0d;
const INTERIOR_TABLE: u8 = 0x05;
const LEAF_INDEX: u8 = 0x0a;
const LEAF_HEADER: usize = 8;
const INTERIOR_HEADER: usize = 12;
/// Page 1 starts with the 100-byte database header.
const FILE_HEADER: usize = 100;

#[derive(Clone, Copy)]
struct Limits {
    max_table: usize,
    max_index: usize,
    min: usize,
}

/// The most and least of a record a b-tree cell holds on its page, by the file format's rules.
fn limits(usable: usize) -> Limits {
    Limits {
        max_table: usable - 35,
        max_index: (usable - 12) * 64 / 255 - 23,
        min: (usable - 12) * 32 / 255 - 23,
    }
}

const WRITE: Limits = Limits {
    max_table: PAGE_SIZE - 35,
    max_index: (PAGE_SIZE - 12) * 64 / 255 - 23,
    min: (PAGE_SIZE - 12) * 32 / 255 - 23,
};

/// How many bytes of a record of `size` bytes stay on the page; the rest go to overflow pages.
fn local_size(size: usize, max: usize, min: usize, usable: usize) -> usize {
    if size <= max {
        return size;
    }
    let surplus = min + (size - min) % (usable - 4);
    if surplus <= max { surplus } else { min }
}

/// A value of a record.
#[derive(Clone, Debug, PartialEq)]
pub enum SqlValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

// ---------------------------------------------------------------------------------------------
// Bytes

/// Appends a varint: big-endian groups of seven bits, the ninth byte holding eight.
pub fn varint(mut v: u64, out: &mut Vec<u8>) {
    if v >> 56 != 0 {
        let mut b = [0u8; 9];
        b[8] = v as u8;
        v >>= 8;
        for i in (0..8).rev() {
            b[i] = (v & 0x7f) as u8 | 0x80;
            v >>= 7;
        }
        out.extend_from_slice(&b);
        return;
    }
    let mut groups = Vec::with_capacity(9);
    loop {
        groups.push((v & 0x7f) as u8);
        v >>= 7;
        if v == 0 {
            break;
        }
    }
    let n = groups.len();
    for (i, g) in groups.iter().rev().enumerate() {
        out.push(if i < n - 1 { g | 0x80 } else { *g });
    }
}

fn varint_len(v: u64) -> usize {
    let mut out = Vec::with_capacity(9);
    varint(v, &mut out);
    out.len()
}

/// The serial type of an integer and the bytes it takes, as SQLite chooses them.
fn integer_type(v: i64) -> (u64, usize) {
    let u = if v < 0 { !v } else { v } as u64;
    if u <= 127 {
        return match v {
            0 => (8, 0),
            1 => (9, 0),
            _ => (1, 1),
        };
    }
    if u <= 32_767 {
        (2, 2)
    } else if u <= 8_388_607 {
        (3, 3)
    } else if u <= 2_147_483_647 {
        (4, 4)
    } else if u <= 0x7fff_ffff_ffff {
        (5, 6)
    } else {
        (6, 8)
    }
}

/// A record (encodeRecord): a header of serial types, then each value in the fewest bytes its type allows.
pub fn encode_record(values: &[SqlValue]) -> Vec<u8> {
    let types: Vec<(u64, usize)> = values
        .iter()
        .map(|v| match v {
            SqlValue::Null => (0, 0),
            SqlValue::Int(i) => integer_type(*i),
            SqlValue::Real(_) => (7, 8),
            SqlValue::Text(t) => (13 + 2 * t.len() as u64, t.len()),
            SqlValue::Blob(b) => (12 + 2 * b.len() as u64, b.len()),
        })
        .collect();
    let type_bytes: usize = types.iter().map(|(t, _)| varint_len(*t)).sum();
    let mut header = type_bytes + 1;
    while type_bytes + varint_len(header as u64) != header {
        header = type_bytes + varint_len(header as u64);
    }
    let mut out = Vec::with_capacity(header + types.iter().map(|(_, s)| s).sum::<usize>());
    varint(header as u64, &mut out);
    for (t, _) in &types {
        varint(*t, &mut out);
    }
    for (v, (_, size)) in values.iter().zip(&types) {
        match v {
            SqlValue::Null => {}
            SqlValue::Int(i) => out.extend_from_slice(&i.to_be_bytes()[8 - size..]),
            SqlValue::Real(x) => out.extend_from_slice(&x.to_be_bytes()),
            SqlValue::Text(t) => out.extend_from_slice(t.as_bytes()),
            SqlValue::Blob(b) => out.extend_from_slice(b),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The writer

/// A child of an interior page: its page and the largest rowid below it.
#[derive(Clone, Copy)]
struct Child {
    page: u32,
    key: i64,
}

fn cell_size(prefix: usize, payload: usize, max: usize) -> usize {
    let local = local_size(payload, max, WRITE.min, PAGE_SIZE);
    prefix + local + if local < payload { 4 } else { 0 }
}

/// A b-tree page: its header, the cell pointers in key order, and the cells packed from the end.
fn btree_page(kind: u8, cells: &[&[u8]], right: Option<u32>, offset: usize) -> Vec<u8> {
    let mut page = vec![0u8; PAGE_SIZE];
    page[offset] = kind;
    page[offset + 3..offset + 5].copy_from_slice(&(cells.len() as u16).to_be_bytes());
    let pointers = offset
        + if right.is_none() {
            LEAF_HEADER
        } else {
            INTERIOR_HEADER
        };
    let mut end = PAGE_SIZE;
    for (i, cell) in cells.iter().enumerate() {
        end -= cell.len();
        page[end..end + cell.len()].copy_from_slice(cell);
        page[pointers + 2 * i..pointers + 2 * i + 2].copy_from_slice(&(end as u16).to_be_bytes());
    }
    debug_assert!(
        pointers + 2 * cells.len() <= end,
        "the cells fit their page"
    );
    page[offset + 5..offset + 7].copy_from_slice(&(end as u16).to_be_bytes());
    if let Some(r) = right {
        page[offset + 8..offset + 12].copy_from_slice(&r.to_be_bytes());
    }
    page
}

fn interior_cell(c: &Child) -> Vec<u8> {
    let mut cell = c.page.to_be_bytes().to_vec();
    varint(c.key as u64, &mut cell);
    cell
}

fn interior_page(children: &[Child], offset: usize) -> Vec<u8> {
    let cells: Vec<Vec<u8>> = children[..children.len() - 1]
        .iter()
        .map(interior_cell)
        .collect();
    let refs: Vec<&[u8]> = cells.iter().map(Vec::as_slice).collect();
    btree_page(
        INTERIOR_TABLE,
        &refs,
        Some(children[children.len() - 1].page),
        offset,
    )
}

/// Whether children fit on one interior page of this many bytes: each but the last takes a cell.
fn fits_one(children: &[Child], capacity: usize) -> bool {
    let used: usize = INTERIOR_HEADER
        + children[..children.len() - 1]
            .iter()
            .map(|c| 2 + 4 + varint_len(c.key as u64))
            .sum::<usize>();
    used <= capacity
}

/// Children packed onto interior pages in order, each page as full as it goes.
fn pack_children(children: &[Child]) -> Vec<Vec<Child>> {
    let mut groups: Vec<Vec<Child>> = Vec::new();
    let mut group: Vec<Child> = Vec::new();
    let mut used = INTERIOR_HEADER;
    for c in children {
        if let Some(last) = group.last() {
            let cost = 2 + 4 + varint_len(last.key as u64);
            if used + cost > PAGE_SIZE {
                groups.push(std::mem::take(&mut group));
                group.push(*c);
                used = INTERIOR_HEADER;
                continue;
            }
            used += cost;
        }
        group.push(*c);
    }
    groups.push(group);
    // An interior page below the root holds two children at least.
    let n = groups.len();
    if n > 1 && groups[n - 1].len() == 1 {
        let moved = groups[n - 2].pop().expect("a full page has children");
        groups[n - 1].insert(0, moved);
    }
    groups
}

/// A table's b-tree as its rows come: a leaf page is written when the next row does not fit.
#[derive(Default)]
pub struct TableTree {
    leaves: Vec<Child>,
    cells: Vec<Vec<u8>>,
    used: usize,
    last_key: i64,
}

/// What the database header records besides the layout.
pub struct SqliteHeader {
    pub application_id: u32,
    pub user_version: u32,
}

/// A database being written to a file.
pub struct Writer {
    out: BufWriter<File>,
    pages: u32,
    page1: Option<Vec<u8>>,
}

impl Writer {
    /// Starts a database file with a placeholder for page 1.
    pub fn create(path: &Path) -> std::io::Result<Writer> {
        let mut out = BufWriter::with_capacity(1 << 20, File::create(path)?);
        out.write_all(&[0u8; PAGE_SIZE])?;
        Ok(Writer {
            out,
            pages: 1,
            page1: None,
        })
    }

    /// Writes the next page; its number.
    fn append(&mut self, page: &[u8]) -> std::io::Result<u32> {
        self.out.write_all(page)?;
        self.pages += 1;
        Ok(self.pages)
    }

    /// Puts the part of a record past its local bytes on a chain of new overflow pages; the first page.
    fn spill(&mut self, payload: &[u8], local: usize) -> std::io::Result<u32> {
        let chunk = PAGE_SIZE - 4;
        let count = (payload.len() - local).div_ceil(chunk);
        let first = self.pages + 1;
        for i in 0..count {
            let mut page = vec![0u8; PAGE_SIZE];
            let next = if i + 1 < count {
                first + i as u32 + 1
            } else {
                0
            };
            page[..4].copy_from_slice(&next.to_be_bytes());
            let from = local + i * chunk;
            let to = payload.len().min(from + chunk);
            page[4..4 + to - from].copy_from_slice(&payload[from..to]);
            self.append(&page)?;
        }
        Ok(first)
    }

    /// A cell holding a record: its prefix, the local part, and the first overflow page if it spills.
    fn payload_cell(
        &mut self,
        prefix: &[u8],
        payload: &[u8],
        max: usize,
    ) -> std::io::Result<Vec<u8>> {
        let local = local_size(payload.len(), max, WRITE.min, PAGE_SIZE);
        let mut cell = Vec::with_capacity(prefix.len() + local + 4);
        cell.extend_from_slice(prefix);
        cell.extend_from_slice(&payload[..local]);
        if local < payload.len() {
            let first = self.spill(payload, local)?;
            cell.extend_from_slice(&first.to_be_bytes());
        }
        Ok(cell)
    }

    /// Adds a row to a table, its record already encoded.
    pub fn add(&mut self, t: &mut TableTree, rowid: i64, payload: &[u8]) -> std::io::Result<()> {
        let mut prefix = Vec::with_capacity(18);
        varint(payload.len() as u64, &mut prefix);
        varint(rowid as u64, &mut prefix);
        let size = cell_size(prefix.len(), payload.len(), WRITE.max_table);
        if !t.cells.is_empty() && LEAF_HEADER + t.used + size + 2 > PAGE_SIZE {
            self.flush(t)?;
        }
        let cell = self.payload_cell(&prefix, payload, WRITE.max_table)?;
        t.cells.push(cell);
        t.used += size + 2;
        t.last_key = rowid;
        Ok(())
    }

    fn flush(&mut self, t: &mut TableTree) -> std::io::Result<()> {
        let refs: Vec<&[u8]> = t.cells.iter().map(Vec::as_slice).collect();
        let page = self.append(&btree_page(LEAF_TABLE, &refs, None, 0))?;
        t.leaves.push(Child {
            page,
            key: t.last_key,
        });
        t.cells.clear();
        t.used = 0;
        Ok(())
    }

    /// The table's root page; a table without rows is one empty leaf.
    pub fn finish_table(&mut self, mut t: TableTree) -> std::io::Result<u32> {
        if !t.cells.is_empty() || t.leaves.is_empty() {
            self.flush(&mut t)?;
        }
        self.interior_levels(t.leaves, false)
    }

    /// The interior levels above a table's leaves; the root page. The schema's root is page 1.
    fn interior_levels(&mut self, leaves: Vec<Child>, root_is_page1: bool) -> std::io::Result<u32> {
        let mut level = leaves;
        loop {
            if !root_is_page1 && level.len() == 1 {
                return Ok(level[0].page);
            }
            if root_is_page1 && fits_one(&level, PAGE_SIZE - FILE_HEADER) {
                self.page1 = Some(interior_page(&level, FILE_HEADER));
                return Ok(1);
            }
            let mut next = Vec::new();
            for g in pack_children(&level) {
                let page = self.append(&interior_page(&g, 0))?;
                next.push(Child {
                    page,
                    key: g[g.len() - 1].key,
                });
            }
            level = next;
        }
    }

    /// The leaf of an index small enough for one page; each entry its keys and rowid, in key order.
    pub fn index_leaf(&mut self, entries: &[Vec<SqlValue>]) -> std::io::Result<u32> {
        let mut cells = Vec::new();
        for e in entries {
            let payload = encode_record(e);
            let mut prefix = Vec::new();
            varint(payload.len() as u64, &mut prefix);
            cells.push(self.payload_cell(&prefix, &payload, WRITE.max_index)?);
        }
        let refs: Vec<&[u8]> = cells.iter().map(Vec::as_slice).collect();
        self.append(&btree_page(LEAF_INDEX, &refs, None, 0))
    }

    /// Writes the schema table (page 1, and leaves below it when it does not fit there), then the header.
    pub fn finish(
        mut self,
        header: &SqliteHeader,
        schema: &[Vec<SqlValue>],
    ) -> std::io::Result<()> {
        let mut cells = Vec::new();
        for (i, values) in schema.iter().enumerate() {
            let payload = encode_record(values);
            let mut prefix = Vec::new();
            varint(payload.len() as u64, &mut prefix);
            varint(i as u64 + 1, &mut prefix);
            cells.push(self.payload_cell(&prefix, &payload, WRITE.max_table)?);
        }
        let bytes: usize = cells.iter().map(|c| c.len() + 2).sum();
        let mut page1 = if FILE_HEADER + LEAF_HEADER + bytes <= PAGE_SIZE {
            let refs: Vec<&[u8]> = cells.iter().map(Vec::as_slice).collect();
            btree_page(LEAF_TABLE, &refs, None, FILE_HEADER)
        } else {
            let mut groups: Vec<Vec<usize>> = Vec::new();
            let mut group: Vec<usize> = Vec::new();
            let mut used = 0;
            for (i, c) in cells.iter().enumerate() {
                if !group.is_empty() && LEAF_HEADER + used + c.len() + 2 > PAGE_SIZE {
                    groups.push(std::mem::take(&mut group));
                    used = 0;
                }
                group.push(i);
                used += c.len() + 2;
            }
            groups.push(group);
            let mut leaves = Vec::new();
            for g in groups {
                let refs: Vec<&[u8]> = g.iter().map(|&i| cells[i].as_slice()).collect();
                let page = self.append(&btree_page(LEAF_TABLE, &refs, None, 0))?;
                leaves.push(Child {
                    page,
                    key: g[g.len() - 1] as i64 + 1,
                });
            }
            self.interior_levels(leaves, true)?;
            self.page1.take().expect("page 1 is the schema's root")
        };
        page1[..16].copy_from_slice(b"SQLite format 3\0");
        page1[16..18].copy_from_slice(&(PAGE_SIZE as u16).to_be_bytes());
        page1[18] = 1;
        page1[19] = 1;
        page1[21] = 64;
        page1[22] = 32;
        page1[23] = 32;
        let mut put = |at: usize, v: u32| page1[at..at + 4].copy_from_slice(&v.to_be_bytes());
        put(24, 1);
        put(28, self.pages);
        put(40, 1);
        put(44, 4);
        put(56, 1);
        put(60, header.user_version);
        put(68, header.application_id);
        put(92, 1);
        put(96, SQLITE_VERSION_NUMBER);
        let mut file = self.out.into_inner().map_err(|e| e.into_error())?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&page1)?;
        file.flush()
    }
}

// ---------------------------------------------------------------------------------------------
// The reader

type Got<T> = std::result::Result<T, String>;

/// A varint that fits a size, and where the next value starts.
fn read_varint(b: &[u8], at: usize, end: usize) -> Got<(u64, usize)> {
    let mut v: u64 = 0;
    for i in 0..8 {
        if at + i >= end {
            return Err("a varint runs past its cell".into());
        }
        let byte = b[at + i];
        v = v * 128 + u64::from(byte & 0x7f);
        if byte < 0x80 {
            if v > 9_007_199_254_740_991 {
                return Err("a size is too large".into());
            }
            return Ok((v, at + i + 1));
        }
    }
    Err("a size is too large".into())
}

/// A varint as the 64-bit signed integer a rowid is.
fn read_varint64(b: &[u8], at: usize, end: usize) -> Got<(i64, usize)> {
    let mut v: u64 = 0;
    for i in 0..9 {
        if at + i >= end {
            return Err("a varint runs past its cell".into());
        }
        let byte = b[at + i];
        if i == 8 {
            return Ok(((v << 8 | u64::from(byte)) as i64, at + 9));
        }
        v = v << 7 | u64::from(byte & 0x7f);
        if byte < 0x80 {
            return Ok((v as i64, at + i + 1));
        }
    }
    Err("a varint runs past its cell".into())
}

fn text(bytes: &[u8], encoding: u32) -> String {
    match encoding {
        2 | 3 => {
            let units: Vec<u16> = bytes
                .chunks(2)
                .map(|c| match c {
                    [a, b] if encoding == 2 => u16::from_le_bytes([*a, *b]),
                    [a, b] => u16::from_be_bytes([*a, *b]),
                    _ => 0xfffd,
                })
                .collect();
            String::from_utf16_lossy(&units)
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Decodes a record (decodeRecord), its text in the database's encoding (1 UTF-8, 2 UTF-16LE, 3 UTF-16BE).
pub fn decode_record(p: &[u8], encoding: u32) -> Got<Vec<SqlValue>> {
    let (header, first) = read_varint(p, 0, p.len())?;
    let header = header as usize;
    if header > p.len() || header < first {
        return Err("a record header runs past its record".into());
    }
    let mut types = Vec::new();
    let mut at = first;
    while at < header {
        let (t, next) = read_varint(p, at, header)?;
        types.push(t);
        at = next;
    }
    let mut values = Vec::with_capacity(types.len());
    let mut body = header;
    for t in types {
        let need = |n: usize| {
            if body + n > p.len() {
                Err("a record value runs past its record".to_string())
            } else {
                Ok(())
            }
        };
        match t {
            0 => values.push(SqlValue::Null),
            1..=6 => {
                let size = [0, 1, 2, 3, 4, 6, 8][t as usize];
                need(size)?;
                let mut v: i64 = if p[body] & 0x80 != 0 { -1 } else { 0 };
                for k in 0..size {
                    v = v << 8 | i64::from(p[body + k]);
                }
                values.push(SqlValue::Int(v));
                body += size;
            }
            7 => {
                need(8)?;
                let mut b = [0u8; 8];
                b.copy_from_slice(&p[body..body + 8]);
                values.push(SqlValue::Real(f64::from_be_bytes(b)));
                body += 8;
            }
            8 | 9 => values.push(SqlValue::Int(t as i64 - 8)),
            12.. => {
                let size = ((t - 12) / 2) as usize;
                need(size)?;
                let bytes = &p[body..body + size];
                values.push(if t % 2 == 0 {
                    SqlValue::Blob(bytes.to_vec())
                } else {
                    SqlValue::Text(text(bytes, encoding))
                });
                body += size;
            }
            _ => return Err(format!("a record uses the reserved serial type {t}")),
        }
    }
    Ok(values)
}

/// A row of the schema table.
pub struct SchemaRow {
    pub kind: String,
    pub name: String,
    pub root: u32,
    pub sql: Option<String>,
}

/// A database file, read a page at a time.
pub struct Database {
    file: File,
    pub page_size: usize,
    pub usable: usize,
    pub page_count: u32,
    pub encoding: u32,
    pub application_id: u32,
    pub user_version: u32,
    limits: Limits,
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn be16(b: &[u8], at: usize) -> usize {
    usize::from(u16::from_be_bytes([b[at], b[at + 1]]))
}

impl Database {
    pub fn open(path: &Path) -> Got<Database> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let mut h = [0u8; FILE_HEADER];
        if len < FILE_HEADER as u64
            || file.read_exact(&mut h).is_err()
            || &h[..16] != b"SQLite format 3\0"
        {
            return Err("it does not start with the SQLite header".into());
        }
        let size = be16(&h, 16);
        let page_size = if size == 1 { 65_536 } else { size };
        if page_size < 512 || !page_size.is_power_of_two() {
            return Err(format!("its page size {size} is not valid"));
        }
        let usable = page_size - usize::from(h[20]);
        if usable < 480 {
            return Err("its pages keep too many reserved bytes".into());
        }
        if h[21] != 64 || h[22] != 32 || h[23] != 32 {
            return Err("its payload fractions are not 64, 32 and 32".into());
        }
        let pages = (len / page_size as u64).min(u64::from(u32::MAX)) as u32;
        let counted = be32(&h, 28);
        let page_count = if counted > 0 && be32(&h, 24) == be32(&h, 92) && counted <= pages {
            counted
        } else {
            pages
        };
        if page_count < 1 {
            return Err("it is cut short".into());
        }
        let encoding = be32(&h, 56);
        if encoding > 3 {
            return Err(format!("its text encoding {encoding} is not valid"));
        }
        Ok(Database {
            file,
            page_size,
            usable,
            page_count,
            encoding: encoding.max(1),
            user_version: be32(&h, 60),
            application_id: be32(&h, 68),
            limits: limits(usable),
        })
    }

    fn page(&mut self, n: u32) -> Got<Vec<u8>> {
        if n < 1 || n > self.page_count {
            return Err(format!("it points to page {n}, outside the file"));
        }
        let mut page = vec![0u8; self.page_size];
        self.file
            .seek(SeekFrom::Start(u64::from(n - 1) * self.page_size as u64))
            .and_then(|_| self.file.read_exact(&mut page))
            .map_err(|e| e.to_string())?;
        Ok(page)
    }

    /// The record a cell holds from `at`, joined from its overflow pages when it spills.
    fn payload(&mut self, data: &[u8], at: usize, size: usize, max: usize) -> Got<Vec<u8>> {
        let local = local_size(size, max, self.limits.min, self.usable);
        if at + local > self.usable {
            return Err("a cell runs past its page".into());
        }
        if local == size {
            return Ok(data[at..at + size].to_vec());
        }
        if at + local + 4 > self.usable {
            return Err("a cell runs past its page".into());
        }
        let mut out = Vec::with_capacity(size);
        out.extend_from_slice(&data[at..at + local]);
        let mut next = be32(data, at + local);
        while out.len() < size {
            if next == 0 {
                return Err("an overflow chain ends before its record does".into());
            }
            let page = self.page(next)?;
            let take = (self.usable - 4).min(size - out.len());
            out.extend_from_slice(&page[4..4 + take]);
            next = be32(&page, 0);
        }
        Ok(out)
    }

    /// Calls `f` with each row of a table b-tree, in rowid order: its rowid and values.
    pub fn each_row(
        &mut self,
        root: u32,
        f: &mut dyn FnMut(i64, Vec<SqlValue>) -> Got<()>,
    ) -> Got<()> {
        let mut seen = HashSet::new();
        self.walk(root, 0, &mut seen, f)
    }

    fn walk(
        &mut self,
        n: u32,
        depth: usize,
        seen: &mut HashSet<u32>,
        f: &mut dyn FnMut(i64, Vec<SqlValue>) -> Got<()>,
    ) -> Got<()> {
        if depth > 40 {
            return Err("its b-tree is deeper than any valid one".into());
        }
        if !seen.insert(n) {
            return Err(format!("its b-tree visits page {n} twice"));
        }
        let data = self.page(n)?;
        let hdr = if n == 1 { FILE_HEADER } else { 0 };
        let kind = data[hdr];
        if kind != LEAF_TABLE && kind != INTERIOR_TABLE {
            return Err(format!("page {n} is not a page of a table"));
        }
        let cells = be16(&data, hdr + 3);
        let pointers = hdr
            + if kind == LEAF_TABLE {
                LEAF_HEADER
            } else {
                INTERIOR_HEADER
            };
        if pointers + 2 * cells > self.usable {
            return Err(format!("page {n} lists more cells than it holds"));
        }
        for i in 0..cells {
            let at = be16(&data, pointers + 2 * i);
            if at < pointers + 2 * cells || at >= self.usable {
                return Err(format!("a cell of page {n} lies outside its page"));
            }
            if kind == INTERIOR_TABLE {
                if at + 4 > self.usable {
                    return Err(format!("a cell of page {n} lies outside its page"));
                }
                self.walk(be32(&data, at), depth + 1, seen, f)?;
            } else {
                let (size, a1) = read_varint(&data, at, self.usable)?;
                let (rowid, a2) = read_varint64(&data, a1, self.usable)?;
                let max = self.limits.max_table;
                let payload = self.payload(&data, a2, size as usize, max)?;
                f(rowid, decode_record(&payload, self.encoding)?)?;
            }
        }
        if kind == INTERIOR_TABLE {
            self.walk(be32(&data, hdr + 8), depth + 1, seen, f)?;
        }
        Ok(())
    }

    /// The schema table: every table, index, view and trigger.
    pub fn schema(&mut self) -> Got<Vec<SchemaRow>> {
        let mut rows = Vec::new();
        self.each_row(1, &mut |_, values| {
            let s = |v: Option<&SqlValue>| match v {
                Some(SqlValue::Text(t)) => Some(t.clone()),
                _ => None,
            };
            let (Some(kind), Some(name), Some(_)) =
                (s(values.first()), s(values.get(1)), s(values.get(2)))
            else {
                return Err("a row of its schema is not a schema row".into());
            };
            rows.push(SchemaRow {
                kind,
                name,
                root: match values.get(3) {
                    Some(SqlValue::Int(r)) => u32::try_from(*r).unwrap_or(0),
                    _ => 0,
                },
                sql: s(values.get(4)),
            });
            Ok(())
        })?;
        Ok(rows)
    }
}

// ---------------------------------------------------------------------------------------------
// CREATE TABLE

struct Token {
    text: String,
    /// An identifier, quoted or bare, or a string literal, which SQLite also takes as a name.
    name: bool,
    quoted: bool,
}

fn tokenize(sql: &str) -> Got<Vec<Token>> {
    let c: Vec<char> = sql.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    let quoted_run = |i: &mut usize, close: char, doubled: bool| -> Got<String> {
        let mut text = String::new();
        *i += 1;
        loop {
            let Some(&ch) = c.get(*i) else {
                return Err("a quoted name in a CREATE TABLE statement is not closed".into());
            };
            if ch == close {
                if doubled && c.get(*i + 1) == Some(&close) {
                    text.push(close);
                    *i += 2;
                    continue;
                }
                *i += 1;
                return Ok(text);
            }
            text.push(ch);
            *i += 1;
        }
    };
    let ident_start = |ch: char| ch.is_ascii_alphabetic() || ch == '_' || ch as u32 >= 0x80;
    let ident_part =
        |ch: char| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' || ch as u32 >= 0x80;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch == '-' && c.get(i + 1) == Some(&'-') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            let mut j = i + 2;
            while j + 1 < c.len() && !(c[j] == '*' && c[j + 1] == '/') {
                j += 1;
            }
            i = if j + 1 < c.len() { j + 2 } else { c.len() };
        } else if ch == '"' || ch == '`' {
            let text = quoted_run(&mut i, ch, true)?;
            tokens.push(Token {
                text,
                name: true,
                quoted: true,
            });
        } else if ch == '[' {
            let text = quoted_run(&mut i, ']', false)?;
            tokens.push(Token {
                text,
                name: true,
                quoted: true,
            });
        } else if ch == '\'' {
            let text = quoted_run(&mut i, '\'', true)?;
            tokens.push(Token {
                text,
                name: true,
                quoted: true,
            });
        } else if ident_start(ch) {
            let start = i;
            while i < c.len() && ident_part(c[i]) {
                i += 1;
            }
            tokens.push(Token {
                text: c[start..i].iter().collect(),
                name: true,
                quoted: false,
            });
        } else if ch.is_ascii_digit()
            || (ch == '.' && c.get(i + 1).is_some_and(char::is_ascii_digit))
        {
            let start = i;
            while i < c.len()
                && (c[i].is_ascii_alphanumeric() || c[i] == '.' || c[i] == '+' || c[i] == '-')
            {
                if (c[i] == '+' || c[i] == '-') && !matches!(c[i - 1], 'e' | 'E') {
                    break;
                }
                i += 1;
            }
            tokens.push(Token {
                text: c[start..i].iter().collect(),
                name: false,
                quoted: false,
            });
        } else {
            tokens.push(Token {
                text: ch.to_string(),
                name: false,
                quoted: false,
            });
            i += 1;
        }
    }
    Ok(tokens)
}

/// Upper case as SQLite folds names: ASCII letters only.
pub fn sql_upper(s: &str) -> String {
    s.to_ascii_uppercase()
}

fn keyword(t: Option<&Token>, word: &str) -> bool {
    t.is_some_and(|t| !t.quoted && sql_upper(&t.text) == word)
}

fn punct(t: Option<&Token>, p: &str) -> bool {
    t.is_some_and(|t| !t.quoted && t.text == p)
}

const COLUMN_CONSTRAINTS: [&str; 11] = [
    "CONSTRAINT",
    "PRIMARY",
    "NOT",
    "NULL",
    "UNIQUE",
    "CHECK",
    "DEFAULT",
    "COLLATE",
    "REFERENCES",
    "GENERATED",
    "AS",
];
const TABLE_CONSTRAINTS: [&str; 5] = ["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"];

/// A column as its CREATE TABLE statement declares it.
#[derive(Clone, Debug, PartialEq)]
pub struct Column {
    pub name: String,
    /// The declared type, its words joined by single spaces, as written; '' when none.
    pub typ: String,
    /// The column is the rowid under another name (INTEGER PRIMARY KEY), so its record holds null.
    pub rowid: bool,
}

/// A stored value as SQLite reads it from its column (columnValue): REAL affinity reads integers as reals.
pub fn column_value(c: &Column, v: SqlValue) -> SqlValue {
    let SqlValue::Int(i) = v else { return v };
    let t = sql_upper(&c.typ);
    let real = !t.contains("INT")
        && !["CHAR", "CLOB", "TEXT", "BLOB"]
            .iter()
            .any(|w| t.contains(w))
        && ["REAL", "FLOA", "DOUB"].iter().any(|w| t.contains(w));
    if real {
        SqlValue::Real(i as f64)
    } else {
        SqlValue::Int(i)
    }
}

/// The name and columns a CREATE TABLE statement declares (parseCreateTable).
pub fn parse_create_table(sql: &str) -> Got<(String, Vec<Column>)> {
    let t = tokenize(sql)?;
    let mut i = 0;
    let not_create = || "a table is not created by a CREATE TABLE statement".to_string();
    if !keyword(t.get(i), "CREATE") {
        return Err(not_create());
    }
    i += 1;
    if keyword(t.get(i), "TEMP") || keyword(t.get(i), "TEMPORARY") {
        i += 1;
    }
    if !keyword(t.get(i), "TABLE") {
        return Err(not_create());
    }
    i += 1;
    if keyword(t.get(i), "IF") && keyword(t.get(i + 1), "NOT") && keyword(t.get(i + 2), "EXISTS") {
        i += 3;
    }
    let mut name_at = i;
    i += 1;
    if punct(t.get(i), ".") {
        name_at = i + 1;
        i += 2;
    }
    let Some(name) = t.get(name_at).filter(|n| n.name) else {
        return Err("a CREATE TABLE statement names no table".into());
    };
    if !punct(t.get(i), "(") {
        return Err(format!(
            "the table {} is not created with a list of columns",
            name.text
        ));
    }
    i += 1;
    let mut items: Vec<Vec<&Token>> = vec![Vec::new()];
    let mut depth = 0;
    loop {
        let Some(tok) = t.get(i) else {
            return Err(format!(
                "the column list of the table {} is not closed",
                name.text
            ));
        };
        if punct(Some(tok), "(") {
            depth += 1;
        }
        if punct(Some(tok), ")") {
            if depth == 0 {
                break;
            }
            depth -= 1;
        }
        if punct(Some(tok), ",") && depth == 0 {
            items.push(Vec::new());
        } else {
            items.last_mut().expect("an item").push(tok);
        }
        i += 1;
    }
    let rest = &t[i + 1..];
    let without_rowid = (0..rest.len())
        .any(|k| keyword(rest.get(k), "WITHOUT") && keyword(rest.get(k + 1), "ROWID"));
    let mut columns: Vec<(Column, bool, bool)> = Vec::new();
    let mut table_pk: Vec<String> = Vec::new();
    for it in &items {
        let Some(head) = it.first() else {
            return Err(format!("the table {} declares an empty column", name.text));
        };
        if !head.quoted && TABLE_CONSTRAINTS.contains(&sql_upper(&head.text).as_str()) {
            if let Some(p) = (0..it.len()).find(|&k| {
                keyword(it.get(k).copied(), "PRIMARY") && keyword(it.get(k + 1).copied(), "KEY")
            }) {
                let open = (p + 1..it.len()).find(|&k| punct(it.get(k).copied(), "("));
                let mut names = Vec::new();
                if let Some(open) = open {
                    let mut d = 0;
                    for k in open + 1..it.len() {
                        let tok = it[k];
                        if punct(Some(tok), "(") {
                            d += 1;
                        }
                        if punct(Some(tok), ")") {
                            if d == 0 {
                                break;
                            }
                            d -= 1;
                        }
                        if d == 0
                            && tok.name
                            && (k == open + 1 || punct(it.get(k - 1).copied(), ","))
                        {
                            names.push(tok.text.clone());
                        }
                    }
                }
                table_pk = names;
            }
            continue;
        }
        if !head.name {
            return Err(format!(
                "the table {} declares a column without a name",
                name.text
            ));
        }
        let mut words: Vec<String> = Vec::new();
        let mut k = 1;
        while k < it.len() {
            let tok = it[k];
            if !tok.quoted && COLUMN_CONSTRAINTS.contains(&sql_upper(&tok.text).as_str()) {
                break;
            }
            if punct(Some(tok), "(") {
                let close = (k + 1..it.len()).find(|&m| punct(it.get(m).copied(), ")"));
                let end = close.unwrap_or(it.len());
                let inner: String = it[k + 1..end].iter().map(|x| x.text.as_str()).collect();
                let last = words.pop().unwrap_or_default();
                words.push(format!("{last}({inner})"));
                k = end + 1;
                continue;
            }
            words.push(tok.text.clone());
            k += 1;
        }
        let p = (k..it.len()).find(|&m| {
            keyword(it.get(m).copied(), "PRIMARY") && keyword(it.get(m + 1).copied(), "KEY")
        });
        columns.push((
            Column {
                name: head.text.clone(),
                typ: words.join(" "),
                rowid: false,
            },
            p.is_some(),
            p.is_some_and(|p| keyword(it.get(p + 2).copied(), "DESC")),
        ));
    }
    if !without_rowid {
        for (c, pk, desc) in &mut columns {
            let single = table_pk.len() == 1 && sql_upper(&table_pk[0]) == sql_upper(&c.name);
            c.rowid = sql_upper(&c.typ) == "INTEGER" && ((*pk && !*desc) || single);
        }
    }
    Ok((
        name.text.clone(),
        columns.into_iter().map(|(c, _, _)| c).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_varints_and_records_as_the_typescript_code_does() {
        let v = |x: u64| {
            let mut out = Vec::new();
            varint(x, &mut out);
            out
        };
        assert_eq!(v(0), [0]);
        assert_eq!(v(128), [0x81, 0x00]);
        assert_eq!(v(16_384), [0x81, 0x80, 0x00]);
        assert_eq!(v((1 << 56) - 1).len(), 8);
        assert_eq!(v(1 << 56).len(), 9);
        assert_eq!(v(u64::MAX), [0xff; 9]);
        let values = vec![
            SqlValue::Null,
            SqlValue::Int(0),
            SqlValue::Int(1),
            SqlValue::Int(2),
            SqlValue::Int(-1),
            SqlValue::Int(127),
            SqlValue::Int(128),
            SqlValue::Int(-128),
            SqlValue::Int(-129),
            SqlValue::Int(32_767),
            SqlValue::Int(32_768),
            SqlValue::Int(8_388_607),
            SqlValue::Int(8_388_608),
            SqlValue::Int(2_147_483_647),
            SqlValue::Int(2_147_483_648),
            SqlValue::Int(0x7fff_ffff_ffff),
            SqlValue::Int(0x8000_0000_0000),
            SqlValue::Int(i64::MIN),
            SqlValue::Int(i64::MAX),
            SqlValue::Real(0.1),
            SqlValue::Real(-0.0),
            SqlValue::Real(1e308),
            SqlValue::Text(String::new()),
            SqlValue::Text("Brent — 北海".into()),
            SqlValue::Blob(vec![0, 255, 7]),
        ];
        let record = encode_record(&values);
        assert_eq!(
            record[1..20],
            [0, 8, 9, 1, 1, 1, 2, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 6]
        );
        let back = decode_record(&record, 1).unwrap();
        assert_eq!(back.len(), values.len());
        for (a, b) in back.iter().zip(&values) {
            match (a, b) {
                (SqlValue::Real(x), SqlValue::Real(y)) => assert_eq!(x.to_bits(), y.to_bits()),
                _ => assert_eq!(a, b),
            }
        }
        assert!(
            decode_record(&[2, 10], 1)
                .unwrap_err()
                .contains("reserved serial type 10")
        );
    }

    #[test]
    fn finds_the_columns_and_the_rowid_alias() {
        let (name, columns) = parse_create_table(
            "CREATE TABLE \"my \"\"t\"\"\" ( \"fid\" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, [geom] POINT, -- a note\n`a b` VARCHAR(20) DEFAULT 'x,y', c DOUBLE PRECISION, d, e INTEGER, CONSTRAINT u UNIQUE (c, d))",
        )
        .unwrap();
        assert_eq!(name, "my \"t\"");
        let got: Vec<(String, String, bool)> = columns
            .into_iter()
            .map(|c| (c.name, c.typ, c.rowid))
            .collect();
        let want: Vec<(String, String, bool)> = [
            ("fid", "INTEGER", true),
            ("geom", "POINT", false),
            ("a b", "VARCHAR(20)", false),
            ("c", "DOUBLE PRECISION", false),
            ("d", "", false),
            ("e", "INTEGER", false),
        ]
        .iter()
        .map(|(a, b, c)| ((*a).to_string(), (*b).to_string(), *c))
        .collect();
        assert_eq!(got, want);
        let pk = |sql: &str| -> Vec<bool> {
            parse_create_table(sql)
                .unwrap()
                .1
                .into_iter()
                .map(|c| c.rowid)
                .collect()
        };
        assert_eq!(
            pk("CREATE TABLE t (a integer, b TEXT, PRIMARY KEY (a))"),
            [true, false]
        );
        assert_eq!(pk("CREATE TABLE t (a INTEGER PRIMARY KEY DESC)"), [false]);
        assert_eq!(
            pk("CREATE TABLE t (a INTEGER PRIMARY KEY, b) WITHOUT ROWID"),
            [false, false]
        );
        assert_eq!(
            parse_create_table("create temp table if not exists main.x(y)")
                .unwrap()
                .0,
            "x"
        );
        assert!(parse_create_table("CREATE TABLE t AS SELECT 1").is_err());
    }
}
