//! The FlatGeobuf profile, as the TypeScript export/flatgeobuf.ts plans it, formats/flatgeobuf
//! writes and reads it and readback.ts checks it: the same rules, the same bytes and the same
//! checks. The file is the magic bytes, a header and one feature per row in row order, each a
//! size-prefixed FlatBuffer, without a spatial index; the CRS is recorded by its EPSG code. Rows
//! are read from the output view in batches and written as they are read, and the read-back reads
//! the file one feature at a time, so a dataset of any size is never held in memory.

use crate::digest::{Cell, ColumnDigest};
use crate::error::{EngineError, Result};
use crate::export::{
    Expected, OutColumn, Spatial, check, header_check, retype_text, rows_check, values_check,
};
use crate::parse::{Kind, Raw};
use crate::shapefile::{
    Geom, Pos, ShapeSource, each_position, each_row, js_max, js_min, known_crs, row_geometry,
    shape_source, source_columns,
};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// "fgb", major version 3, "fgb", patch version 1.
const MAGIC: [u8; 8] = [0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x01];

const GEOMETRY_NAMES: [&str; 8] = [
    "Unknown",
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection",
];

const BOOL: u8 = 2;
const LONG: u8 = 7;
const DOUBLE: u8 = 10;
const STRING: u8 = 11;
const JSON: u8 = 12;
const DATETIME: u8 = 13;

/// The largest whole number a JavaScript number holds exactly.
const SAFE: f64 = 9_007_199_254_740_991.0;

// ---------------------------------------------------------------------------------------------
// FlatBuffers (formats/flatgeobuf/flatbuffers.ts): built back to front, every value aligned to its
// size from the start of the finished buffer, each table's vtable just before it.

struct Builder {
    buf: Vec<u8>,
    /// Bytes still free at the front; the written bytes are buf[space..].
    space: usize,
    minalign: usize,
    vtable: Vec<usize>,
    object_start: usize,
    vector_len: usize,
}

impl Builder {
    fn new() -> Builder {
        Builder {
            buf: vec![0; 1024],
            space: 1024,
            minalign: 1,
            vtable: Vec::new(),
            object_start: 0,
            vector_len: 0,
        }
    }

    fn offset(&self) -> usize {
        self.buf.len() - self.space
    }

    fn grow(&mut self, needed: usize) {
        while self.space < needed {
            let old = self.buf.len();
            let mut next = vec![0u8; old * 2];
            next[old..].copy_from_slice(&self.buf);
            self.space += old;
            self.buf = next;
        }
    }

    fn pad(&mut self, n: usize) {
        self.grow(n);
        for _ in 0..n {
            self.space -= 1;
            self.buf[self.space] = 0;
        }
    }

    fn prep(&mut self, size: usize, additional: usize) {
        self.minalign = self.minalign.max(size);
        let align = (size - (self.offset() + additional) % size) % size;
        self.grow(align + size + additional);
        self.pad(align);
    }

    fn raw(&mut self, bytes: &[u8]) {
        self.grow(bytes.len());
        self.space -= bytes.len();
        self.buf[self.space..self.space + bytes.len()].copy_from_slice(bytes);
    }

    fn put(&mut self, bytes: &[u8]) {
        self.prep(bytes.len(), 0);
        self.raw(bytes);
    }

    fn add_offset(&mut self, target: usize) {
        self.prep(4, 0);
        let v = (self.offset() - target + 4) as u32;
        self.put(&v.to_le_bytes());
    }

    fn string(&mut self, text: &str) -> usize {
        let bytes = text.as_bytes();
        self.prep(4, bytes.len() + 1);
        self.put(&[0]);
        self.raw(bytes);
        self.put(&(bytes.len() as u32).to_le_bytes());
        self.offset()
    }

    fn start_vector(&mut self, elem: usize, count: usize, alignment: usize) {
        self.vector_len = count;
        self.prep(4, elem * count);
        self.prep(alignment, elem * count);
    }

    fn end_vector(&mut self) -> usize {
        let n = (self.vector_len as u32).to_le_bytes();
        self.raw(&n);
        self.offset()
    }

    fn f64_vector(&mut self, values: &[f64]) -> usize {
        self.start_vector(8, values.len(), 8);
        for x in values.iter().rev() {
            self.put(&x.to_le_bytes());
        }
        self.end_vector()
    }

    fn u32_vector(&mut self, values: &[u32]) -> usize {
        self.start_vector(4, values.len(), 4);
        for x in values.iter().rev() {
            self.put(&x.to_le_bytes());
        }
        self.end_vector()
    }

    fn bytes(&mut self, bytes: &[u8]) -> usize {
        self.start_vector(1, bytes.len(), 1);
        self.raw(bytes);
        self.end_vector()
    }

    fn offset_vector(&mut self, targets: &[usize]) -> usize {
        self.start_vector(4, targets.len(), 4);
        for &t in targets.iter().rev() {
            self.add_offset(t);
        }
        self.end_vector()
    }

    fn start_table(&mut self, fields: usize) {
        self.vtable = vec![0; fields];
        self.object_start = self.offset();
    }

    fn slot(&mut self, slot: usize) {
        self.vtable[slot] = self.offset();
    }

    fn field_u8(&mut self, slot: usize, v: u8) {
        self.put(&[v]);
        self.slot(slot);
    }

    fn field_u16(&mut self, slot: usize, v: u16) {
        self.put(&v.to_le_bytes());
        self.slot(slot);
    }

    fn field_i32(&mut self, slot: usize, v: i32) {
        self.put(&v.to_le_bytes());
        self.slot(slot);
    }

    fn field_u64(&mut self, slot: usize, v: u64) {
        self.put(&v.to_le_bytes());
        self.slot(slot);
    }

    fn field_offset(&mut self, slot: usize, target: usize) {
        self.add_offset(target);
        self.slot(slot);
    }

    fn end_table(&mut self) -> usize {
        self.put(&0i32.to_le_bytes());
        let object = self.offset();
        let used = self
            .vtable
            .iter()
            .rposition(|&v| v != 0)
            .map_or(0, |i| i + 1);
        for i in (0..used).rev() {
            let at = self.vtable[i];
            let v = if at == 0 { 0 } else { (object - at) as u16 };
            self.put(&v.to_le_bytes());
        }
        self.put(&((object - self.object_start) as u16).to_le_bytes());
        self.put(&(((used + 2) * 2) as u16).to_le_bytes());
        let vtable = self.offset();
        // The table's first word: how far before it its vtable is.
        let at = self.buf.len() - object;
        self.buf[at..at + 4].copy_from_slice(&((vtable - object) as i32).to_le_bytes());
        object
    }

    fn finish(mut self, root: usize) -> Vec<u8> {
        let align = self.minalign;
        self.prep(align, 8);
        self.add_offset(root);
        let size = self.offset() as u32;
        self.put(&size.to_le_bytes());
        self.buf[self.space..].to_vec()
    }
}

// ---------------------------------------------------------------------------------------------
// The writer (formats/flatgeobuf/writer.ts)

fn type_code(g: &Geom) -> u8 {
    match g {
        Geom::Point(_) => 1,
        Geom::LineString(_) => 2,
        Geom::Polygon(_) => 3,
        Geom::MultiPoint(_) => 4,
        Geom::MultiLineString(_) => 5,
        Geom::MultiPolygon(_) => 6,
        Geom::Collection(_) => 7,
    }
}

/// The CRS of the data as the header records it (fgbCrs): EPSG and its code, and its name.
pub fn fgb_crs(code: &str) -> Option<(i32, Option<String>)> {
    let n: i64 = if code == "OGC:CRS84" {
        4326
    } else {
        let digits = code.strip_prefix("EPSG:")?;
        if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        digits.parse().ok()?
    };
    if n <= 0 {
        return None;
    }
    let name = crate::geodesy::crs_definition(&format!("EPSG:{n}")).map(|d| d.name);
    Some((n as i32, name))
}

fn column_type(kind: Kind) -> u8 {
    match kind {
        Kind::Integer => LONG,
        Kind::Number => DOUBLE,
        Kind::Boolean => BOOL,
        Kind::Date | Kind::DateTime => DATETIME,
        Kind::Geometry => JSON,
        Kind::String => STRING,
    }
}

struct HeaderOut<'a> {
    name: &'a str,
    envelope: Option<[f64; 4]>,
    geometry_type: u8,
    has_z: bool,
    columns: Vec<(String, u8)>,
    features: u64,
    crs: Option<(i32, Option<String>)>,
}

fn header_bytes(h: &HeaderOut) -> Vec<u8> {
    let mut b = Builder::new();
    let columns: Vec<usize> = h
        .columns
        .iter()
        .map(|(name, typ)| {
            let name = b.string(name);
            b.start_table(11);
            b.field_offset(0, name);
            b.field_u8(1, *typ);
            b.end_table()
        })
        .collect();
    let column_vector = (!columns.is_empty()).then(|| b.offset_vector(&columns));
    let name = b.string(h.name);
    let envelope = h.envelope.map(|e| b.f64_vector(&e));
    let crs = h.crs.as_ref().map(|(code, crs_name)| {
        let org = b.string("EPSG");
        let crs_name = crs_name.as_deref().map(|n| b.string(n));
        b.start_table(6);
        b.field_offset(0, org);
        b.field_i32(1, *code);
        if let Some(n) = crs_name {
            b.field_offset(2, n);
        }
        b.end_table()
    });
    b.start_table(14);
    if h.features > 0 {
        b.field_u64(8, h.features);
    }
    b.field_offset(0, name);
    if let Some(e) = envelope {
        b.field_offset(1, e);
    }
    if let Some(c) = column_vector {
        b.field_offset(7, c);
    }
    if let Some(c) = crs {
        b.field_offset(10, c);
    }
    // No spatial index; the field must be written, as its default is 16.
    b.field_u16(9, 0);
    if h.geometry_type != 0 {
        b.field_u8(2, h.geometry_type);
    }
    if h.has_z {
        b.field_u8(3, 1);
    }
    let root = b.end_table();
    b.finish(root)
}

/// The positions of a geometry without parts, and the running ends of its rings or lines.
fn flat(g: &Geom) -> (Vec<&Pos>, Option<Vec<u32>>) {
    match g {
        Geom::Point(p) => (if p.is_empty() { vec![] } else { vec![p] }, None),
        Geom::MultiPoint(ps) | Geom::LineString(ps) => (ps.iter().collect(), None),
        Geom::MultiLineString(parts) | Geom::Polygon(parts) => {
            let mut end = 0u32;
            let ends: Vec<u32> = parts
                .iter()
                .map(|p| {
                    end += p.len() as u32;
                    end
                })
                .collect();
            let positions = parts.iter().flatten().collect();
            (positions, (ends.len() != 1).then_some(ends))
        }
        Geom::MultiPolygon(_) | Geom::Collection(_) => (vec![], None),
    }
}

fn build_geometry(b: &mut Builder, g: &Geom, has_z: bool) -> usize {
    let parts: Option<Vec<usize>> = match g {
        Geom::MultiPolygon(polygons) => Some(
            polygons
                .iter()
                .map(|rings| build_polygon(b, rings, has_z))
                .collect(),
        ),
        Geom::Collection(members) => Some(
            members
                .iter()
                .map(|m| build_geometry(b, m, has_z))
                .collect(),
        ),
        _ => None,
    };
    if let Some(parts) = parts {
        let vector = b.offset_vector(&parts);
        b.start_table(8);
        b.field_offset(7, vector);
        b.field_u8(6, type_code(g));
        return b.end_table();
    }
    let (positions, ends) = flat(g);
    build_simple(b, &positions, ends.as_deref(), type_code(g), has_z)
}

fn build_polygon(b: &mut Builder, rings: &[Vec<Pos>], has_z: bool) -> usize {
    let mut end = 0u32;
    let ends: Vec<u32> = rings
        .iter()
        .map(|r| {
            end += r.len() as u32;
            end
        })
        .collect();
    let positions: Vec<&Pos> = rings.iter().flatten().collect();
    let ends = (ends.len() != 1).then_some(ends);
    build_simple(b, &positions, ends.as_deref(), 3, has_z)
}

fn build_simple(
    b: &mut Builder,
    positions: &[&Pos],
    ends: Option<&[u32]>,
    typ: u8,
    has_z: bool,
) -> usize {
    let xy: Vec<f64> = positions.iter().flat_map(|p| [p[0], p[1]]).collect();
    let xy = b.f64_vector(&xy);
    let z = has_z.then(|| {
        let z: Vec<f64> = positions.iter().map(|p| p[2]).collect();
        b.f64_vector(&z)
    });
    let ends = ends.map(|e| b.u32_vector(e));
    b.start_table(8);
    if let Some(e) = ends {
        b.field_offset(0, e);
    }
    b.field_offset(1, xy);
    if let Some(z) = z {
        b.field_offset(2, z);
    }
    b.field_u8(6, typ);
    b.end_table()
}

fn mismatch(column: &OutColumn, cell: &Cell) -> EngineError {
    EngineError::new(
        "INTERNAL",
        format!(
            "The value {} in column \"{}\" is not a {} value, so it cannot be written to FlatGeobuf.",
            json!(cell.text()),
            column.name,
            column.typ
        ),
        "Report this problem; the export was not written.",
    )
}

/// A row's values: each present one as its column's index, then the value (encodeProperties).
fn properties(columns: &[&OutColumn], cells: &[Cell], out: &mut Vec<u8>) -> Result<()> {
    out.clear();
    for (i, (column, cell)) in columns.iter().zip(cells).enumerate() {
        let cell = cell.clone().exportable();
        if cell == Cell::Null {
            continue;
        }
        out.extend_from_slice(&(i as u16).to_le_bytes());
        let text = |out: &mut Vec<u8>, t: &str| {
            out.extend_from_slice(&(t.len() as u32).to_le_bytes());
            out.extend_from_slice(t.as_bytes());
        };
        match (column.kind, &cell) {
            (Kind::Boolean, Cell::Bool(b)) => out.push(u8::from(*b)),
            (Kind::Integer, Cell::Num(x)) if x.fract() == 0.0 && x.abs() <= SAFE => {
                out.extend_from_slice(&(*x as i64).to_le_bytes())
            }
            (Kind::Number, Cell::Num(x)) => out.extend_from_slice(&x.to_le_bytes()),
            (Kind::String, Cell::Text(t)) | (Kind::Geometry, Cell::Geometry(t)) => text(out, t),
            (Kind::Date, Cell::Date(_)) | (Kind::DateTime, Cell::DateTime(_)) => {
                text(out, &cell.text())
            }
            _ => return Err(mismatch(column, &cell)),
        }
    }
    Ok(())
}

fn feature_bytes(geometry: Option<&Geom>, properties: &[u8], has_z: bool) -> Vec<u8> {
    let mut b = Builder::new();
    let props = (!properties.is_empty()).then(|| b.bytes(properties));
    let g = geometry.map(|g| build_geometry(&mut b, g, has_z));
    b.start_table(3);
    if let Some(g) = g {
        b.field_offset(0, g);
    }
    if let Some(p) = props {
        b.field_offset(1, p);
    }
    let root = b.end_table();
    b.finish(root)
}

// ---------------------------------------------------------------------------------------------
// The plan (plan.ts flatgeobufPlan, flatgeobuf.ts analyseFgb)

/// What the geometries of the view make of a header, and what they cannot keep (FgbAnalysis).
struct Analysis {
    geometry_type: u8,
    has_z: bool,
    mixed: bool,
    envelope: Option<[f64; 4]>,
    bad: u64,
    long: u64,
}

fn analyse(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    source: ShapeSource,
) -> Result<Analysis> {
    let mut types: Vec<u8> = Vec::new();
    let mut dims: Vec<usize> = Vec::new();
    let mut envelope: Option<[f64; 4]> = None;
    let (mut bad, mut long) = (0u64, 0u64);
    each_row(
        conn,
        view,
        columns,
        &source_columns(source),
        false,
        &mut |cells| {
            let (g, is_bad) = row_geometry(cells);
            if is_bad {
                bad += 1;
            }
            let Some(g) = g else { return Ok(()) };
            let t = type_code(&g);
            if !types.contains(&t) {
                types.push(t);
            }
            let mut longest = 0;
            each_position(&g, &mut |p| {
                if p.is_empty() {
                    return;
                }
                longest = longest.max(p.len());
                let d = p.len().min(3);
                if !dims.contains(&d) {
                    dims.push(d);
                }
                let (x, y) = (p[0], p[1]);
                envelope = Some(match envelope {
                    None => [x, y, x, y],
                    Some(e) => [
                        js_min(e[0], x),
                        js_min(e[1], y),
                        js_max(e[2], x),
                        js_max(e[3], y),
                    ],
                });
            });
            if longest > 3 {
                long += 1;
            }
            Ok(())
        },
    )?;
    Ok(Analysis {
        geometry_type: if types.len() == 1 { types[0] } else { 0 },
        has_z: dims == [3],
        mixed: dims.len() > 1,
        envelope,
        bad,
        long,
    })
}

pub struct FgbPlan {
    pub refusal: Option<(String, String)>,
    pub substitutions: Vec<Value>,
    /// The columns the features hold as properties: every column but the geometry column.
    pub attributes: Vec<usize>,
}

fn refused(reason: String, fix: &str) -> FgbPlan {
    FgbPlan {
        refusal: Some((reason, fix.into())),
        substitutions: Vec::new(),
        attributes: Vec::new(),
    }
}

pub fn plan(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
) -> Result<FgbPlan> {
    let Some(source) = shape_source(columns, spatial) else {
        return Ok(refused(
            "The dataset has no geometry column and no coordinate columns (longitude and latitude, or easting and northing).".into(),
            "Set the coordinate roles on the coordinate columns, or export as CSV or Excel.",
        ));
    };
    let Some(code) = known_crs(spatial) else {
        return Ok(refused(
            "The coordinate reference system of the data is not known, and a FlatGeobuf file records it.".into(),
            "Set the coordinate reference system of the dataset first.",
        ));
    };
    if fgb_crs(code).is_none() {
        return Ok(refused(
            format!(
                "A FlatGeobuf file records its coordinate reference system by EPSG code, and {code} has none."
            ),
            "Transform the coordinates to a listed coordinate reference system first (Data › Transform coordinates).",
        ));
    }
    let a = analyse(conn, view, columns, source)?;
    if a.mixed {
        return Ok(refused(
            "A FlatGeobuf file holds geometries all with heights or all without, and this dataset has both.".into(),
            "Filter the rows to geometries all with or all without heights, or export as GeoJSON, which holds any mix.",
        ));
    }
    let geometries = |n: u64| format!("{n} geometr{}", if n > 1 { "ies" } else { "y" });
    let mut substitutions = Vec::new();
    if a.bad > 0 {
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": geometries(a.bad),
            "why": "They do not have the shape of a geometry: a misplaced array or an unknown type.",
            "instead": "Their features have no geometry; their other values are kept.",
        }));
    }
    if a.long > 0 {
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": geometries(a.long),
            "why": "Their positions hold more than three numbers, and a FlatGeobuf position holds x, y and a height.",
            "instead": "Each position keeps its first three numbers; the GeoJSON export keeps them all.",
        }));
    }
    Ok(FgbPlan {
        refusal: None,
        substitutions,
        attributes: attributes(columns, source),
    })
}

fn attributes(columns: &[OutColumn], source: ShapeSource) -> Vec<usize> {
    (0..columns.len())
        .filter(|j| !matches!(source, ShapeSource::Geometry(g) if g == *j))
        .collect()
}

/// Writes data.fgb: the header, then one feature per row of the output view.
#[allow(clippy::too_many_arguments)]
pub fn write(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    attributes: &[usize],
    name: &str,
    rows: u64,
    ordered: bool,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let source = shape_source(columns, spatial)
        .ok_or_else(|| EngineError::internal("The FlatGeobuf file has no geometries to write."))?;
    let a = analyse(conn, view, columns, source)?;
    let attrs: Vec<&OutColumn> = attributes.iter().map(|&j| &columns[j]).collect();
    let mut out = BufWriter::with_capacity(1 << 20, File::create(path)?);
    out.write_all(&MAGIC)?;
    out.write_all(&header_bytes(&HeaderOut {
        name,
        envelope: a.envelope,
        geometry_type: a.geometry_type,
        has_z: a.has_z,
        columns: attrs
            .iter()
            .map(|c| (c.header(), column_type(c.kind)))
            .collect(),
        features: rows,
        crs: fgb_crs(known_crs(spatial).unwrap_or_default()),
    }))?;
    let src = source_columns(source);
    let picked: Vec<usize> = src.iter().chain(attributes).copied().collect();
    let mut props = Vec::new();
    let mut n = 0u64;
    each_row(conn, view, columns, &picked, ordered, &mut |cells| {
        if n.is_multiple_of(4096) && cancel.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The export was cancelled.",
                "Start the export again when you are ready.",
            ));
        }
        n += 1;
        properties(&attrs, &cells[src.len()..], &mut props)?;
        let g = row_geometry(&cells[..src.len()]).0;
        out.write_all(&feature_bytes(g.as_ref(), &props, a.has_z))?;
        Ok(())
    })?;
    out.flush()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The reader (formats/flatgeobuf/reader.ts)

enum Bad {
    /// A reason the format gives.
    Format(String),
    /// An offset that points outside its buffer, or a string that is not UTF-8.
    Range(&'static str),
}

type Got<T> = std::result::Result<T, Bad>;

const OUTSIDE: &str = "an offset points outside the buffer";

fn fail<T>(why: impl Into<String>) -> Got<T> {
    Err(Bad::Format(why.into()))
}

struct Flat<'a> {
    b: &'a [u8],
}

impl<'a> Flat<'a> {
    fn get(&self, at: usize, n: usize) -> Got<&'a [u8]> {
        at.checked_add(n)
            .and_then(|end| self.b.get(at..end))
            .ok_or(Bad::Range(OUTSIDE))
    }

    fn u8(&self, at: usize) -> Got<u8> {
        Ok(self.get(at, 1)?[0])
    }

    fn u16(&self, at: usize) -> Got<u16> {
        Ok(u16::from_le_bytes(
            self.get(at, 2)?.try_into().unwrap_or_default(),
        ))
    }

    fn i32(&self, at: usize) -> Got<i32> {
        Ok(i32::from_le_bytes(
            self.get(at, 4)?.try_into().unwrap_or_default(),
        ))
    }

    fn u32(&self, at: usize) -> Got<u32> {
        Ok(u32::from_le_bytes(
            self.get(at, 4)?.try_into().unwrap_or_default(),
        ))
    }

    fn u64(&self, at: usize) -> Got<u64> {
        Ok(u64::from_le_bytes(
            self.get(at, 8)?.try_into().unwrap_or_default(),
        ))
    }

    fn f64(&self, at: usize) -> Got<f64> {
        Ok(f64::from_le_bytes(
            self.get(at, 8)?.try_into().unwrap_or_default(),
        ))
    }

    fn indirect(&self, at: usize) -> Got<usize> {
        Ok(at + self.u32(at)? as usize)
    }

    /// Where field `slot` of the table at `table` is, or None when it is absent.
    fn field(&self, table: usize, slot: usize) -> Got<Option<usize>> {
        let vtable = table as i64 - self.i32(table)? as i64;
        if vtable < 0 {
            return Err(Bad::Range(OUTSIDE));
        }
        let vtable = vtable as usize;
        let size = self.u16(vtable)? as usize;
        let entry = 4 + 2 * slot;
        if entry >= size {
            return Ok(None);
        }
        let at = self.u16(vtable + entry)? as usize;
        Ok((at != 0).then_some(table + at))
    }

    fn vector(&self, table: usize, slot: usize) -> Got<Option<(usize, usize)>> {
        let Some(at) = self.field(table, slot)? else {
            return Ok(None);
        };
        let v = self.indirect(at)?;
        Ok(Some((v + 4, self.u32(v)? as usize)))
    }

    fn string(&self, table: usize, slot: usize) -> Got<Option<String>> {
        let Some((start, n)) = self.vector(table, slot)? else {
            return Ok(None);
        };
        String::from_utf8(self.get(start, n)?.to_vec())
            .map(Some)
            .map_err(|_| Bad::Range("a string is not UTF-8 text"))
    }

    fn doubles(&self, table: usize, slot: usize) -> Got<Option<Vec<f64>>> {
        let Some((start, n)) = self.vector(table, slot)? else {
            return Ok(None);
        };
        (0..n)
            .map(|i| self.f64(start + 8 * i))
            .collect::<Got<Vec<f64>>>()
            .map(Some)
    }

    fn flag(&self, table: usize, slot: usize) -> Got<bool> {
        Ok(match self.field(table, slot)? {
            Some(at) => self.u8(at)? != 0,
            None => false,
        })
    }
}

struct CrsRead {
    org: Option<String>,
    code: i32,
    name: Option<String>,
    code_string: Option<String>,
}

struct Header {
    name: Option<String>,
    envelope: Option<Vec<f64>>,
    geometry_type: u8,
    has_z: bool,
    has_mt: bool,
    columns: Vec<(String, u8)>,
    features: u64,
    index_node_size: u16,
    crs: Option<CrsRead>,
}

fn read_header(r: &Flat, t: usize) -> Got<Header> {
    let mut columns = Vec::new();
    if let Some((start, n)) = r.vector(t, 7)? {
        for i in 0..n {
            let c = r.indirect(start + 4 * i)?;
            let Some(name) = r.string(c, 0)? else {
                return fail(format!("column {} has no name", i + 1));
            };
            let typ = match r.field(c, 1)? {
                Some(at) => r.u8(at)?,
                None => 0,
            };
            columns.push((name, typ));
        }
    }
    let crs = match r.field(t, 10)? {
        Some(at) => {
            let c = r.indirect(at)?;
            let code = match r.field(c, 1)? {
                Some(at) => r.i32(at)?,
                None => 0,
            };
            Some(CrsRead {
                org: r.string(c, 0)?,
                code,
                name: r.string(c, 2)?,
                code_string: r.string(c, 5)?,
            })
        }
        None => None,
    };
    Ok(Header {
        name: r.string(t, 0)?,
        envelope: r.doubles(t, 1)?,
        geometry_type: match r.field(t, 2)? {
            Some(at) => r.u8(at)?,
            None => 0,
        },
        has_z: r.flag(t, 3)?,
        has_mt: r.flag(t, 4)? || r.flag(t, 5)? || r.flag(t, 6)?,
        columns,
        features: match r.field(t, 8)? {
            Some(at) => r.u64(at)?,
            None => 0,
        },
        index_node_size: match r.field(t, 9)? {
            Some(at) => r.u16(at)?,
            None => 16,
        },
        crs,
    })
}

/// The size of a packed Hilbert R-tree of `items` leaves (indexSize): 40 bytes a node.
fn index_size(items: u64, node_size: u16) -> u64 {
    if node_size == 0 || items == 0 {
        return 0;
    }
    let fanout = u64::from(node_size.max(2));
    let (mut count, mut total) = (items, items);
    loop {
        count = count.div_ceil(fanout);
        total += count;
        if count == 1 {
            return total * 40;
        }
    }
}

/// A geometry read back as GeoJSON, with the bounds of its positions folded into `bounds`.
fn read_geometry(
    r: &Flat,
    t: usize,
    fallback: u8,
    has_z: bool,
    bounds: &mut Option<[f64; 4]>,
) -> Got<Value> {
    let typ = match r.field(t, 6)? {
        Some(at) if r.u8(at)? != 0 => r.u8(at)?,
        _ => fallback,
    };
    let name = match GEOMETRY_NAMES.get(typ as usize) {
        Some(n) if *n != "Unknown" => *n,
        _ => return fail(format!("a geometry is of unknown type {typ}")),
    };
    let parts = r.vector(t, 7)?;
    if name == "MultiPolygon" || name == "GeometryCollection" {
        let mut members = Vec::new();
        if let Some((start, n)) = parts {
            for i in 0..n {
                let part = r.indirect(start + 4 * i)?;
                let fallback = if name == "MultiPolygon" { 3 } else { 0 };
                members.push(read_geometry(r, part, fallback, has_z, bounds)?);
            }
        }
        if name == "GeometryCollection" {
            return Ok(json!({ "type": "GeometryCollection", "geometries": members }));
        }
        let mut polygons = Vec::new();
        for m in members {
            if m["type"] != "Polygon" {
                return fail(format!(
                    "a part of a multipolygon is a {}",
                    m["type"].as_str().unwrap_or("")
                ));
            }
            polygons.push(m["coordinates"].clone());
        }
        return Ok(json!({ "type": "MultiPolygon", "coordinates": polygons }));
    }
    if parts.is_some() {
        return fail(format!("a {name} has parts"));
    }
    let xy = r.doubles(t, 1)?.unwrap_or_default();
    if xy.len() % 2 != 0 {
        return fail(format!("a {name} has an odd number of x and y values"));
    }
    let n = xy.len() / 2;
    let z = if has_z {
        Some(r.doubles(t, 2)?.unwrap_or_default())
    } else {
        None
    };
    if let Some(z) = &z
        && z.len() != n
    {
        return fail(format!(
            "a {name} has {} heights for {n} positions",
            z.len()
        ));
    }
    let positions: Vec<Value> = (0..n)
        .map(|i| {
            let (x, y) = (xy[2 * i], xy[2 * i + 1]);
            *bounds = Some(match *bounds {
                None => [x, y, x, y],
                Some(b) => [
                    js_min(b[0], x),
                    js_min(b[1], y),
                    js_max(b[2], x),
                    js_max(b[3], y),
                ],
            });
            match &z {
                Some(z) => json!([x, y, z[i]]),
                None => json!([x, y]),
            }
        })
        .collect();
    let split = match r.vector(t, 0)? {
        None => vec![Value::Array(positions.clone())],
        Some((start, count)) => {
            let mut out = Vec::new();
            let mut from = 0usize;
            for i in 0..count {
                let end = r.u32(start + 4 * i)? as usize;
                if end < from || end > n {
                    return fail(format!("the ends of a {name} do not fit its {n} positions"));
                }
                out.push(Value::Array(positions[from..end].to_vec()));
                from = end;
            }
            if from != n {
                return fail(format!(
                    "the ends of a {name} do not cover its {n} positions"
                ));
            }
            out
        }
    };
    Ok(match name {
        "Point" => {
            if n > 1 {
                return fail(format!("a Point has {n} positions"));
            }
            json!({ "type": "Point", "coordinates": positions.first().cloned().unwrap_or(json!([])) })
        }
        "MultiPoint" | "LineString" => json!({ "type": name, "coordinates": positions }),
        _ => json!({ "type": name, "coordinates": split }),
    })
}

/// A value as the file holds it (FgbReadValue).
enum Prop {
    Bool(bool),
    Num(f64),
    /// A whole number beyond 2^53, as its digits.
    Big(String),
    Bytes(Vec<u8>),
    Text(String),
}

fn whole(v: i128) -> Prop {
    if v.unsigned_abs() <= SAFE as u128 {
        Prop::Num(v as f64)
    } else {
        Prop::Big(v.to_string())
    }
}

fn read_properties(b: &[u8], columns: &[(String, u8)]) -> Got<Vec<Option<Prop>>> {
    let mut out: Vec<Option<Prop>> = columns.iter().map(|_| None).collect();
    let mut seen = vec![false; columns.len()];
    let mut at = 0usize;
    let take = |at: &mut usize, n: usize| -> Got<&[u8]> {
        let s = b
            .get(*at..*at + n)
            .ok_or_else(|| Bad::Format("a feature\u{2019}s values are cut short".into()))?;
        *at += n;
        Ok(s)
    };
    while at < b.len() {
        let i = u16::from_le_bytes(take(&mut at, 2)?.try_into().unwrap_or_default()) as usize;
        let Some((name, typ)) = columns.get(i) else {
            return fail(format!(
                "a feature has a value for column {i}, which the header does not list"
            ));
        };
        if seen[i] {
            return fail(format!("a feature has two values for the column {name}"));
        }
        seen[i] = true;
        let fixed = |at: &mut usize, n: usize| -> Got<[u8; 8]> {
            let mut a = [0u8; 8];
            a[..n].copy_from_slice(take(at, n)?);
            Ok(a)
        };
        out[i] = Some(match typ {
            0 => Prop::Num(fixed(&mut at, 1)?[0] as i8 as f64),
            1 => Prop::Num(fixed(&mut at, 1)?[0] as f64),
            2 => Prop::Bool(fixed(&mut at, 1)?[0] != 0),
            3 => {
                let a = fixed(&mut at, 2)?;
                Prop::Num(i16::from_le_bytes([a[0], a[1]]) as f64)
            }
            4 => {
                let a = fixed(&mut at, 2)?;
                Prop::Num(u16::from_le_bytes([a[0], a[1]]) as f64)
            }
            5 => {
                let a = fixed(&mut at, 4)?;
                Prop::Num(i32::from_le_bytes([a[0], a[1], a[2], a[3]]) as f64)
            }
            6 => {
                let a = fixed(&mut at, 4)?;
                Prop::Num(u32::from_le_bytes([a[0], a[1], a[2], a[3]]) as f64)
            }
            7 => whole(i64::from_le_bytes(fixed(&mut at, 8)?) as i128),
            8 => whole(u64::from_le_bytes(fixed(&mut at, 8)?) as i128),
            9 => {
                let a = fixed(&mut at, 4)?;
                Prop::Num(f32::from_le_bytes([a[0], a[1], a[2], a[3]]) as f64)
            }
            10 => Prop::Num(f64::from_le_bytes(fixed(&mut at, 8)?)),
            11..=14 => {
                let a = fixed(&mut at, 4)?;
                let n = u32::from_le_bytes([a[0], a[1], a[2], a[3]]) as usize;
                let raw = take(&mut at, n)?;
                if *typ == 14 {
                    Prop::Bytes(raw.to_vec())
                } else {
                    match std::str::from_utf8(raw) {
                        Ok(t) => Prop::Text(t.to_string()),
                        Err(_) => {
                            return fail(format!("a value of the column {name} is not UTF-8 text"));
                        }
                    }
                }
            }
            _ => return fail(format!("the column {name} is of unknown type {typ}")),
        });
    }
    Ok(out)
}

/// A value re-typed with the manifest's column type (retypeFgb); None when it does not fit.
fn retype(v: Option<&Prop>, kind: Kind) -> Option<Cell> {
    let Some(v) = v else { return Some(Cell::Null) };
    match (kind, v) {
        (Kind::Integer, Prop::Num(x)) if x.fract() == 0.0 => Some(Cell::Num(*x)),
        (Kind::Number, Prop::Num(x)) => Some(Cell::Num(*x)),
        (Kind::Boolean, Prop::Bool(b)) => Some(Cell::Bool(*b)),
        (Kind::String | Kind::Date | Kind::DateTime | Kind::Geometry, Prop::Text(t)) => {
            retype_text(t, kind)
        }
        _ => None,
    }
}

/// Reads one size-prefixed FlatBuffer; None at the end of the file.
fn next_buffer(r: &mut BufReader<File>, what: &str) -> Got<Option<Vec<u8>>> {
    let cut = || Bad::Format(format!("{what} is cut short"));
    if r.fill_buf().map_err(|_| cut())?.is_empty() {
        return Ok(None);
    }
    let mut size = [0u8; 4];
    r.read_exact(&mut size).map_err(|_| cut())?;
    let size = u32::from_le_bytes(size) as usize;
    if size < 4 {
        return Err(cut());
    }
    let mut buf = vec![0u8; size];
    r.read_exact(&mut buf).map_err(|_| cut())?;
    Ok(Some(buf))
}

/// Feature `n` (1-based) from the bytes of its FlatBuffer: its geometry and its values by column,
/// with the bounds of its positions folded into `bounds` (parseFeature).
fn parse_feature(
    bytes: &[u8],
    header: &Header,
    n: u64,
    bounds: &mut Option<[f64; 4]>,
) -> std::result::Result<(Option<Value>, Vec<Option<Prop>>), String> {
    let f = Flat { b: bytes };
    let feature = (|| -> Got<(Option<Value>, Vec<Option<Prop>>)> {
        let root = f.u32(0)? as usize;
        let g = match f.field(root, 0)? {
            Some(at) => Some(read_geometry(
                &f,
                f.indirect(at)?,
                header.geometry_type,
                header.has_z,
                bounds,
            )?),
            None => None,
        };
        let props = match f.vector(root, 1)? {
            Some((start, len)) => read_properties(f.get(start, len)?, &header.columns)?,
            None => header.columns.iter().map(|_| None).collect(),
        };
        Ok((g, props))
    })();
    feature.map_err(|e| match e {
        Bad::Format(m) => format!("feature {n}: {m}"),
        Bad::Range(m) => format!("feature {n} does not parse ({m})"),
    })
}

/// The header from the bytes of its FlatBuffer (parseHeader).
fn parse_header(bytes: &[u8]) -> std::result::Result<Header, String> {
    let flat = Flat { b: bytes };
    flat.u32(0)
        .and_then(|root| read_header(&flat, root as usize))
        .map_err(|e| wrap(e, "the header"))
}

fn wrap(e: Bad, what: &str) -> String {
    match e {
        Bad::Format(m) => m,
        Bad::Range(m) => format!("{what} does not parse ({m})"),
    }
}

// ---------------------------------------------------------------------------------------------
// The read-back (readback.ts readFlatGeobufFile)

/// A geometry as the file holds it and a reader takes it back (fgbForm): at most three numbers a
/// position.
fn form(g: &Geom) -> Value {
    let p = |p: &Pos| json!(p.iter().take(3).collect::<Vec<_>>());
    let ps = |ps: &[Pos]| Value::Array(ps.iter().map(p).collect());
    let pss = |pss: &[Vec<Pos>]| Value::Array(pss.iter().map(|x| ps(x)).collect());
    match g {
        Geom::Point(x) => json!({ "type": "Point", "coordinates": p(x) }),
        Geom::MultiPoint(x) => json!({ "type": "MultiPoint", "coordinates": ps(x) }),
        Geom::LineString(x) => json!({ "type": "LineString", "coordinates": ps(x) }),
        Geom::MultiLineString(x) => json!({ "type": "MultiLineString", "coordinates": pss(x) }),
        Geom::Polygon(x) => json!({ "type": "Polygon", "coordinates": pss(x) }),
        Geom::MultiPolygon(x) => json!({
            "type": "MultiPolygon",
            "coordinates": Value::Array(x.iter().map(|r| pss(r)).collect()),
        }),
        Geom::Collection(x) => json!({
            "type": "GeometryCollection",
            "geometries": Value::Array(x.iter().map(form).collect()),
        }),
    }
}

fn geometry_cell(g: Option<&Value>) -> Cell {
    g.map_or(Cell::Null, |g| Cell::Geometry(g.to_string()))
}

fn same_box(a: &[f64], b: &[f64; 4]) -> bool {
    a.len() == 4 && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

/// Reads data.fgb back: RB-OPEN, RB-FGB-STRUCTURE, RB-HEADER, RB-ROWS, RB-VALUES and
/// RB-FGB-GEOMETRY.
#[allow(clippy::too_many_arguments)]
pub fn read_back(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    expected: &Expected,
    name: &str,
    ordered: bool,
    path: &Path,
    file: &str,
) -> Result<Vec<Value>> {
    let source = shape_source(columns, spatial).ok_or_else(|| {
        EngineError::internal("The FlatGeobuf file has no geometries to read back.")
    })?;
    let a = analyse(conn, view, columns, source)?;
    let crs = fgb_crs(known_crs(spatial).unwrap_or_default());
    let mut want = ColumnDigest::default();
    each_row(
        conn,
        view,
        columns,
        &source_columns(source),
        ordered,
        &mut |cells| {
            let g = row_geometry(cells).0.map(|g| form(&g));
            want.push(&geometry_cell(g.as_ref()));
            Ok(())
        },
    )?;
    let want = want.finish();

    struct Read {
        header: Header,
        index: u64,
        features: u64,
        mistyped: u64,
        bounds: Option<[f64; 4]>,
        values: Vec<Option<ColumnDigest>>,
        shapes: ColumnDigest,
    }
    let read = (|| -> std::result::Result<Read, String> {
        let mut r = BufReader::with_capacity(1 << 20, File::open(path).map_err(|e| e.to_string())?);
        let mut magic = [0u8; 8];
        let ok = r.read_exact(&mut magic).is_ok()
            && (0..3).all(|i| magic[i] == MAGIC[i] && magic[i + 4] == MAGIC[i]);
        if !ok {
            return Err("it does not start with the FlatGeobuf magic bytes".into());
        }
        if magic[3] != 3 {
            return Err(format!("it is FlatGeobuf version {}, not 3", magic[3]));
        }
        let bytes = next_buffer(&mut r, "the header")
            .map_err(|e| wrap(e, "the header"))?
            .ok_or("the header is cut short")?;
        let header = parse_header(&bytes)?;
        let index = index_size(header.features, header.index_node_size);
        let skipped = std::io::copy(&mut (&mut r).take(index), &mut std::io::sink())
            .map_err(|e| e.to_string())?;
        if skipped < index {
            return Err("the spatial index is cut short".into());
        }
        let mut out = Read {
            index,
            features: 0,
            mistyped: 0,
            bounds: None,
            values: expected
                .columns
                .iter()
                .map(|_| Some(ColumnDigest::default()))
                .collect(),
            shapes: ColumnDigest::default(),
            header,
        };
        let header_type = GEOMETRY_NAMES
            .get(out.header.geometry_type as usize)
            .copied();
        loop {
            let n = out.features + 1;
            let what = format!("feature {n}");
            let Some(bytes) = next_buffer(&mut r, &what).map_err(|e| wrap(e, &what))? else {
                break;
            };
            let (g, props) = parse_feature(&bytes, &out.header, n, &mut out.bounds)?;
            if let Some(g) = &g
                && out.header.geometry_type != 0
                && Some(g["type"].as_str().unwrap_or("")) != header_type
            {
                out.mistyped += 1;
            }
            out.shapes.push(&geometry_cell(g.as_ref()));
            for (j, col) in expected.columns.iter().enumerate() {
                let cell = retype(props.get(j).and_then(Option::as_ref), col.kind);
                match (cell, &mut out.values[j]) {
                    (Some(c), Some(d)) => d.push(&c),
                    _ => out.values[j] = None,
                }
            }
            out.features = n;
        }
        Ok(out)
    })();
    let read = match read {
        Ok(r) => r,
        Err(why) => {
            return Ok(vec![check(
                "RB-OPEN",
                false,
                format!("The file does not parse as FlatGeobuf: {why}."),
                Some(file),
            )]);
        }
    };
    let mut checks = vec![check(
        "RB-OPEN",
        true,
        "The file parses as FlatGeobuf.".into(),
        Some(file),
    )];
    let h = &read.header;
    let type_name = |t: u8| {
        GEOMETRY_NAMES
            .get(t as usize)
            .map_or(format!("type {t}"), |n| (*n).to_string())
    };
    let mut problems: Vec<String> = Vec::new();
    if h.name.as_deref() != Some(name) {
        problems.push("the header is not named after the dataset".into());
    }
    if h.features != read.features {
        problems.push(format!(
            "the header counts {} features and the file holds {}",
            h.features, read.features
        ));
    }
    if h.index_node_size != 0 || read.index != 0 {
        problems.push("the header declares a spatial index, which would reorder the rows".into());
    }
    if h.geometry_type != a.geometry_type {
        problems.push(format!(
            "the header states {} geometries, not {}",
            type_name(h.geometry_type),
            type_name(a.geometry_type)
        ));
    }
    if h.has_z != a.has_z {
        problems.push(
            if a.has_z {
                "the header does not declare heights"
            } else {
                "the header declares heights"
            }
            .into(),
        );
    }
    if h.has_mt {
        problems.push("the header declares measures or times, which the data has none of".into());
    }
    let same_crs = match (&crs, &h.crs) {
        (None, None) => true,
        (Some((code, crs_name)), Some(read)) => {
            read.org.as_deref() == Some("EPSG") && read.code == *code && &read.name == crs_name
        }
        _ => false,
    };
    if !same_crs {
        problems.push(
            "the header does not record the coordinate reference system of the data by its EPSG code"
                .into(),
        );
    }
    for (col, (cname, typ)) in expected.columns.iter().zip(&h.columns) {
        if *typ != column_type(col.kind) {
            problems.push(format!("the column {cname} is of type {typ}"));
        }
    }
    if read.mistyped > 0 {
        problems.push(format!(
            "{} features are not of the type the header states",
            read.mistyped
        ));
    }
    let bounded = match (&read.bounds, &h.envelope) {
        (None, None) => true,
        (Some(b), Some(e)) => same_box(e, b),
        _ => false,
    };
    if !bounded {
        problems.push("the header envelope does not bound the geometries".into());
    }
    checks.push(if problems.is_empty() {
        check(
            "RB-FGB-STRUCTURE",
            true,
            format!(
                "A FlatGeobuf 3 file with {} features in row order, no spatial index, typed columns, an envelope that bounds the geometries and the EPSG code of the data.",
                read.features
            ),
            Some(file),
        )
    } else {
        problems.truncate(5);
        check(
            "RB-FGB-STRUCTURE",
            false,
            format!("FlatGeobuf structure problems: {}.", problems.join("; ")),
            Some(file),
        )
    });
    let headers: Vec<String> = h.columns.iter().map(|(n, _)| n.clone()).collect();
    checks.push(header_check(expected, &headers, file));
    checks.push(rows_check(read.features, expected.rows, file));
    let values: Vec<Option<String>> = read
        .values
        .into_iter()
        .map(|d| d.map(ColumnDigest::finish))
        .collect();
    checks.push(values_check(expected, &values, file));
    checks.push(
        if read.shapes.finish() == want && read.features == expected.rows {
            check(
                "RB-FGB-GEOMETRY",
                true,
                "Every feature's geometry matches its row's, coordinate for coordinate.".into(),
                Some(file),
            )
        } else {
            check(
                "RB-FGB-GEOMETRY",
                false,
                "The feature geometries differ from the geometries of the rows.".into(),
                Some(file),
            )
        },
    );
    Ok(checks)
}

// ---------------------------------------------------------------------------------------------
// Import (formats/flatgeobuf/importer.ts)

/// A feature as a row: its 0-based index, its fields by column, and its geometry as the JSON text
/// JavaScript writes for it.
pub type Row = (u64, Vec<Raw>, Option<String>);

const PARSE_FIX: &str =
    "Export the layer again as FlatGeobuf from the GIS tool, then import the new copy.";

fn parse_failed(why: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The FlatGeobuf file does not parse: {why}."),
        PARSE_FIX,
    )
}

/// A value as a field (fieldOf): a number that is not finite, a whole number beyond 2^53 and
/// binary data as text.
fn raw_of(p: Option<Prop>) -> Raw {
    match p {
        None => Raw::Null,
        Some(Prop::Bool(b)) => Raw::Bool(b),
        Some(Prop::Num(x)) if x.is_finite() => Raw::Number(x),
        Some(Prop::Num(x)) => Raw::Text(
            if x.is_nan() {
                "NaN"
            } else if x > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            }
            .into(),
        ),
        Some(Prop::Big(digits)) => Raw::Text(digits),
        Some(Prop::Bytes(b)) => Raw::Text(b.iter().map(|x| format!("{x:02x}")).collect()),
        Some(Prop::Text(t)) => Raw::Text(t),
    }
}

/// A feature as a row; its geometry's numbers that are not finite become null and -0 becomes 0,
/// as JSON text writes them.
fn row_of(index: u64, g: Option<Value>, props: Vec<Option<Prop>>) -> Row {
    (
        index,
        props.into_iter().map(raw_of).collect(),
        g.map(|g| crate::canonical::stringify(&g)),
    )
}

/// Reads bytes through, hashing and counting them.
struct Hashing<'a> {
    inner: File,
    hash: sha2::Sha256,
    size: u64,
    bytes_read: &'a std::sync::atomic::AtomicU64,
}

impl Read for Hashing<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use sha2::Digest;
        let n = self.inner.read(buf)?;
        self.hash.update(&buf[..n]);
        self.size += n as u64;
        self.bytes_read.store(self.size, Ordering::Relaxed);
        Ok(n)
    }
}

/// Reads exactly `buf.len()` bytes; false when the file ends first.
fn fill(r: &mut impl Read, buf: &mut [u8]) -> Result<bool> {
    let mut got = 0;
    while got < buf.len() {
        let n = r.read(&mut buf[got..])?;
        if n == 0 {
            return Ok(false);
        }
        got += n;
    }
    Ok(true)
}

/// Checks the magic bytes and the version (the stream reader's first stage).
fn check_magic(magic: &[u8]) -> std::result::Result<(), String> {
    if magic.len() < 8 || (0..3).any(|i| magic[i] != MAGIC[i] || magic[i + 4] != MAGIC[i]) {
        return Err("it does not start with the FlatGeobuf magic bytes".into());
    }
    if magic[3] != 3 {
        return Err(format!("it is FlatGeobuf version {}, not 3", magic[3]));
    }
    Ok(())
}

/// Hashes the file and reads its features as rows, one at a time (importer.ts read). Returns the
/// notes (none), the SHA-256 and the size.
pub fn read_rows(
    path: &Path,
    send: &mut dyn FnMut(Row) -> Result<()>,
    cancel: &AtomicBool,
    bytes_read: &std::sync::atomic::AtomicU64,
) -> Result<(Vec<crate::csv::Note>, String, u64)> {
    use sha2::Digest;
    let mut r = BufReader::with_capacity(
        4 << 20,
        Hashing {
            inner: File::open(path)?,
            hash: sha2::Sha256::new(),
            size: 0,
            bytes_read,
        },
    );
    let mut magic = [0u8; 8];
    if !fill(&mut r, &mut magic)? {
        return Err(parse_failed(
            "it does not start with the FlatGeobuf magic bytes",
        ));
    }
    check_magic(&magic).map_err(parse_failed)?;
    let mut word = [0u8; 4];
    let cut = |what: &str| parse_failed(format!("{what} is cut short"));
    if !fill(&mut r, &mut word)? {
        return Err(cut("the header"));
    }
    let size = u32::from_le_bytes(word) as usize;
    if size < 4 {
        return Err(cut("the header"));
    }
    let mut bytes = vec![0u8; size];
    if !fill(&mut r, &mut bytes)? {
        return Err(cut("the header"));
    }
    let header = parse_header(&bytes).map_err(parse_failed)?;
    let index = index_size(header.features, header.index_node_size);
    if std::io::copy(&mut (&mut r).take(index), &mut std::io::sink())? < index {
        return Err(parse_failed("the spatial index is cut short"));
    }
    let mut n = 0u64;
    loop {
        if n.is_multiple_of(1024) && cancel.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The import was cancelled.",
                "Start the import again when you are ready.",
            ));
        }
        if r.fill_buf()?.is_empty() {
            break;
        }
        let what = format!("feature {}", n + 1);
        if !fill(&mut r, &mut word)? {
            return Err(cut(&what));
        }
        let size = u32::from_le_bytes(word) as usize;
        if size < 4 {
            return Err(cut(&what));
        }
        bytes.resize(size, 0);
        if !fill(&mut r, &mut bytes)? {
            return Err(cut(&what));
        }
        let (g, props) = parse_feature(&bytes, &header, n + 1, &mut None).map_err(parse_failed)?;
        send(row_of(n, g, props))?;
        n += 1;
    }
    let inner = r.into_inner();
    let digest = inner
        .hash
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((Vec::new(), digest, inner.size))
}

/// What a sniff finds (importer.ts sniff): the column names, the detections and the sample.
pub struct Sniff {
    pub columns: Vec<String>,
    pub detections: Vec<(String, Value)>,
    pub rows: Vec<Row>,
}

fn crs_detection(h: &Header) -> Value {
    let found = |code: String, evidence: String| {
        crate::detect::det(
            json!({ "code": code, "source": "flatgeobuf-header" }),
            "high",
            "flatgeobuf-header",
            evidence,
            false,
        )
    };
    let unknown = |evidence: String| {
        crate::detect::det(
            json!({ "code": "unknown", "source": "flatgeobuf-header" }),
            "low",
            "flatgeobuf-header",
            evidence,
            false,
        )
    };
    let Some(crs) = &h.crs else {
        return unknown("The FlatGeobuf header records no coordinate reference system.".into());
    };
    let org = crs.org.as_deref().unwrap_or("EPSG").to_uppercase();
    let named = crs
        .name
        .as_ref()
        .map_or(String::new(), |n| format!(" ({n})"));
    if org == "EPSG" && crs.code > 0 {
        let code = format!("EPSG:{}", crs.code);
        let evidence =
            format!("The FlatGeobuf header records the coordinate reference system {code}{named}.");
        return found(code, evidence);
    }
    if org == "OGC" && crs.code_string.as_deref().unwrap_or("").to_uppercase() == "CRS84" {
        return found(
            "OGC:CRS84".into(),
            "The FlatGeobuf header records the coordinate reference system OGC:CRS84.".into(),
        );
    }
    let code = if crs.code > 0 {
        Some(crs.code.to_string())
    } else {
        crs.code_string.clone()
    };
    let what: Vec<String> = [crs.org.clone(), code].into_iter().flatten().collect();
    let what = what.join(":");
    unknown(format!(
        "The FlatGeobuf header records the coordinate reference system {}{named}, which is not an EPSG code.",
        if what.is_empty() {
            "without a code"
        } else {
            &what
        }
    ))
}

fn geometry_types_detection(h: &Header, rows: &[Row], complete: bool) -> Value {
    let name = |t: u8| {
        GEOMETRY_NAMES
            .get(t as usize)
            .map_or(format!("type {t}"), |n| (*n).to_string())
    };
    if h.geometry_type != 0 {
        let n = name(h.geometry_type);
        return crate::detect::det(
            json!([n]),
            "high",
            "flatgeobuf-header",
            format!("The FlatGeobuf header states that every geometry is a {n}."),
            false,
        );
    }
    let mut types: Vec<String> = Vec::new();
    for (_, _, g) in rows {
        let t = g
            .as_deref()
            .and_then(|g| serde_json::from_str::<Value>(g).ok())
            .and_then(|g| g["type"].as_str().map(String::from));
        if let Some(t) = t
            && !types.contains(&t)
        {
            types.push(t);
        }
    }
    let count = crate::csv::format_count(rows.len() as u64);
    let scope = if complete {
        format!("all {count} features")
    } else {
        format!("the first {count} features")
    };
    let found = if types.is_empty() {
        "no geometry types".to_string()
    } else {
        format!("geometry types {}", types.join(", "))
    };
    crate::detect::det(
        json!(types),
        if complete { "high" } else { "medium" },
        "geometry-types",
        format!("The header states no single geometry type; found {found} over {scope}."),
        false,
    )
}

/// The sniff of a FlatGeobuf file (importer.ts sniff): the header, however long; then the
/// features in the MiB after the spatial index, which is not read through, or the first feature,
/// however long, as the sample; at most `sample` of them. The windows are those of the TypeScript
/// reader, which reads a MiB at a time, so both take the same features.
pub fn sniff(path: &Path, sample: usize) -> Result<Sniff> {
    use std::io::{Seek, SeekFrom};
    const MIB: u64 = 1 << 20;
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let mut magic = [0u8; 8];
    if size < 8 || !fill(&mut f, &mut magic)? {
        return Err(parse_failed(
            "it does not start with the FlatGeobuf magic bytes",
        ));
    }
    check_magic(&magic).map_err(parse_failed)?;
    let mut word = [0u8; 4];
    if size < 12 || !fill(&mut f, &mut word)? {
        return Err(parse_failed("the header is cut short"));
    }
    let header_size = u32::from_le_bytes(word) as u64;
    if header_size < 4 || 12 + header_size > size {
        return Err(parse_failed("the header is cut short"));
    }
    let mut bytes = vec![0u8; header_size as usize];
    fill(&mut f, &mut bytes)?;
    let header = parse_header(&bytes).map_err(parse_failed)?;
    let header_end = 12 + header_size;
    let first = header_end + index_size(header.features, header.index_node_size);
    // The reads of a MiB from the start that the header took, then the jump past the index.
    let mut at = size.min(header_end.div_ceil(MIB) * MIB);
    if at < first {
        at = first.min(size);
    }
    let limit = size.min(first + MIB);
    let mut rows: Vec<Row> = Vec::new();
    let mut pos = first;
    let mut parse_to = |at: u64, rows: &mut Vec<Row>| -> Result<()> {
        loop {
            if pos + 4 > at {
                return Ok(());
            }
            f.seek(SeekFrom::Start(pos))?;
            fill(&mut f, &mut word)?;
            let len = u32::from_le_bytes(word) as u64;
            let n = rows.len() as u64 + 1;
            if len < 4 {
                return Err(parse_failed(format!("feature {n} is cut short")));
            }
            if pos + 4 + len > at {
                return Ok(());
            }
            let mut b = vec![0u8; len as usize];
            fill(&mut f, &mut b)?;
            let (g, props) = parse_feature(&b, &header, n, &mut None).map_err(parse_failed)?;
            rows.push(row_of(n - 1, g, props));
            pos += 4 + len;
        }
    };
    parse_to(at, &mut rows)?;
    while rows.len() < sample && (at < limit || (rows.is_empty() && at < size)) {
        at = size.min(at + MIB);
        parse_to(at, &mut rows)?;
    }
    let complete = at >= size;
    if complete && pos < size && first <= size {
        return Err(parse_failed(format!(
            "feature {} is cut short",
            rows.len() + 1
        )));
    }
    let all = rows.len();
    rows.truncate(sample);
    let mut detections = vec![
        ("crs".to_string(), crs_detection(&header)),
        (
            "columns".to_string(),
            crate::detect::det(
                json!(header.columns.iter().map(|c| &c.0).collect::<Vec<_>>()),
                "high",
                "flatgeobuf-header",
                format!(
                    "The FlatGeobuf header lists {} columns.",
                    header.columns.len()
                ),
                false,
            ),
        ),
        (
            "geometryTypes".to_string(),
            geometry_types_detection(&header, &rows, complete && all <= sample),
        ),
    ];
    if header.features > 0 && header.features <= SAFE as u64 {
        detections.push((
            "rowCount".to_string(),
            crate::detect::det(
                json!(header.features),
                "high",
                "flatgeobuf-header",
                format!(
                    "The FlatGeobuf header counts {} features.",
                    crate::csv::format_count(header.features)
                ),
                false,
            ),
        ));
    }
    Ok(Sniff {
        columns: header.columns.iter().map(|c| c.0.clone()).collect(),
        detections,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f64s(x: f64) -> Vec<u8> {
        x.to_le_bytes().to_vec()
    }

    #[test]
    fn writes_the_bytes_the_typescript_writer_writes() {
        let header = header_bytes(&HeaderOut {
            name: "t",
            envelope: None,
            geometry_type: 0,
            has_z: false,
            columns: Vec::new(),
            features: 0,
            crs: None,
        });
        #[rustfmt::skip]
        let want: Vec<u8> = vec![
            48, 0, 0, 0, 28, 0, 0, 0, 24, 0, 12, 0,
            8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0,
            24, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0x74, 0, 0, 0,
        ];
        assert_eq!(header, want);
        let point = feature_bytes(Some(&Geom::Point(vec![1.0, 2.0])), &[], false);
        #[rustfmt::skip]
        let mut want: Vec<u8> = vec![
            76, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            6, 0, 10, 0, 4, 0, 6, 0, 0, 0, 24, 0, 0, 0, 0, 0,
            18, 0, 12, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0,
            18, 0, 0, 0, 0, 0, 0, 1, 4, 0, 0, 0, 2, 0, 0, 0,
        ];
        want.extend(f64s(1.0));
        want.extend(f64s(2.0));
        assert_eq!(point, want);
    }

    #[test]
    fn reads_back_what_it_writes() {
        let g = Geom::Collection(vec![
            Geom::Point(vec![7.0, 8.0, 9.0]),
            Geom::MultiPolygon(vec![vec![
                vec![
                    vec![0.0, 0.0, 1.0],
                    vec![1.0, 0.0, 1.0],
                    vec![0.0, 0.0, 1.0],
                ],
                vec![],
            ]]),
            Geom::Polygon(vec![]),
            Geom::MultiLineString(vec![vec![vec![1.0, 2.0, 3.0]]]),
        ]);
        let bytes = feature_bytes(Some(&g), &[0, 0, 2, 0, 0, 0, b'h', b'i'], true);
        let f = Flat { b: &bytes[4..] };
        let root = f.u32(0).ok().unwrap() as usize;
        let at = f.field(root, 0).ok().flatten().unwrap();
        let mut bounds = None;
        let read = read_geometry(&f, f.indirect(at).ok().unwrap(), 0, true, &mut bounds)
            .ok()
            .unwrap();
        assert_eq!(read, form(&g));
        assert_eq!(bounds, Some([0.0, 0.0, 7.0, 8.0]));
        let (start, n) = f.vector(root, 1).ok().flatten().unwrap();
        let props = read_properties(&bytes[4 + start..4 + start + n], &[("a".into(), STRING)])
            .ok()
            .unwrap();
        assert!(matches!(&props[0], Some(Prop::Text(t)) if t == "hi"));
    }

    #[test]
    fn sizes_a_packed_r_tree_and_records_epsg_codes() {
        assert_eq!(index_size(179, 16), (179 + 12 + 1) * 40);
        assert_eq!(index_size(5, 0), 0);
        assert_eq!(fgb_crs("OGC:CRS84"), Some((4326, Some("WGS 84".into()))));
        assert_eq!(fgb_crs("EPSG:27700").map(|c| c.0), Some(27700));
        assert_eq!(fgb_crs("ESRI:102001"), None);
        assert_eq!(fgb_crs("EPSG:0"), None);
    }
}
