//! The Shapefile export profile (FR-EXP-04), as the TypeScript export/shapefile.ts plans it,
//! shapefile-writer.ts writes it and readback.ts with shapefile-reader.ts reads it back: the same
//! rules, the same bytes and the same checks. Rows are read from the output view in batches and
//! the files are written as they are read, so a large dataset is never held in memory; the .shp
//! and .shx headers, which state the bounds of every shape, are written last.

use crate::digest::{Cell, ColumnDigest, cell_at};
use crate::error::{EngineError, Result};
use crate::export::{
    Expected, OutColumn, Spatial, check, csv_bytes, header_check, retype_text, rows_check,
    values_check,
};
use crate::import::quote_ident;
use crate::json::{J, parse};
use crate::parse::Kind;
use crate::stream::each_batch;
use duckdb::Connection;
use serde_json::{Value, json};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const NULL_SHAPE: i32 = 0;
const POINT: i32 = 1;
const POLYLINE: i32 = 3;
const POLYGON: i32 = 5;
const MULTIPOINT: i32 = 8;
const POINT_Z: i32 = 11;
const POLYLINE_Z: i32 = 13;
const POLYGON_Z: i32 = 15;
const MULTIPOINT_Z: i32 = 18;

/// The largest file the format can address: offsets are 32-bit counts of 16-bit words.
pub const SHAPEFILE_MAX_BYTES: u64 = (1 << 31) - 1;
/// A .dbf character field holds at most 254 bytes.
const DBF_TEXT_MAX: usize = 254;
/// "No data" for a measure: any value below -10^38.
const NO_MEASURE: f64 = -1e39;

/// The companion files of data.shp, in the order the package lists them.
pub const COMPANIONS: [&str; 5] = [
    "data.shx",
    "data.dbf",
    "data.prj",
    "data.cpg",
    "data.fields.csv",
];

/// Where the shapes come from (shapeSource): the geometry column, or the coordinate pair of the
/// CRS's kind, as places among the output columns.
#[derive(Clone, Copy, Debug)]
pub enum ShapeSource {
    Geometry(usize),
    Pair(usize, usize),
}

pub(crate) fn known_crs(spatial: &Spatial) -> Option<&str> {
    spatial.crs.as_deref().filter(|c| *c != "unknown")
}

pub fn shape_source(columns: &[OutColumn], spatial: &Spatial) -> Option<ShapeSource> {
    if let Some(j) = spatial
        .geometry_column
        .as_deref()
        .and_then(|g| columns.iter().position(|c| c.id == g))
    {
        return Some(ShapeSource::Geometry(j));
    }
    let geographic = known_crs(spatial)
        .is_none_or(|c| crate::geodesy::crs_definition(c).is_none_or(|d| d.geographic));
    let numeric = |role: &str| {
        columns
            .iter()
            .position(|c| c.role == role && (c.typ == "number" || c.typ == "integer"))
    };
    let x = numeric(if geographic { "longitude" } else { "easting" })?;
    let y = numeric(if geographic { "latitude" } else { "northing" })?;
    Some(ShapeSource::Pair(x, y))
}

// ---------------------------------------------------------------------------------------------
// Geometries

pub(crate) type Pos = Vec<f64>;

/// A geometry of a valid shape, as GeoJSON types it.
pub(crate) enum Geom {
    Point(Pos),
    MultiPoint(Vec<Pos>),
    LineString(Vec<Pos>),
    MultiLineString(Vec<Vec<Pos>>),
    Polygon(Vec<Vec<Pos>>),
    MultiPolygon(Vec<Vec<Vec<Pos>>>),
    Collection(Vec<Geom>),
}

fn member<'a>(g: &'a J, key: &str) -> Option<&'a J> {
    match g {
        J::Obj(m) => m.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn pos(j: &J) -> Pos {
    match j {
        J::Arr(items) => items
            .iter()
            .map(|x| if let J::Num(n) = x { *n } else { 0.0 })
            .collect(),
        _ => Vec::new(),
    }
}

fn list<T>(j: &J, f: impl Fn(&J) -> T) -> Vec<T> {
    match j {
        J::Arr(items) => items.iter().map(f).collect(),
        _ => Vec::new(),
    }
}

/// The geometry of a value already known to have a valid shape (has_shape).
fn geom_of(g: &J) -> Option<Geom> {
    let c = || member(g, "coordinates");
    Some(match member(g, "type")? {
        J::Str(t) => match t.as_str() {
            "Point" => Geom::Point(pos(c()?)),
            "MultiPoint" => Geom::MultiPoint(list(c()?, pos)),
            "LineString" => Geom::LineString(list(c()?, pos)),
            "MultiLineString" => Geom::MultiLineString(list(c()?, |l| list(l, pos))),
            "Polygon" => Geom::Polygon(list(c()?, |r| list(r, pos))),
            "MultiPolygon" => Geom::MultiPolygon(list(c()?, |p| list(p, |r| list(r, pos)))),
            "GeometryCollection" => Geom::Collection(
                list(member(g, "geometries")?, geom_of)
                    .into_iter()
                    .flatten()
                    .collect(),
            ),
            _ => return None,
        },
        _ => return None,
    })
}

pub(crate) fn each_position(g: &Geom, visit: &mut dyn FnMut(&Pos)) {
    match g {
        Geom::Point(p) => visit(p),
        Geom::MultiPoint(ps) | Geom::LineString(ps) => ps.iter().for_each(visit),
        Geom::MultiLineString(ls) | Geom::Polygon(ls) => ls.iter().flatten().for_each(visit),
        Geom::MultiPolygon(ps) => ps.iter().flatten().flatten().for_each(visit),
        Geom::Collection(gs) => gs.iter().for_each(|m| each_position(m, visit)),
    }
}

/// A row's geometry from the cells of its source columns, and whether a value had no valid shape.
pub(crate) fn row_geometry(cells: &[Cell]) -> (Option<Geom>, bool) {
    match cells {
        [Cell::Geometry(text)] => match parse(text) {
            Ok(g) if crate::geo::has_shape(&g) => match geom_of(&g) {
                Some(geom) => (Some(geom), false),
                None => (None, true),
            },
            _ => (None, true),
        },
        [Cell::Null] => (None, false),
        [_] => (None, true),
        [Cell::Num(x), Cell::Num(y)] => (Some(Geom::Point(vec![*x, *y])), false),
        _ => (None, false),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Family {
    Point,
    MultiPoint,
    Line,
    Polygon,
    Collection,
}

fn family_of(g: &Geom) -> Family {
    match g {
        Geom::Point(_) => Family::Point,
        Geom::MultiPoint(_) => Family::MultiPoint,
        Geom::LineString(_) | Geom::MultiLineString(_) => Family::Line,
        Geom::Polygon(_) | Geom::MultiPolygon(_) => Family::Polygon,
        Geom::Collection(_) => Family::Collection,
    }
}

fn family_name(f: Family) -> &'static str {
    match f {
        Family::Point | Family::MultiPoint => "points",
        Family::Line => "lines",
        Family::Polygon => "polygons",
        Family::Collection => "geometry collections",
    }
}

/// What the shapes of the rows make (analyseShapes).
#[derive(Clone, Copy)]
pub struct Analysis {
    shape_type: i32,
    z: bool,
    bad: u64,
}

struct Survey {
    families: Vec<Family>,
    dims: Vec<usize>,
    bad: u64,
}

impl Survey {
    fn add(&mut self, cells: &[Cell]) {
        let (g, bad) = row_geometry(cells);
        if bad {
            self.bad += 1;
        }
        let Some(g) = g else { return };
        let f = family_of(&g);
        if !self.families.contains(&f) {
            self.families.push(f);
        }
        each_position(&g, &mut |p| {
            if !self.dims.contains(&p.len()) {
                self.dims.push(p.len());
            }
        });
    }

    fn finish(self) -> std::result::Result<Analysis, String> {
        let mut kinds: Vec<&str> = Vec::new();
        for f in &self.families {
            let name = family_name(*f);
            if !kinds.contains(&name) {
                kinds.push(name);
            }
        }
        if self.families.contains(&Family::Collection) || kinds.len() > 1 {
            kinds.sort_unstable();
            return Err(format!(
                "A Shapefile holds one kind of geometry, and this dataset has {}.",
                kinds.join(" and ")
            ));
        }
        if self.dims.len() > 1 || self.dims.iter().any(|d| *d > 3) {
            return Err(
                "A Shapefile holds geometries all with heights or all without, and this dataset has both."
                    .into(),
            );
        }
        let z = self.dims == [3];
        let base = if self.families.contains(&Family::MultiPoint) {
            MULTIPOINT
        } else {
            match self.families.first() {
                Some(Family::Line) => POLYLINE,
                Some(Family::Polygon) => POLYGON,
                _ => POINT,
            }
        };
        let shape_type = if !z {
            base
        } else {
            match base {
                POINT => POINT_Z,
                MULTIPOINT => MULTIPOINT_Z,
                POLYLINE => POLYLINE_Z,
                _ => POLYGON_Z,
            }
        };
        Ok(Analysis {
            shape_type,
            z,
            bad: self.bad,
        })
    }
}

/// Twice the signed area of a ring (ringArea): negative for clockwise.
fn ring_area(ring: &[Pos]) -> f64 {
    let mut sum = 0.0;
    for w in ring.windows(2) {
        sum += w[0][0] * w[1][1] - w[1][0] * w[0][1];
    }
    sum
}

fn oriented(mut ring: Vec<Pos>, clockwise: bool) -> Vec<Pos> {
    let area = ring_area(&ring);
    if (clockwise && area > 0.0) || (!clockwise && area < 0.0) {
        ring.reverse();
    }
    ring
}

/// A record's parts (shapeRecord), or None for a null shape.
fn shape_record(g: Option<Geom>, shape_type: i32, z: bool) -> Option<Vec<Vec<Pos>>> {
    let trim = |p: &Pos| -> Pos { p[..if z { 3 } else { 2 }].to_vec() };
    let rings = |rs: &[Vec<Pos>]| -> Vec<Vec<Pos>> {
        rs.iter()
            .enumerate()
            .map(|(i, r)| oriented(r.iter().map(trim).collect(), i == 0))
            .collect()
    };
    let mut parts: Vec<Vec<Pos>> = match g? {
        Geom::Point(p) => vec![vec![trim(&p)]],
        Geom::MultiPoint(ps) | Geom::LineString(ps) => vec![ps.iter().map(trim).collect()],
        Geom::MultiLineString(ls) => ls.iter().map(|l| l.iter().map(trim).collect()).collect(),
        Geom::Polygon(rs) => rings(&rs),
        Geom::MultiPolygon(ps) => ps.iter().flat_map(|rs| rings(rs)).collect(),
        Geom::Collection(_) => return None,
    };
    if shape_type == MULTIPOINT || shape_type == MULTIPOINT_Z {
        parts = vec![parts.into_iter().flatten().collect()];
    }
    parts.retain(|p| !p.is_empty());
    (!parts.is_empty()).then_some(parts)
}

fn coords(p: &[Pos]) -> Value {
    json!(p)
}

/// The GeoJSON geometry a reader makes of a record (geometryOfRecord), as a digest cell.
fn geometry_cell(parts: Option<&Vec<Vec<Pos>>>, shape_type: i32) -> Cell {
    let Some(parts) = parts else {
        return Cell::Null;
    };
    let g = match shape_type {
        POINT | POINT_Z => json!({ "type": "Point", "coordinates": parts[0][0] }),
        MULTIPOINT | MULTIPOINT_Z => {
            json!({ "type": "MultiPoint", "coordinates": coords(&parts[0]) })
        }
        POLYLINE | POLYLINE_Z if parts.len() == 1 => {
            json!({ "type": "LineString", "coordinates": coords(&parts[0]) })
        }
        POLYLINE | POLYLINE_Z => json!({ "type": "MultiLineString", "coordinates": parts }),
        _ => {
            let mut polygons: Vec<Vec<&Vec<Pos>>> = Vec::new();
            for ring in parts {
                // A clockwise ring starts a polygon; any other is a hole of the one before it.
                match polygons.last_mut() {
                    Some(current) if ring_area(ring) >= 0.0 => current.push(ring),
                    _ => polygons.push(vec![ring]),
                }
            }
            if polygons.len() == 1 {
                json!({ "type": "Polygon", "coordinates": polygons[0] })
            } else {
                json!({ "type": "MultiPolygon", "coordinates": polygons })
            }
        }
    };
    Cell::Geometry(g.to_string())
}

/// Math.min and Math.max as JavaScript has them: -0 is below +0.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// [xmin, ymin, xmax, ymax], folded from the first point as the TypeScript writer folds it.
fn box_of<'a>(points: impl Iterator<Item = &'a Pos>) -> [f64; 4] {
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for p in points {
        b = [
            js_min(b[0], p[0]),
            js_min(b[1], p[1]),
            js_max(b[2], p[0]),
            js_max(b[3], p[1]),
        ];
    }
    b
}

fn z_range<'a>(points: impl Iterator<Item = &'a Pos>) -> [f64; 2] {
    let mut r = [f64::INFINITY, f64::NEG_INFINITY];
    for p in points {
        r = [js_min(r[0], p[2]), js_max(r[1], p[2])];
    }
    r
}

fn content_bytes(parts: Option<&Vec<Vec<Pos>>>, shape_type: i32) -> u64 {
    let Some(parts) = parts else { return 4 };
    let points = parts.iter().map(Vec::len).sum::<usize>() as u64;
    let n = parts.len() as u64;
    match shape_type {
        POINT => 20,
        POINT_Z => 36,
        MULTIPOINT => 40 + 16 * points,
        MULTIPOINT_Z => 40 + 16 * points + 16 + 8 * points,
        POLYLINE | POLYGON => 44 + 4 * n + 16 * points,
        _ => 44 + 4 * n + 16 * points + 16 + 8 * points,
    }
}

// ---------------------------------------------------------------------------------------------
// Attribute fields

/// A .dbf field: its name and how its column's values are written.
#[derive(Clone)]
struct DbfField {
    name: String,
    /// The column's place among the output columns.
    column: usize,
    typ: u8,
    width: usize,
    decimals: u8,
}

/// The text a .dbf field holds for a value (dbfText), or None for no value.
fn dbf_text(cell: Cell, column: &OutColumn) -> Option<String> {
    let cell = cell.exportable();
    if cell == Cell::Null {
        return None;
    }
    Some(match (column.typ.as_str(), &cell) {
        ("boolean", Cell::Bool(b)) => if *b { "T" } else { "F" }.into(),
        ("boolean", _) => "F".into(),
        ("date", Cell::Date(_)) => cell.text().replace('-', ""),
        _ => cell.text(),
    })
}

/// Whether a value's text fits its field exactly (fits).
fn fits(text: &str, column: &OutColumn) -> bool {
    match column.typ.as_str() {
        "integer" => text.encode_utf16().count() <= 18,
        "number" => text.encode_utf16().count() <= 24,
        "date" => text.len() == 8 && text.bytes().all(|b| b.is_ascii_digit()),
        "boolean" => true,
        _ => {
            text.len() <= DBF_TEXT_MAX
                && !text.starts_with(' ')
                && !text.ends_with(' ')
                && !text.contains('\0')
        }
    }
}

/// Field names of at most 10 characters, unique whatever their case (fieldNames).
fn field_names(names: &[&str]) -> Vec<String> {
    let mut taken: Vec<String> = Vec::new();
    names
        .iter()
        .map(|name| {
            let mut base: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            if !base.starts_with(|c: char| c.is_ascii_alphabetic()) {
                base = format!("F{base}");
            }
            base.truncate(10);
            let mut candidate = base.clone();
            let mut n = 1;
            while taken.contains(&candidate.to_ascii_uppercase()) {
                let suffix = format!("_{n}");
                candidate = format!("{}{suffix}", &base[..base.len().min(10 - suffix.len())]);
                n += 1;
            }
            taken.push(candidate.to_ascii_uppercase());
            candidate
        })
        .collect()
}

fn order_by(ordered: bool) -> &'static str {
    if ordered { " ORDER BY __rid" } else { "" }
}

/// Reads the rows of the given columns in row order, each as cells.
pub(crate) fn each_row(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    picked: &[usize],
    ordered: bool,
    f: &mut dyn FnMut(&[Cell]) -> Result<()>,
) -> Result<()> {
    if picked.is_empty() {
        let n: i64 = conn.query_row(&format!("SELECT count(*) FROM {view}"), [], |r| r.get(0))?;
        for _ in 0..n {
            f(&[])?;
        }
        return Ok(());
    }
    let select: Vec<String> = picked
        .iter()
        .map(|&j| quote_ident(&columns[j].id))
        .collect();
    let sql = format!(
        "SELECT {} FROM {view}{}",
        select.join(", "),
        order_by(ordered)
    );
    let kinds: Vec<Kind> = picked.iter().map(|&j| columns[j].kind).collect();
    let mut cells = vec![Cell::Null; picked.len()];
    each_batch(conn, &sql, |batch| {
        for i in 0..batch.num_rows() {
            for (k, kind) in kinds.iter().enumerate() {
                cells[k] = cell_at(batch.column(k), i, *kind);
            }
            f(&cells)?;
        }
        Ok(())
    })
}

pub(crate) fn source_columns(source: ShapeSource) -> Vec<usize> {
    match source {
        ShapeSource::Geometry(j) => vec![j],
        ShapeSource::Pair(x, y) => vec![x, y],
    }
}

// ---------------------------------------------------------------------------------------------
// The plan

/// What the Shapefile profile makes of the output view (shapefilePlan).
pub struct ShapePlan {
    pub refusal: Option<(String, String)>,
    pub substitutions: Vec<Value>,
    /// The columns the .dbf holds, and those that go to data-long-text.csv.
    pub dbf_columns: Vec<usize>,
    pub unfit: Vec<usize>,
    /// When the Shapefile would pass its 2 GB limit: the columns of the FlatGeobuf file that
    /// replaces it (FR-EXP-03).
    pub flatgeobuf: Option<Vec<usize>>,
}

fn refused(reason: String, fix: &str) -> ShapePlan {
    ShapePlan {
        refusal: Some((reason, fix.into())),
        substitutions: Vec::new(),
        dbf_columns: Vec::new(),
        unfit: Vec::new(),
        flatgeobuf: None,
    }
}

/// Reads the source and attribute columns once: the shapes' survey, the attribute texts that
/// do not fit, and the widest text of each character field.
fn survey(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    source: ShapeSource,
    attributes: &[usize],
) -> Result<(Survey, Vec<bool>, Vec<usize>)> {
    let src = source_columns(source);
    let picked: Vec<usize> = src.iter().chain(attributes).copied().collect();
    let mut s = Survey {
        families: Vec::new(),
        dims: Vec::new(),
        bad: 0,
    };
    let mut unfit = vec![false; attributes.len()];
    let mut widths = vec![1usize; attributes.len()];
    each_row(conn, view, columns, &picked, false, &mut |cells| {
        s.add(&cells[..src.len()]);
        for (k, &j) in attributes.iter().enumerate() {
            if let Some(text) = dbf_text(cells[src.len() + k].clone(), &columns[j]) {
                unfit[k] = unfit[k] || !fits(&text, &columns[j]);
                widths[k] = widths[k].max(text.len());
            }
        }
        Ok(())
    })?;
    Ok((s, unfit, widths))
}

fn fields_of(columns: &[OutColumn], dbf_columns: &[usize], widths: &[usize]) -> Vec<DbfField> {
    let names = field_names(
        &dbf_columns
            .iter()
            .map(|&j| columns[j].name.as_str())
            .collect::<Vec<_>>(),
    );
    dbf_columns
        .iter()
        .zip(names)
        .zip(widths)
        .map(|((&j, name), &width)| {
            let (typ, width, decimals) = match columns[j].typ.as_str() {
                "integer" => (b'N', 18, 0),
                "number" => (b'N', 24, 15),
                "boolean" => (b'L', 1, 0),
                "date" => (b'D', 8, 0),
                _ => (b'C', width, 0),
            };
            DbfField {
                name,
                column: j,
                typ,
                width,
                decimals,
            }
        })
        .collect()
}

pub fn plan(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    rows: u64,
    spatial: &Spatial,
    max_bytes: u64,
) -> Result<ShapePlan> {
    let Some(source) = shape_source(columns, spatial) else {
        return Ok(refused(
            "The dataset has no geometry column and no coordinate columns (longitude and latitude, or easting and northing).".into(),
            "Set the coordinate roles on the coordinate columns, or export as CSV or Excel.",
        ));
    };
    let Some(code) = known_crs(spatial) else {
        return Ok(refused(
            "The coordinate reference system of the data is not known, and a Shapefile records it in its .prj file.".into(),
            "Set the coordinate reference system of the dataset first.",
        ));
    };
    if crate::geodesy::esri_wkt(code).is_none() {
        return Ok(refused(
            format!(
                "A Shapefile records its coordinate reference system in its .prj file, and {code} is not one this edition can describe."
            ),
            "Transform the coordinates to a listed coordinate reference system first (Data › Transform coordinates).",
        ));
    }
    let attributes: Vec<usize> = (0..columns.len())
        .filter(|j| !matches!(source, ShapeSource::Geometry(g) if g == *j))
        .collect();
    let (survey, unfit_flags, widths) = survey(conn, view, columns, source, &attributes)?;
    let shapes = match survey.finish() {
        Ok(a) => a,
        Err(problem) => {
            return Ok(refused(
                problem,
                "Filter the rows to one kind of geometry, or export as FlatGeobuf or GeoJSON, which hold any mix.",
            ));
        }
    };
    let unfit: Vec<usize> = attributes
        .iter()
        .zip(&unfit_flags)
        .filter(|(_, u)| **u)
        .map(|(j, _)| *j)
        .collect();
    let (dbf_columns, dbf_widths): (Vec<usize>, Vec<usize>) = attributes
        .iter()
        .zip(&widths)
        .filter(|(j, _)| !unfit.contains(j))
        .map(|(j, w)| (*j, *w))
        .unzip();
    let fields = fields_of(columns, &dbf_columns, &dbf_widths);
    let record = 1 + fields.iter().map(|f| f.width as u64).sum::<u64>();
    let dbf = 32 + 32 * fields.len() as u64 + 1 + rows * record + 1;
    let mut shp = 100u64;
    each_row(
        conn,
        view,
        columns,
        &source_columns(source),
        false,
        &mut |cells| {
            let rec = shape_record(row_geometry(cells).0, shapes.shape_type, shapes.z);
            shp += 8 + content_bytes(rec.as_ref(), shapes.shape_type);
            Ok(())
        },
    )?;
    let largest = dbf.max(shp);
    if largest > max_bytes {
        // FR-EXP-03: the data goes to FlatGeobuf, which keeps the CRS, every column and any size.
        let fgb = crate::flatgeobuf::plan(conn, view, columns, spatial)?;
        if let Some((reason, fix)) = fgb.refusal {
            return Ok(refused(reason, &fix));
        }
        let mut substitutions = vec![json!({
            "ruleId": "TW-EXP-002",
            "what": "the Shapefile",
            "why": format!("It would hold a file of {largest} bytes, more than the 2 GB its format can address."),
            "instead": "The data is delivered as data.fgb, a FlatGeobuf file in the same coordinate reference system with every column under its full name, which QGIS, ArcGIS Pro and GDAL open.",
        })];
        substitutions.extend(fgb.substitutions);
        return Ok(ShapePlan {
            refusal: None,
            substitutions,
            dbf_columns: Vec::new(),
            unfit: Vec::new(),
            flatgeobuf: Some(fgb.attributes),
        });
    }
    let mut substitutions = Vec::new();
    if !unfit.is_empty() {
        let names: Vec<&str> = unfit.iter().map(|&j| columns[j].name.as_str()).collect();
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": format!("the column{} {}", if unfit.len() > 1 { "s" } else { "" }, names.join(", ")),
            "why": "Some values do not fit a .dbf field exactly: text longer than 254 bytes or starting or ending with spaces, which readers remove, or numbers too long for the field.",
            "instead": "These columns are delivered in data-long-text.csv in the package, row for row with the Shapefile.",
        }));
    }
    if shapes.bad > 0 {
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": format!("{} geometr{}", shapes.bad, if shapes.bad > 1 { "ies" } else { "y" }),
            "why": "They do not have the shape of a geometry: a misplaced array or an unknown type.",
            "instead": "Their rows have no shape in the Shapefile; their other values are kept.",
        }));
    }
    Ok(ShapePlan {
        refusal: None,
        substitutions,
        dbf_columns,
        unfit,
        flatgeobuf: None,
    })
}

/// The shapes' analysis and the fields, again, for writing and reading back: the plan accepted them.
fn prepare(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    dbf_columns: &[usize],
) -> Result<(ShapeSource, Analysis, Vec<DbfField>)> {
    let source = shape_source(columns, spatial)
        .ok_or_else(|| EngineError::internal("The Shapefile has no shapes to write."))?;
    let (survey, _, widths) = survey(conn, view, columns, source, dbf_columns)?;
    let shapes = survey
        .finish()
        .map_err(|why| EngineError::new("EXPORT_REFUSED", why, "Export as GeoJSON."))?;
    Ok((source, shapes, fields_of(columns, dbf_columns, &widths)))
}

// ---------------------------------------------------------------------------------------------
// The writer (shapefile-writer.ts)

fn write_content(out: &mut Vec<u8>, parts: Option<&Vec<Vec<Pos>>>, shape_type: i32) {
    let Some(parts) = parts else {
        out.extend_from_slice(&NULL_SHAPE.to_le_bytes());
        return;
    };
    out.extend_from_slice(&shape_type.to_le_bytes());
    let f64le = |out: &mut Vec<u8>, x: f64| out.extend_from_slice(&x.to_le_bytes());
    if shape_type == POINT || shape_type == POINT_Z {
        let p = &parts[0][0];
        f64le(out, p[0]);
        f64le(out, p[1]);
        if shape_type == POINT_Z {
            f64le(out, p[2]);
            f64le(out, NO_MEASURE);
        }
        return;
    }
    for v in box_of(parts.iter().flatten()) {
        f64le(out, v);
    }
    let multipoint = shape_type == MULTIPOINT || shape_type == MULTIPOINT_Z;
    let count: usize = parts.iter().map(Vec::len).sum();
    if !multipoint {
        out.extend_from_slice(&(parts.len() as i32).to_le_bytes());
    }
    out.extend_from_slice(&(count as i32).to_le_bytes());
    if !multipoint {
        let mut start = 0i32;
        for part in parts {
            out.extend_from_slice(&start.to_le_bytes());
            start += part.len() as i32;
        }
    }
    for p in parts.iter().flatten() {
        f64le(out, p[0]);
        f64le(out, p[1]);
    }
    if matches!(shape_type, MULTIPOINT_Z | POLYLINE_Z | POLYGON_Z) {
        for v in z_range(parts.iter().flatten()) {
            f64le(out, v);
        }
        for p in parts.iter().flatten() {
            f64le(out, p[2]);
        }
    }
}

fn main_header(words: u64, shape_type: i32, b: Option<[f64; 4]>, z: Option<[f64; 2]>) -> Vec<u8> {
    let mut out = Vec::with_capacity(100);
    out.extend_from_slice(&9994i32.to_be_bytes());
    out.extend_from_slice(&[0u8; 20]);
    out.extend_from_slice(&(words as i32).to_be_bytes());
    out.extend_from_slice(&1000i32.to_le_bytes());
    out.extend_from_slice(&shape_type.to_le_bytes());
    for v in b.unwrap_or([0.0; 4]) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in z.unwrap_or([0.0; 2]) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&[0u8; 16]);
    out
}

fn padded(text: &str, width: usize, right: bool) -> Vec<u8> {
    let bytes = text.as_bytes();
    let n = bytes.len().min(width);
    let mut out = vec![b' '; width];
    let at = if right { width - n } else { 0 };
    out[at..at + n].copy_from_slice(&bytes[..n]);
    out
}

fn dbf_header(fields: &[DbfField], rows: u64, at: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let part =
        |r: std::ops::Range<usize>| at.get(r).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    out.push(0x03);
    out.push((part(0..4).saturating_sub(1900)) as u8);
    out.push(part(5..7) as u8);
    out.push(part(8..10) as u8);
    out.extend_from_slice(&(rows as u32).to_le_bytes());
    out.extend_from_slice(&((32 + 32 * fields.len() + 1) as u16).to_le_bytes());
    let record = 1 + fields.iter().map(|f| f.width).sum::<usize>();
    out.extend_from_slice(&(record as u16).to_le_bytes());
    out.extend_from_slice(&[0u8; 20]);
    for f in fields {
        let mut name = [0u8; 11];
        name[..f.name.len()].copy_from_slice(f.name.as_bytes());
        out.extend_from_slice(&name);
        out.extend_from_slice(&[f.typ, 0, 0, 0, 0, f.width as u8, f.decimals]);
        out.extend_from_slice(&[0u8; 14]);
    }
    out.push(0x0d);
    out
}

/// Writes data.shp, data.shx, data.dbf, data.prj, data.cpg and data.fields.csv into `dir`.
#[allow(clippy::too_many_arguments)]
pub fn write(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    dbf_columns: &[usize],
    rows: u64,
    ordered: bool,
    at: &str,
    dir: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let (source, shapes, fields) = prepare(conn, view, columns, spatial, dbf_columns)?;
    let mut shp = BufWriter::with_capacity(1 << 20, File::create(dir.join("data.shp"))?);
    let mut shx = BufWriter::with_capacity(1 << 16, File::create(dir.join("data.shx"))?);
    let mut dbf = BufWriter::with_capacity(1 << 20, File::create(dir.join("data.dbf"))?);
    shp.write_all(&[0u8; 100])?;
    shx.write_all(&[0u8; 100])?;
    dbf.write_all(&dbf_header(&fields, rows, at))?;
    let src = source_columns(source);
    let picked: Vec<usize> = src.iter().chain(dbf_columns).copied().collect();
    let mut offset = 100u64;
    let mut number = 0i32;
    let mut all: Option<[f64; 4]> = None;
    let mut heights: Option<[f64; 2]> = None;
    let mut content = Vec::new();
    let mut record = Vec::new();
    each_row(conn, view, columns, &picked, ordered, &mut |cells| {
        if number % 4096 == 0 && cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The export was cancelled.",
                "Start the export again when you are ready.",
            ));
        }
        let parts = shape_record(
            row_geometry(&cells[..src.len()]).0,
            shapes.shape_type,
            shapes.z,
        );
        if let Some(p) = &parts {
            let own = box_of(p.iter().flatten());
            all = Some(match all {
                None => own,
                Some(a) => [
                    js_min(a[0], own[0]),
                    js_min(a[1], own[1]),
                    js_max(a[2], own[2]),
                    js_max(a[3], own[3]),
                ],
            });
            if shapes.z {
                let own = z_range(p.iter().flatten());
                heights = Some(match heights {
                    None => own,
                    Some(h) => [js_min(h[0], own[0]), js_max(h[1], own[1])],
                });
            }
        }
        content.clear();
        write_content(&mut content, parts.as_ref(), shapes.shape_type);
        number += 1;
        let words = (content.len() / 2) as i32;
        shx.write_all(&((offset / 2) as i32).to_be_bytes())?;
        shx.write_all(&words.to_be_bytes())?;
        shp.write_all(&number.to_be_bytes())?;
        shp.write_all(&words.to_be_bytes())?;
        shp.write_all(&content)?;
        offset += 8 + content.len() as u64;
        record.clear();
        record.push(b' ');
        for (k, f) in fields.iter().enumerate() {
            let text = dbf_text(cells[src.len() + k].clone(), &columns[f.column]);
            if f.typ == b'L' {
                record.extend_from_slice(text.as_deref().unwrap_or("?").as_bytes());
            } else {
                record.extend_from_slice(&padded(
                    text.as_deref().unwrap_or(""),
                    f.width,
                    f.typ == b'N',
                ));
            }
        }
        dbf.write_all(&record)?;
        Ok(())
    })?;
    dbf.write_all(&[0x1a])?;
    dbf.flush()?;
    // The headers state the bounds of every shape, known only now.
    let z = if shapes.z { heights } else { None };
    shp.seek(SeekFrom::Start(0))?;
    shp.write_all(&main_header(offset / 2, shapes.shape_type, all, z))?;
    shp.flush()?;
    shx.seek(SeekFrom::Start(0))?;
    shx.write_all(&main_header(
        (100 + 8 * number as u64) / 2,
        shapes.shape_type,
        all,
        z,
    ))?;
    shx.flush()?;
    let code = known_crs(spatial).unwrap_or_default();
    std::fs::write(
        dir.join("data.prj"),
        crate::geodesy::esri_wkt(code).unwrap_or_default(),
    )?;
    std::fs::write(dir.join("data.cpg"), "UTF-8")?;
    let list: Vec<Vec<String>> = fields
        .iter()
        .map(|f| {
            let c = &columns[f.column];
            vec![
                f.name.clone(),
                c.name.clone(),
                c.unit.clone().unwrap_or_default(),
                c.typ.clone(),
            ]
        })
        .collect();
    let head: Vec<String> = ["field", "name", "unit", "type"].map(String::from).to_vec();
    std::fs::write(dir.join("data.fields.csv"), csv_bytes(&head, &list))?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The reader and the read-back (shapefile-reader.ts, readback.ts readShapefile)

fn format_error(message: impl Into<String>) -> EngineError {
    EngineError::new("FORMAT", message, "")
}

struct Reader {
    inner: BufReader<File>,
    at: u64,
    len: u64,
}

impl Reader {
    fn open(path: &Path) -> Result<Reader> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(Reader {
            inner: BufReader::with_capacity(1 << 20, file),
            at: 0,
            len,
        })
    }

    fn bytes(&mut self, n: usize) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; n];
        self.inner.read_exact(&mut buf)?;
        self.at += n as u64;
        Ok(buf)
    }
}

struct MainHeader {
    code: i32,
    words: i64,
    version: i32,
    shape_type: i32,
    bbox: [f64; 4],
    z: [f64; 2],
}

fn read_main_header(r: &mut Reader) -> Result<MainHeader> {
    if r.len < 100 {
        return Err(format_error("it is shorter than its 100-byte header"));
    }
    let h = r.bytes(100)?;
    let be = |o: usize| i32::from_be_bytes(h[o..o + 4].try_into().unwrap_or_default());
    let le = |o: usize| i32::from_le_bytes(h[o..o + 4].try_into().unwrap_or_default());
    let f = |o: usize| f64::from_le_bytes(h[o..o + 8].try_into().unwrap_or_default());
    Ok(MainHeader {
        code: be(0),
        words: be(24) as i64,
        version: le(28),
        shape_type: le(32),
        bbox: [f(36), f(44), f(52), f(60)],
        z: [f(68), f(76)],
    })
}

struct ShpRecord {
    number: i32,
    offset: i64,
    words: i64,
    shape_type: i32,
    parts: Option<Vec<Vec<Pos>>>,
    bbox: Option<[f64; 4]>,
}

fn read_record(r: &mut Reader) -> Result<ShpRecord> {
    let start = r.at;
    if start + 8 > r.len {
        return Err(format_error(format!(
            "a record header at byte {start} is cut off"
        )));
    }
    let h = r.bytes(8)?;
    let number = i32::from_be_bytes(h[0..4].try_into().unwrap_or_default());
    let words = i32::from_be_bytes(h[4..8].try_into().unwrap_or_default()) as i64;
    if words < 2 || start + 8 + words as u64 * 2 > r.len {
        return Err(format_error(format!(
            "a record at byte {start} runs past the end of the file"
        )));
    }
    let c = r.bytes(words as usize * 2)?;
    let short = || {
        format_error(format!(
            "a record at byte {start} is shorter than its shape needs"
        ))
    };
    let f64_at = |o: usize| -> Result<f64> {
        c.get(o..o + 8)
            .map(|b| f64::from_le_bytes(b.try_into().unwrap_or_default()))
            .ok_or_else(short)
    };
    let i32_at = |o: usize| -> Result<i32> {
        c.get(o..o + 4)
            .map(|b| i32::from_le_bytes(b.try_into().unwrap_or_default()))
            .ok_or_else(short)
    };
    let typ = i32_at(0)?;
    let base = ShpRecord {
        number,
        offset: start as i64 / 2,
        words,
        shape_type: typ,
        parts: None,
        bbox: None,
    };
    if typ == NULL_SHAPE {
        return Ok(base);
    }
    if typ == POINT || typ == POINT_Z {
        let mut p = vec![f64_at(4)?, f64_at(12)?];
        if typ == POINT_Z {
            p.push(f64_at(20)?);
        }
        return Ok(ShpRecord {
            parts: Some(vec![vec![p]]),
            ..base
        });
    }
    if ![
        POLYLINE,
        POLYGON,
        MULTIPOINT,
        POLYLINE_Z,
        POLYGON_Z,
        MULTIPOINT_Z,
    ]
    .contains(&typ)
    {
        return Err(format_error(format!(
            "a record has shape type {typ}, which this reader does not know"
        )));
    }
    let bbox = [f64_at(4)?, f64_at(12)?, f64_at(20)?, f64_at(28)?];
    let multipoint = typ == MULTIPOINT || typ == MULTIPOINT_Z;
    let has_z = matches!(typ, POLYLINE_Z | POLYGON_Z | MULTIPOINT_Z);
    let num_parts = if multipoint { 1 } else { i32_at(36)? };
    let num_points = i32_at(if multipoint { 36 } else { 40 })?;
    if num_parts < 0 || num_points < 0 {
        return Err(format_error("a record has a negative count"));
    }
    let parts_at = if multipoint { 40 } else { 44 };
    let starts: Vec<i32> = if multipoint {
        vec![0]
    } else {
        (0..num_parts as usize)
            .map(|i| i32_at(parts_at + 4 * i))
            .collect::<Result<_>>()?
    };
    let points_at = parts_at
        + if multipoint {
            0
        } else {
            4 * num_parts as usize
        };
    let mut xy: Vec<Pos> = (0..num_points as usize)
        .map(|i| {
            Ok(vec![
                f64_at(points_at + 16 * i)?,
                f64_at(points_at + 16 * i + 8)?,
            ])
        })
        .collect::<Result<_>>()?;
    if has_z {
        let z_at = points_at + 16 * num_points as usize;
        f64_at(z_at)?;
        f64_at(z_at + 8)?;
        for (i, p) in xy.iter_mut().enumerate() {
            p.push(f64_at(z_at + 16 + 8 * i)?);
        }
    }
    let mut parts = Vec::with_capacity(starts.len());
    for (i, &s) in starts.iter().enumerate() {
        let e = starts.get(i + 1).copied().unwrap_or(num_points);
        if s < 0 || e < s || e > num_points {
            return Err(format_error(
                "a record has parts that do not divide its points",
            ));
        }
        parts.push(xy[s as usize..e as usize].to_vec());
    }
    Ok(ShpRecord {
        parts: Some(parts),
        bbox: Some(bbox),
        ..base
    })
}

struct DbfField2 {
    name: String,
    typ: char,
    width: usize,
}

/// A .dbf with its header read; the records follow at the reader's position.
struct DbfReader {
    r: Reader,
    records: u64,
    fields: Vec<DbfField2>,
}

fn read_dbf_header(path: &Path) -> Result<DbfReader> {
    let mut r = Reader::open(path)?;
    if r.len < 33 {
        return Err(format_error("it is shorter than a dBASE header"));
    }
    let h = r.bytes(32)?;
    let records = u32::from_le_bytes(h[4..8].try_into().unwrap_or_default()) as u64;
    let header_length = u16::from_le_bytes(h[8..10].try_into().unwrap_or_default()) as u64;
    let record_length = u16::from_le_bytes(h[10..12].try_into().unwrap_or_default()) as u64;
    if header_length < 33 || header_length > r.len {
        return Err(format_error(
            "its field list does not end with the 0x0D terminator",
        ));
    }
    let rest = r.bytes(header_length as usize - 32)?;
    let mut fields = Vec::new();
    let mut at = 0;
    while at + 32 < rest.len() && rest[at] != 0x0d {
        let raw = &rest[at..at + 11];
        let end = raw.iter().position(|b| *b == 0).unwrap_or(11);
        fields.push(DbfField2 {
            name: raw[..end].iter().map(|b| *b as char).collect(),
            typ: rest[at + 11] as char,
            width: rest[at + 16] as usize,
        });
        at += 32;
    }
    if rest.last() != Some(&0x0d) {
        return Err(format_error(
            "its field list does not end with the 0x0D terminator",
        ));
    }
    let width = 1 + fields.iter().map(|f| f.width as u64).sum::<u64>();
    if width != record_length {
        return Err(format_error(format!(
            "its fields add up to {width} bytes per record, not the {record_length} it states"
        )));
    }
    if header_length + records * record_length > r.len {
        return Err(format_error(
            "it holds fewer records than its header states",
        ));
    }
    Ok(DbfReader { r, records, fields })
}

/// A .dbf text read back with its column's type (retypeDbf), or None when it does not fit.
fn retype_dbf(text: Option<&str>, kind: Kind) -> Option<Cell> {
    let Some(text) = text else {
        return Some(Cell::Null);
    };
    match kind {
        Kind::Boolean => match text {
            "T" | "t" | "Y" | "y" => Some(Cell::Bool(true)),
            "F" | "f" | "N" | "n" => Some(Cell::Bool(false)),
            "?" => Some(Cell::Null),
            _ => None,
        },
        Kind::Date => (text.len() == 8 && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| Cell::DateText(format!("{}-{}-{}", &text[0..4], &text[4..6], &text[6..8]))),
        other => retype_text(text, other),
    }
}

/// Splits RFC 4180 CSV text into records of fields.
fn csv_records(text: &str) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            ',' => record.push(std::mem::take(&mut field)),
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' => {
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    records
}

fn same_bits(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

/// Reads the Shapefile back (readShapefile): RB-OPEN, RB-SHP-STRUCTURE, RB-HEADER, RB-ROWS,
/// RB-VALUES and RB-SHP-GEOMETRY. `locate` finds each file; `prefix` marks the checks of the
/// files taken back out of the package.
#[allow(clippy::too_many_arguments)]
pub fn read_back(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    expected: &Expected,
    dbf_columns: &[usize],
    ordered: bool,
    locate: &dyn Fn(&str) -> PathBuf,
    prefix: &str,
) -> Result<Vec<Value>> {
    let label = |f: &str| format!("{prefix}{f}");
    let file = label("data.shp");
    let names = [
        "data.shp",
        "data.shx",
        "data.dbf",
        "data.prj",
        "data.cpg",
        "data.fields.csv",
    ];
    let missing: Vec<&str> = names
        .iter()
        .copied()
        .filter(|n| !locate(n).exists())
        .collect();
    if !missing.is_empty() {
        return Ok(vec![check(
            "RB-OPEN",
            false,
            format!(
                "The Shapefile is incomplete: {} missing.",
                missing.join(", ")
            ),
            Some(&file),
        )]);
    }
    let (source, shapes, _) = prepare(conn, view, columns, spatial, dbf_columns)?;
    let code = known_crs(spatial).unwrap_or_default();
    let want_prj = crate::geodesy::esri_wkt(code).unwrap_or_default();

    // The expected geometries, in the form a reader makes of the shapes, row by row.
    let mut want = ColumnDigest::default();
    let mut rows_seen = 0u64;
    each_row(
        conn,
        view,
        columns,
        &source_columns(source),
        ordered,
        &mut |cells| {
            let rec = shape_record(row_geometry(cells).0, shapes.shape_type, shapes.z);
            want.push(&geometry_cell(rec.as_ref(), shapes.shape_type));
            rows_seen += 1;
            Ok(())
        },
    )?;
    let want = want.finish();

    let outcome = (|| -> std::result::Result<Vec<Value>, (String, String)> {
        let at = |w: &'static str| move |e: EngineError| (w.to_string(), e.message);
        let mut shp = Reader::open(&locate("data.shp")).map_err(at("data.shp"))?;
        let shp_head = read_main_header(&mut shp).map_err(at("data.shp"))?;
        let mut shx = Reader::open(&locate("data.shx")).map_err(at("data.shx"))?;
        let shx_head = read_main_header(&mut shx).map_err(at("data.shx"))?;
        if (shx.len - 100) % 8 != 0 {
            return Err((
                "data.shx".into(),
                "its index is not a whole number of 8-byte entries".into(),
            ));
        }
        let mut dbf = read_dbf_header(&locate("data.dbf")).map_err(at("data.dbf"))?;
        let fields_text = std::fs::read(locate("data.fields.csv"))
            .map_err(|e| ("data.fields.csv".to_string(), e.to_string()))?;
        let fields_text = String::from_utf8(fields_text).map_err(|e| {
            (
                "data.fields.csv".to_string(),
                format!("it is not UTF-8: {e}"),
            )
        })?;
        let mapping = csv_records(&fields_text);

        let mut problems: Vec<String> = Vec::new();
        let shape = |n: i32| format!("shape type {n}");
        if shp_head.code != 9994 || shx_head.code != 9994 {
            problems.push("a file code is not 9994".into());
        }
        if shp_head.version != 1000 {
            problems.push(format!("the version is {}, not 1000", shp_head.version));
        }
        if shp_head.words * 2 != shp.len as i64 {
            problems.push("the .shp length in its header is not its size".into());
        }
        if shx_head.words * 2 != shx.len as i64 {
            problems.push("the .shx length in its header is not its size".into());
        }
        if shp_head.shape_type != shapes.shape_type || shx_head.shape_type != shapes.shape_type {
            problems.push(format!(
                "the files are of {}, not {}",
                shape(shp_head.shape_type),
                shape(shapes.shape_type)
            ));
        }
        let entries = (shx.len - 100) / 8;
        let mut got = ColumnDigest::default();
        let mut all: Option<[f64; 4]> = None;
        let mut heights: Option<[f64; 2]> = None;
        let mut records = 0u64;
        while shp.at < shp.len {
            let rec = read_record(&mut shp).map_err(at("data.shp"))?;
            records += 1;
            let i = records;
            if rec.number as u64 != i {
                problems.push(format!("record {i} is numbered {}", rec.number));
            }
            if i <= entries {
                let e = shx.bytes(8).map_err(at("data.shx"))?;
                let offset = i32::from_be_bytes(e[0..4].try_into().unwrap_or_default()) as i64;
                let words = i32::from_be_bytes(e[4..8].try_into().unwrap_or_default()) as i64;
                if offset != rec.offset || words != rec.words {
                    problems.push(format!("index entry {i} does not point at record {i}"));
                }
            }
            if rec.shape_type != NULL_SHAPE && rec.shape_type != shapes.shape_type {
                problems.push(format!("record {i} is of {}", shape(rec.shape_type)));
            }
            if let Some(parts) = &rec.parts
                && parts.iter().any(|p| !p.is_empty())
            {
                let own = box_of(parts.iter().flatten());
                if let Some(b) = rec.bbox
                    && !same_bits(&b, &own)
                {
                    problems.push(format!(
                        "record {i} states a box that does not bound its points"
                    ));
                }
                all = Some(match all {
                    None => own,
                    Some(a) => [
                        js_min(a[0], own[0]),
                        js_min(a[1], own[1]),
                        js_max(a[2], own[2]),
                        js_max(a[3], own[3]),
                    ],
                });
                if parts.iter().flatten().next().is_some_and(|p| p.len() == 3) {
                    let own = z_range(parts.iter().flatten());
                    heights = Some(match heights {
                        None => own,
                        Some(h) => [js_min(h[0], own[0]), js_max(h[1], own[1])],
                    });
                }
            }
            got.push(&geometry_cell(rec.parts.as_ref(), shapes.shape_type));
        }
        if entries != records {
            problems.insert(
                problems
                    .iter()
                    .position(|p| p.starts_with("record ") || p.starts_with("index entry"))
                    .unwrap_or(problems.len()),
                format!("the index has {entries} entries for {records} records"),
            );
        }
        if !same_bits(&shp_head.bbox, &all.unwrap_or([0.0; 4])) {
            problems.push("the header box does not bound the shapes".into());
        }
        if !same_bits(&shp_head.z, &heights.unwrap_or([0.0; 2])) {
            problems.push("the header height range does not span the shapes".into());
        }
        if dbf.records != records {
            problems.push(format!(
                "the .dbf has {} records for {records} shapes",
                dbf.records
            ));
        }
        // The .dbf records, trimmed of spaces and re-typed with each column's type.
        let kinds: Vec<Kind> = expected.columns.iter().map(|c| c.kind).collect();
        let mut digests: Vec<ColumnDigest> =
            kinds.iter().map(|_| ColumnDigest::default()).collect();
        let mut fitted = vec![true; kinds.len()];
        let mut deleted = 0u64;
        for _ in 0..dbf.records {
            let flag = dbf.r.bytes(1).map_err(at("data.dbf"))?;
            if flag[0] == 0x2a {
                deleted += 1;
            }
            for (j, f) in dbf.fields.iter().enumerate() {
                let raw = dbf.r.bytes(f.width).map_err(at("data.dbf"))?;
                let text =
                    String::from_utf8(raw).map_err(|e| ("data.dbf".to_string(), e.to_string()))?;
                let text = text.trim_matches(' ');
                if let Some(kind) = kinds.get(j) {
                    match retype_dbf((!text.is_empty()).then_some(text), *kind) {
                        Some(c) => digests[j].push(&c),
                        None => fitted[j] = false,
                    }
                }
            }
        }
        let end = dbf.r.at < dbf.r.len && dbf.r.bytes(1).map_err(at("data.dbf"))?[0] == 0x1a;
        if deleted > 0 {
            problems.push(format!("{deleted} .dbf records are marked deleted"));
        }
        if !end {
            problems.push("the .dbf does not end with 0x1A".into());
        }
        let head = mapping.first();
        if head.map(|h| h.join(",")).as_deref() != Some("field,name,unit,type") {
            problems.push("data.fields.csv does not start with field,name,unit,type".into());
        }
        let listed: Vec<&str> = mapping
            .iter()
            .skip(1)
            .map(|r| r.first().map_or("", String::as_str))
            .collect();
        let field_names: Vec<&str> = dbf.fields.iter().map(|f| f.name.as_str()).collect();
        if listed != field_names {
            problems.push("the field names of data.fields.csv are not those of the .dbf".into());
        }
        for (col, f) in expected.columns.iter().zip(&dbf.fields) {
            let want = match col.typ.as_str() {
                "integer" | "number" => 'N',
                "boolean" => 'L',
                "date" => 'D',
                _ => 'C',
            };
            if f.typ != want {
                problems.push(format!("field {} is of type {}", f.name, f.typ));
            }
        }
        let prj = std::fs::read(locate("data.prj")).unwrap_or_default();
        if String::from_utf8_lossy(&prj) != want_prj {
            problems.push(
                "the .prj does not describe the coordinate reference system of the data".into(),
            );
        }
        if std::fs::read(locate("data.cpg")).unwrap_or_default() != b"UTF-8" {
            problems.push("the .cpg does not declare UTF-8".into());
        }
        let mut checks = vec![check(
            "RB-OPEN",
            true,
            "The .shp, .shx, .dbf and field list parse.".into(),
            Some(&file),
        )];
        checks.push(if problems.is_empty() {
            check(
                "RB-SHP-STRUCTURE",
                true,
                format!(
                    "{records} records of {} indexed by the .shx, as many .dbf records, boxes that bound the shapes, the .prj of the data's coordinate reference system and a UTF-8 .cpg.",
                    shape(shapes.shape_type)
                ),
                Some(&file),
            )
        } else {
            check(
                "RB-SHP-STRUCTURE",
                false,
                format!(
                    "Shapefile structure problems: {}.",
                    problems.iter().take(5).cloned().collect::<Vec<_>>().join("; ")
                ),
                Some(&file),
            )
        });
        let headers: Vec<String> = mapping
            .iter()
            .skip(1)
            .map(|r| {
                let name = r.get(1).map_or("", String::as_str);
                match r.get(2).map_or("", String::as_str) {
                    "" => name.to_string(),
                    unit => format!("{name} [{unit}]"),
                }
            })
            .collect();
        checks.push(header_check(expected, &headers, &label("data.fields.csv")));
        checks.push(rows_check(dbf.records, expected.rows, &label("data.dbf")));
        let values: Vec<Option<String>> = digests
            .into_iter()
            .zip(&fitted)
            .map(|(d, ok)| ok.then(|| d.finish()))
            .collect();
        checks.push(values_check(expected, &values, &label("data.dbf")));
        checks.push(
            if got.finish() == want && records == expected.rows && rows_seen == records {
                check(
                    "RB-SHP-GEOMETRY",
                    true,
                    "Every shape matches its row's geometry, coordinate for coordinate.".into(),
                    Some(&file),
                )
            } else {
                check(
                    "RB-SHP-GEOMETRY",
                    false,
                    "The shapes differ from the geometries of the rows.".into(),
                    Some(&file),
                )
            },
        );
        Ok(checks)
    })();
    Ok(match outcome {
        Ok(checks) => checks,
        Err((where_, why)) => vec![check(
            "RB-OPEN",
            false,
            format!("The Shapefile does not parse: {where_}: {why}."),
            Some(&file),
        )],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fields_as_the_typescript_engine_does() {
        assert_eq!(
            field_names(&[
                "Pressure [kPa]",
                "pressure",
                "PRESSURE",
                "1st reading",
                "Température",
                "Pressure annulus"
            ]),
            [
                "Pressure__",
                "pressure",
                "PRESSURE_1",
                "F1st_readi",
                "Temp_ratur",
                "Pressure_a"
            ]
        );
    }

    #[test]
    fn orients_rings_and_groups_them_back() {
        let square = |x: f64, cw: bool| {
            let mut r = vec![
                vec![x, 0.0],
                vec![x + 1.0, 0.0],
                vec![x + 1.0, 1.0],
                vec![x, 1.0],
                vec![x, 0.0],
            ];
            if cw {
                r.reverse();
            }
            r
        };
        let g = Geom::MultiPolygon(vec![vec![square(0.0, false)], vec![square(5.0, true)]]);
        let parts = shape_record(Some(g), POLYGON, false).unwrap();
        assert!(parts.iter().all(|r| ring_area(r) < 0.0));
        let Cell::Geometry(text) = geometry_cell(Some(&parts), POLYGON) else {
            panic!("a geometry")
        };
        assert!(text.contains("MultiPolygon"));
    }

    #[test]
    fn zeros_compare_as_javascript_compares_them() {
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert_eq!(
            csv_records("a,\"b,\"\"c\"\"\"\r\nd,e\r\n"),
            [["a", "b,\"c\""], ["d", "e"]]
        );
    }
}
