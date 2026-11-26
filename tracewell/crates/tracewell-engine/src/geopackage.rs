//! The GeoPackage profile, as the TypeScript export/geopackage.ts plans it, formats/geopackage
//! writes and reads it and readback.ts checks it: the same rules, the same bytes and the same
//! checks. The file is an SQLite database (sqlite.rs) with the GeoPackage 1.2 tables and one
//! feature table, "data", written as the rows of the output view are read, so a dataset of any
//! size is never held in memory; the read-back reads it back a page at a time.

use crate::digest::{Cell, ColumnDigest};
use crate::error::{EngineError, Result};
use crate::export::{
    Expected, OutColumn, Spatial, check, header_check, retype_text, rows_check, values_check,
};
use crate::parse::Kind;
use crate::shapefile::{
    Geom, Pos, ShapeSource, each_position, each_row, js_max, js_min, known_crs, row_geometry,
    shape_source, source_columns,
};
use crate::sqlite::{
    Database, SqlValue, SqliteHeader, TableTree, Writer, column_value, encode_record,
    parse_create_table, sql_upper,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// "GPKG", the application ID of every GeoPackage.
pub const APPLICATION_ID: u32 = 0x4750_4b47;
/// GeoPackage 1.2.
pub const USER_VERSION: u32 = 10_200;
/// The feature table every GeoPackage of the profile holds.
pub const TABLE: &str = "data";

/// The largest whole number a JavaScript number holds exactly.
const SAFE: f64 = 9_007_199_254_740_991.0;

const SRS_SQL: &str = "CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)";
const CONTENTS_SQL: &str = "CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))";
const GEOMETRY_COLUMNS_SQL: &str = "CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))";
const SEQUENCE_SQL: &str = "CREATE TABLE sqlite_sequence(name,seq)";

/// A row of gpkg_spatial_ref_sys.
#[derive(Clone, Debug, PartialEq)]
pub struct Srs {
    pub id: i64,
    pub name: String,
    pub organization: String,
    pub code: i64,
    pub definition: String,
    pub description: Option<String>,
}

/// The row gpkg_spatial_ref_sys holds for a CRS of the registry (gpkgSrs); OGC:CRS84 is EPSG:4326.
pub fn gpkg_srs(code: &str) -> Option<Srs> {
    let epsg = if code == "OGC:CRS84" {
        "EPSG:4326"
    } else {
        code
    };
    let definition = crate::geodesy::ogc_wkt(epsg)?;
    let n: i64 = epsg.strip_prefix("EPSG:")?.parse().ok()?;
    Some(if n == 4326 {
        Srs {
            id: 4326,
            name: "WGS 84 geodetic".into(),
            organization: "EPSG".into(),
            code: 4326,
            definition,
            description: Some(
                "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid".into(),
            ),
        }
    } else {
        Srs {
            id: n,
            name: crate::geodesy::crs_definition(epsg).map_or_else(|| epsg.to_string(), |d| d.name),
            organization: "EPSG".into(),
            code: n,
            definition,
            description: None,
        }
    })
}

/// Every row of gpkg_spatial_ref_sys: the undefined systems, WGS 84 and the system of the data.
fn srs_rows(data: &Srs) -> Vec<Srs> {
    let undefined = |id: i64, name: &str, what: &str| Srs {
        id,
        name: name.into(),
        organization: "NONE".into(),
        code: id,
        definition: "undefined".into(),
        description: Some(format!("undefined {what} coordinate reference system")),
    };
    let mut rows = vec![
        undefined(-1, "Undefined Cartesian SRS", "Cartesian"),
        undefined(0, "Undefined geographic SRS", "geographic"),
        gpkg_srs("EPSG:4326").expect("the registry holds WGS 84"),
    ];
    if data.id != 4326 {
        rows.push(data.clone());
    }
    rows.sort_by_key(|s| s.id);
    rows
}

/// The type a column of this kind is declared with (gpkgColumnType).
pub fn column_type(kind: Kind) -> &'static str {
    match kind {
        Kind::Integer => "INTEGER",
        Kind::Number => "REAL",
        Kind::Boolean => "BOOLEAN",
        Kind::Date => "DATE",
        Kind::DateTime => "DATETIME",
        Kind::Geometry | Kind::String => "TEXT",
    }
}

/// A name of our own that no column has, as SQLite compares names: ASCII letters in either case.
fn free_name(base: &str, headers: &[String]) -> String {
    let taken: HashSet<String> = headers.iter().map(|h| sql_upper(h)).collect();
    let mut name = base.to_string();
    let mut i = 1;
    while taken.contains(&sql_upper(&name)) {
        name = format!("{base}_{i}");
        i += 1;
    }
    name
}

/// The fid and geometry columns (gpkgOwnColumns), named "fid" and "geom" unless a column of the data is.
pub fn own_columns(headers: &[String]) -> (String, String) {
    let fid = free_name("fid", headers);
    let mut all = headers.to_vec();
    all.push(fid.clone());
    let geom = free_name("geom", &all);
    (fid, geom)
}

/// Why the columns cannot be fields of one table (gpkgNameProblem): two names SQLite takes as one, or a NUL.
fn name_problem(headers: &[String]) -> Option<String> {
    let mut seen: HashMap<String, &String> = HashMap::new();
    for h in headers {
        if h.contains('\0') {
            return Some(format!(
                "The column name {} holds a NUL character, which a GeoPackage field name cannot hold.",
                json!(h)
            ));
        }
        if let Some(other) = seen.get(&sql_upper(h)) {
            return Some(format!(
                "A GeoPackage field name is unique whatever the case of its letters, and the columns \"{other}\" and \"{h}\" differ only in case."
            ));
        }
        seen.insert(sql_upper(h), h);
    }
    None
}

fn type_name(g: &Geom) -> &'static str {
    match g {
        Geom::Point(_) => "POINT",
        Geom::MultiPoint(_) => "MULTIPOINT",
        Geom::LineString(_) => "LINESTRING",
        Geom::MultiLineString(_) => "MULTILINESTRING",
        Geom::Polygon(_) => "POLYGON",
        Geom::MultiPolygon(_) => "MULTIPOLYGON",
        Geom::Collection(_) => "GEOMETRYCOLLECTION",
    }
}

/// How many positions a geometry has, how many with heights, and the most numbers one holds.
fn heights(g: &Geom) -> (u64, u64, usize) {
    let (mut positions, mut with_z, mut longest) = (0u64, 0u64, 0usize);
    each_position(g, &mut |p| {
        if p.is_empty() {
            return;
        }
        positions += 1;
        if p.len() >= 3 {
            with_z += 1;
        }
        longest = longest.max(p.len());
    });
    (positions, with_z, longest)
}

/// [min x, max x, min y, max y] of a geometry's positions (envelopeOf), or None when it has none.
fn envelope(g: &Geom) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    each_position(g, &mut |p| {
        if p.is_empty() {
            return;
        }
        let (x, y) = (p[0], p[1]);
        b = Some(match b {
            None => [x, x, y, y],
            Some(e) => [
                js_min(e[0], x),
                js_max(e[1], x),
                js_min(e[2], y),
                js_max(e[3], y),
            ],
        });
    });
    b
}

struct Analysis {
    geometry_type: &'static str,
    z: u8,
    extent: Option<[f64; 4]>,
    bad: u64,
    long: u64,
    uneven: u64,
}

fn analyse(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    source: ShapeSource,
) -> Result<Analysis> {
    let mut types: Vec<&'static str> = Vec::new();
    let mut extent: Option<[f64; 4]> = None;
    let (mut bad, mut long, mut uneven, mut with_z, mut without_z) = (0u64, 0u64, 0u64, 0u64, 0u64);
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
            let t = type_name(&g);
            if !types.contains(&t) {
                types.push(t);
            }
            let (positions, z, longest) = heights(&g);
            if longest > 3 {
                long += 1;
            }
            if positions == 0 {
                return Ok(());
            }
            if z == positions {
                with_z += 1;
            } else {
                without_z += 1;
            }
            if z > 0 && z < positions {
                uneven += 1;
            }
            each_position(&g, &mut |p| {
                if p.is_empty() {
                    return;
                }
                let (x, y) = (p[0], p[1]);
                extent = Some(match extent {
                    None => [x, y, x, y],
                    Some(e) => [
                        js_min(e[0], x),
                        js_min(e[1], y),
                        js_max(e[2], x),
                        js_max(e[3], y),
                    ],
                });
            });
            Ok(())
        },
    )?;
    Ok(Analysis {
        geometry_type: if types.len() == 1 {
            types[0]
        } else {
            "GEOMETRY"
        },
        z: if with_z == 0 {
            0
        } else if without_z == 0 {
            1
        } else {
            2
        },
        extent,
        bad,
        long,
        uneven,
    })
}

/// Whether a geometry is written with heights (gpkgHasZ): every position has one, or, empty, as the column.
fn has_z(g: &Geom, z: u8) -> bool {
    let (positions, with_z, _) = heights(g);
    if positions == 0 {
        z == 1
    } else {
        with_z == positions
    }
}

// ---------------------------------------------------------------------------------------------
// GeoPackageBinary (formats/geopackage/gpkg.ts)

fn code_of(g: &Geom) -> u32 {
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

fn wkb(out: &mut Vec<u8>, g: &Geom, z: bool) {
    out.push(1);
    out.extend_from_slice(&(code_of(g) + if z { 1000 } else { 0 }).to_le_bytes());
    let position = |out: &mut Vec<u8>, p: &Pos| {
        out.extend_from_slice(&p[0].to_le_bytes());
        out.extend_from_slice(&p[1].to_le_bytes());
        if z {
            out.extend_from_slice(&p[2].to_le_bytes());
        }
    };
    let positions = |out: &mut Vec<u8>, ps: &[Pos]| {
        out.extend_from_slice(&(ps.len() as u32).to_le_bytes());
        for p in ps {
            position(out, p);
        }
    };
    match g {
        Geom::Point(p) if p.is_empty() => {
            for _ in 0..if z { 3 } else { 2 } {
                out.extend_from_slice(&f64::NAN.to_le_bytes());
            }
        }
        Geom::Point(p) => position(out, p),
        Geom::LineString(ps) => positions(out, ps),
        Geom::Polygon(rings) => {
            out.extend_from_slice(&(rings.len() as u32).to_le_bytes());
            for r in rings {
                positions(out, r);
            }
        }
        Geom::MultiPoint(ps) => {
            out.extend_from_slice(&(ps.len() as u32).to_le_bytes());
            for p in ps {
                wkb(out, &Geom::Point(p.clone()), z);
            }
        }
        Geom::MultiLineString(ls) => {
            out.extend_from_slice(&(ls.len() as u32).to_le_bytes());
            for l in ls {
                wkb(out, &Geom::LineString(l.clone()), z);
            }
        }
        Geom::MultiPolygon(ps) => {
            out.extend_from_slice(&(ps.len() as u32).to_le_bytes());
            for p in ps {
                wkb(out, &Geom::Polygon(p.clone()), z);
            }
        }
        Geom::Collection(gs) => {
            out.extend_from_slice(&(gs.len() as u32).to_le_bytes());
            for m in gs {
                wkb(out, m, z);
            }
        }
    }
}

/// A geometry as GeoPackageBinary in this SRS (gpkgGeometry).
fn gpkg_geometry(g: &Geom, srs_id: i64, z: bool) -> Vec<u8> {
    let b = envelope(g);
    let with_envelope = b.is_some() && !matches!(g, Geom::Point(_));
    let mut out = vec![0x47, 0x50, 0];
    out.push(0x01 | if with_envelope { 0x02 } else { 0 } | if b.is_none() { 0x10 } else { 0 });
    out.extend_from_slice(&(srs_id as i32).to_le_bytes());
    if let (true, Some(b)) = (with_envelope, b) {
        for v in b {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    wkb(&mut out, g, z);
    out
}

struct In<'a> {
    b: &'a [u8],
    at: usize,
    little: bool,
}

const CUT: &str = "a geometry is cut short";

impl In<'_> {
    fn need(&self, n: usize) -> std::result::Result<(), String> {
        if self.at.checked_add(n).is_none_or(|end| end > self.b.len()) {
            return Err(CUT.into());
        }
        Ok(())
    }

    fn u8(&mut self) -> std::result::Result<u8, String> {
        self.need(1)?;
        self.at += 1;
        Ok(self.b[self.at - 1])
    }

    fn word(&mut self) -> std::result::Result<[u8; 4], String> {
        self.need(4)?;
        let mut w = [0u8; 4];
        w.copy_from_slice(&self.b[self.at..self.at + 4]);
        self.at += 4;
        Ok(w)
    }

    fn u32(&mut self) -> std::result::Result<u32, String> {
        let w = self.word()?;
        Ok(if self.little {
            u32::from_le_bytes(w)
        } else {
            u32::from_be_bytes(w)
        })
    }

    fn f64(&mut self) -> std::result::Result<f64, String> {
        self.need(8)?;
        let mut w = [0u8; 8];
        w.copy_from_slice(&self.b[self.at..self.at + 8]);
        self.at += 8;
        Ok(if self.little {
            f64::from_le_bytes(w)
        } else {
            f64::from_be_bytes(w)
        })
    }
}

const NAMES: [&str; 8] = [
    "",
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection",
];

fn read_wkb(r: &mut In, depth: usize) -> std::result::Result<Geom, String> {
    if depth > 32 {
        return Err("a geometry is nested too deeply".into());
    }
    let order = r.u8()?;
    if order > 1 {
        return Err(format!("a geometry has the byte order {order}"));
    }
    r.little = order == 1;
    let code = r.u32()?;
    // ISO WKB adds 1000 for Z, 2000 for M and 3000 for both; extended WKB sets the two high bits.
    let mut base = code & 0x0fff_ffff;
    let thousands = base / 1000;
    if thousands > 3 {
        return Err(format!("a geometry has the unknown type {code}"));
    }
    base %= 1000;
    let has_z = code & 0x8000_0000 != 0 || thousands == 1 || thousands == 3;
    let has_m = code & 0x4000_0000 != 0 || thousands == 2 || thousands == 3;
    if !(1..=7).contains(&base) {
        return Err(format!("a geometry has the unknown type {code}"));
    }
    let little = r.little;
    let dims = 16 + if has_z { 8 } else { 0 } + if has_m { 8 } else { 0 };
    let position = |r: &mut In| -> std::result::Result<Pos, String> {
        let x = r.f64()?;
        let y = r.f64()?;
        let z = if has_z { Some(r.f64()?) } else { None };
        if has_m {
            r.f64()?;
        }
        Ok(match z {
            Some(z) => vec![x, y, z],
            None => vec![x, y],
        })
    };
    let count = |r: &mut In, size: usize| -> std::result::Result<usize, String> {
        let n = r.u32()? as usize;
        r.need(n.saturating_mul(size))?;
        Ok(n)
    };
    let positions = |r: &mut In| -> std::result::Result<Vec<Pos>, String> {
        let n = count(r, dims)?;
        (0..n).map(|_| position(r)).collect()
    };
    let member = |r: &mut In, want: u32| -> std::result::Result<Geom, String> {
        let g = read_wkb(r, depth + 1)?;
        r.little = little;
        if code_of(&g) != want {
            return Err(format!(
                "a {} holds a {}",
                NAMES[base as usize],
                NAMES[code_of(&g) as usize]
            ));
        }
        Ok(g)
    };
    Ok(match base {
        1 => {
            let p = position(r)?;
            Geom::Point(if p.iter().all(|v| v.is_nan()) {
                Vec::new()
            } else {
                p
            })
        }
        2 => Geom::LineString(positions(r)?),
        3 => {
            let n = count(r, 4)?;
            Geom::Polygon(
                (0..n)
                    .map(|_| positions(r))
                    .collect::<std::result::Result<_, _>>()?,
            )
        }
        4 => {
            let n = count(r, 5)?;
            let mut ps = Vec::with_capacity(n);
            for _ in 0..n {
                let Geom::Point(p) = member(r, 1)? else {
                    unreachable!()
                };
                ps.push(p);
            }
            Geom::MultiPoint(ps)
        }
        5 => {
            let n = count(r, 9)?;
            let mut ls = Vec::with_capacity(n);
            for _ in 0..n {
                let Geom::LineString(l) = member(r, 2)? else {
                    unreachable!()
                };
                ls.push(l);
            }
            Geom::MultiLineString(ls)
        }
        6 => {
            let n = count(r, 9)?;
            let mut ps = Vec::with_capacity(n);
            for _ in 0..n {
                let Geom::Polygon(p) = member(r, 3)? else {
                    unreachable!()
                };
                ps.push(p);
            }
            Geom::MultiPolygon(ps)
        }
        _ => {
            let n = count(r, 5)?;
            let mut gs = Vec::with_capacity(n);
            for _ in 0..n {
                gs.push(read_wkb(r, depth + 1)?);
                r.little = little;
            }
            Geom::Collection(gs)
        }
    })
}

/// A GeoPackageBinary blob read (readGpkgGeometry): its SRS ID, empty flag, envelope and geometry.
struct GeometryRead {
    srs_id: i64,
    empty: bool,
    envelope: Option<Vec<f64>>,
    geometry: Geom,
}

fn read_gpkg_geometry(blob: &[u8]) -> std::result::Result<GeometryRead, String> {
    let mut r = In {
        b: blob,
        at: 0,
        little: true,
    };
    if r.u8()? != 0x47 || r.u8()? != 0x50 {
        return Err("a geometry does not start with \"GP\"".into());
    }
    let version = r.u8()?;
    if version != 0 {
        return Err(format!(
            "a geometry is of GeoPackageBinary version {}",
            u32::from(version) + 1
        ));
    }
    let flags = r.u8()?;
    if flags & 0x20 != 0 {
        return Err("a geometry is of an extended GeoPackageBinary type".into());
    }
    r.little = flags & 0x01 != 0;
    let indicator = (flags >> 1) & 0x07;
    let size = match indicator {
        0 => 0,
        1 => 4,
        2 | 3 => 6,
        4 => 8,
        _ => return Err(format!("a geometry has the envelope indicator {indicator}")),
    };
    let w = r.word()?;
    let srs_id = i64::from(if r.little {
        i32::from_le_bytes(w)
    } else {
        i32::from_be_bytes(w)
    });
    let envelope = if size == 0 {
        None
    } else {
        Some(
            (0..size)
                .map(|_| r.f64())
                .collect::<std::result::Result<Vec<_>, _>>()?,
        )
    };
    let geometry = read_wkb(&mut r, 0)?;
    Ok(GeometryRead {
        srs_id,
        empty: flags & 0x10 != 0,
        envelope,
        geometry,
    })
}

/// A geometry as GeoJSON with each position keeping `keep` numbers at most (gpkgForm).
fn form(g: &Geom, keep: usize) -> Value {
    let p = |p: &Pos| json!(p.iter().take(keep).collect::<Vec<_>>());
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
            "geometries": Value::Array(x.iter().map(|m| form(m, keep)).collect()),
        }),
    }
}

// ---------------------------------------------------------------------------------------------
// The plan

pub struct GpkgPlan {
    pub refusal: Option<(String, String)>,
    pub substitutions: Vec<Value>,
    /// The columns the features hold as fields: every column but the geometry column.
    pub attributes: Vec<usize>,
}

fn refused(reason: String, fix: &str) -> GpkgPlan {
    GpkgPlan {
        refusal: Some((reason, fix.into())),
        substitutions: Vec::new(),
        attributes: Vec::new(),
    }
}

fn attributes(columns: &[OutColumn], source: ShapeSource) -> Vec<usize> {
    (0..columns.len())
        .filter(|j| !matches!(source, ShapeSource::Geometry(g) if g == *j))
        .collect()
}

pub fn plan(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
) -> Result<GpkgPlan> {
    let Some(source) = shape_source(columns, spatial) else {
        return Ok(refused(
            "The dataset has no geometry column and no coordinate columns (longitude and latitude, or easting and northing).".into(),
            "Set the coordinate roles on the coordinate columns, or export as CSV or Excel.",
        ));
    };
    let Some(code) = known_crs(spatial) else {
        return Ok(refused(
            "The coordinate reference system of the data is not known, and a GeoPackage records it.".into(),
            "Set the coordinate reference system of the dataset first.",
        ));
    };
    if gpkg_srs(code).is_none() {
        return Ok(refused(
            format!(
                "A GeoPackage describes its coordinate reference system in Well-Known Text, and Tracewell has no description of {code}."
            ),
            "Export as FlatGeobuf, which records the EPSG code alone, or transform the coordinates to a listed coordinate reference system first (Data › Transform coordinates).",
        ));
    }
    let attrs = attributes(columns, source);
    let headers: Vec<String> = attrs.iter().map(|&j| columns[j].header()).collect();
    if let Some(problem) = name_problem(&headers) {
        return Ok(refused(problem, "Rename one of the columns first."));
    }
    let a = analyse(conn, view, columns, source)?;
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
            "why": "Their positions hold more than three numbers, and a GeoPackage position holds x, y and a height.",
            "instead": "Each position keeps its first three numbers; the GeoJSON export keeps them all.",
        }));
    }
    if a.uneven > 0 {
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": geometries(a.uneven),
            "why": "Some of their positions have heights and others do not, and a GeoPackage geometry has a height at every position or at none.",
            "instead": "They are written without heights; the GeoJSON export keeps them.",
        }));
    }
    let (fid, geom) = own_columns(&headers);
    if fid != "fid" || geom != "geom" {
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": "the feature ID and geometry fields",
            "why": "A column of the data already has the name \"fid\" or \"geom\".",
            "instead": format!("The feature IDs are in the field \"{fid}\" and the geometries in \"{geom}\"."),
        }));
    }
    Ok(GpkgPlan {
        refusal: None,
        substitutions,
        attributes: attrs,
    })
}

// ---------------------------------------------------------------------------------------------
// The writer

fn mismatch(column: &OutColumn, cell: &Cell) -> EngineError {
    EngineError::new(
        "INTERNAL",
        format!(
            "The value {} in column \"{}\" is not a {} value, so it cannot be written to a GeoPackage.",
            json!(cell.text()),
            column.name,
            column.typ
        ),
        "Report this problem; the export was not written.",
    )
}

/// A cell as its field's value (gpkgValue); empty text is no value, as in the other formats.
fn value(column: &OutColumn, cell: &Cell) -> Result<SqlValue> {
    let cell = cell.clone().exportable();
    if cell == Cell::Null {
        return Ok(SqlValue::Null);
    }
    Ok(match (column.kind, &cell) {
        (Kind::String, Cell::Text(t)) | (Kind::Geometry, Cell::Geometry(t)) => {
            SqlValue::Text(t.clone())
        }
        (Kind::Number, Cell::Num(x)) => SqlValue::Real(*x),
        (Kind::Integer, Cell::Num(x)) if x.fract() == 0.0 && x.abs() <= SAFE => {
            SqlValue::Int(*x as i64)
        }
        (Kind::Boolean, Cell::Bool(b)) => SqlValue::Int(i64::from(*b)),
        (Kind::Date, Cell::Date(_)) | (Kind::DateTime, Cell::DateTime(_)) => {
            SqlValue::Text(cell.text())
        }
        _ => return Err(mismatch(column, &cell)),
    })
}

fn text(s: &str) -> SqlValue {
    SqlValue::Text(s.into())
}

fn table_row(
    w: &mut Writer,
    sql: &str,
    name: &str,
    rows: &[(i64, Vec<SqlValue>)],
) -> Result<Vec<SqlValue>> {
    let mut tree = TableTree::default();
    for (rowid, values) in rows {
        w.add(&mut tree, *rowid, &encode_record(values))?;
    }
    let root = w.finish_table(tree)?;
    Ok(vec![
        text("table"),
        text(name),
        text(name),
        SqlValue::Int(i64::from(root)),
        text(sql),
    ])
}

fn index_row(
    w: &mut Writer,
    name: &str,
    table: &str,
    entries: &[Vec<SqlValue>],
) -> Result<Vec<SqlValue>> {
    let root = w.index_leaf(entries)?;
    Ok(vec![
        text("index"),
        text(name),
        text(table),
        SqlValue::Int(i64::from(root)),
        SqlValue::Null,
    ])
}

fn quote_name(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Writes data.gpkg: the GeoPackage tables, then one feature per row of the output view.
#[allow(clippy::too_many_arguments)]
pub fn write(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    attributes: &[usize],
    name: &str,
    rows: u64,
    at: &str,
    ordered: bool,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let source = shape_source(columns, spatial)
        .ok_or_else(|| EngineError::internal("The GeoPackage has no geometries to write."))?;
    let code = known_crs(spatial).unwrap_or_default();
    let srs = gpkg_srs(code)
        .ok_or_else(|| EngineError::internal(format!("No description of {code} to write.")))?;
    let a = analyse(conn, view, columns, source)?;
    let attrs: Vec<&OutColumn> = attributes.iter().map(|&j| &columns[j]).collect();
    let headers: Vec<String> = attrs.iter().map(|c| c.header()).collect();
    let (fid, geom) = own_columns(&headers);
    let mut w = Writer::create(path)?;
    let mut schema = Vec::new();
    let srs_table: Vec<(i64, Vec<SqlValue>)> = srs_rows(&srs)
        .into_iter()
        .map(|s| {
            (
                s.id,
                vec![
                    SqlValue::Text(s.name),
                    SqlValue::Null,
                    SqlValue::Text(s.organization),
                    SqlValue::Int(s.code),
                    SqlValue::Text(s.definition),
                    s.description.map_or(SqlValue::Null, SqlValue::Text),
                ],
            )
        })
        .collect();
    schema.push(table_row(
        &mut w,
        SRS_SQL,
        "gpkg_spatial_ref_sys",
        &srs_table,
    )?);
    let bound = |i: usize| a.extent.map_or(SqlValue::Null, |e| SqlValue::Real(e[i]));
    schema.push(table_row(
        &mut w,
        CONTENTS_SQL,
        "gpkg_contents",
        &[(
            1,
            vec![
                text(TABLE),
                text("features"),
                text(name),
                text(""),
                text(at),
                bound(0),
                bound(1),
                bound(2),
                bound(3),
                SqlValue::Int(srs.id),
            ],
        )],
    )?);
    schema.push(index_row(
        &mut w,
        "sqlite_autoindex_gpkg_contents_1",
        "gpkg_contents",
        &[vec![text(TABLE), SqlValue::Int(1)]],
    )?);
    schema.push(index_row(
        &mut w,
        "sqlite_autoindex_gpkg_contents_2",
        "gpkg_contents",
        &[vec![text(name), SqlValue::Int(1)]],
    )?);
    schema.push(table_row(
        &mut w,
        GEOMETRY_COLUMNS_SQL,
        "gpkg_geometry_columns",
        &[(
            1,
            vec![
                text(TABLE),
                text(&geom),
                text(a.geometry_type),
                SqlValue::Int(srs.id),
                SqlValue::Int(i64::from(a.z)),
                SqlValue::Int(0),
            ],
        )],
    )?);
    schema.push(index_row(
        &mut w,
        "sqlite_autoindex_gpkg_geometry_columns_1",
        "gpkg_geometry_columns",
        &[vec![text(TABLE), text(&geom), SqlValue::Int(1)]],
    )?);
    schema.push(index_row(
        &mut w,
        "sqlite_autoindex_gpkg_geometry_columns_2",
        "gpkg_geometry_columns",
        &[vec![text(TABLE), SqlValue::Int(1)]],
    )?);
    let mut fields = vec![
        format!(
            "{} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL",
            quote_name(&fid)
        ),
        format!("{} {}", quote_name(&geom), a.geometry_type),
    ];
    fields.extend(
        attrs
            .iter()
            .map(|c| format!("{} {}", quote_name(&c.header()), column_type(c.kind))),
    );
    let feature_sql = format!("CREATE TABLE {} ({})", quote_name(TABLE), fields.join(", "));
    let src = source_columns(source);
    let picked: Vec<usize> = src.iter().chain(attributes).copied().collect();
    let mut tree = TableTree::default();
    let mut n = 0i64;
    let mut record = vec![SqlValue::Null; 2 + attrs.len()];
    each_row(conn, view, columns, &picked, ordered, &mut |cells| {
        if n % 4096 == 0 && cancel.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The export was cancelled.",
                "Start the export again when you are ready.",
            ));
        }
        n += 1;
        let g = row_geometry(&cells[..src.len()]).0;
        record[1] = match &g {
            Some(g) => SqlValue::Blob(gpkg_geometry(g, srs.id, has_z(g, a.z))),
            None => SqlValue::Null,
        };
        for (k, (c, cell)) in attrs.iter().zip(&cells[src.len()..]).enumerate() {
            record[2 + k] = value(c, cell)?;
        }
        w.add(&mut tree, n, &encode_record(&record))?;
        Ok(())
    })?;
    let root = w.finish_table(tree)?;
    schema.push(vec![
        text("table"),
        text(TABLE),
        text(TABLE),
        SqlValue::Int(i64::from(root)),
        SqlValue::Text(feature_sql),
    ]);
    let sequence: Vec<(i64, Vec<SqlValue>)> = if rows > 0 {
        vec![(1, vec![text(TABLE), SqlValue::Int(rows as i64)])]
    } else {
        Vec::new()
    };
    schema.push(table_row(
        &mut w,
        SEQUENCE_SQL,
        "sqlite_sequence",
        &sequence,
    )?);
    w.finish(
        &SqliteHeader {
            application_id: APPLICATION_ID,
            user_version: USER_VERSION,
        },
        &schema,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The read-back (readback.ts)

fn retype(v: &SqlValue, kind: Kind) -> Option<Cell> {
    match (kind, v) {
        (_, SqlValue::Null) => Some(Cell::Null),
        (Kind::Integer, SqlValue::Int(i)) if i.unsigned_abs() <= SAFE as u64 => {
            Some(Cell::Num(*i as f64))
        }
        (Kind::Number, SqlValue::Real(x)) => Some(Cell::Num(*x)),
        (Kind::Boolean, SqlValue::Int(0)) => Some(Cell::Bool(false)),
        (Kind::Boolean, SqlValue::Int(1)) => Some(Cell::Bool(true)),
        (Kind::String | Kind::Date | Kind::DateTime | Kind::Geometry, SqlValue::Text(t)) => {
            retype_text(t, kind)
        }
        _ => None,
    }
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

struct Layer {
    table: String,
    data_type: String,
    identifier: Option<String>,
    srs_id: Option<i64>,
    extent: [Option<f64>; 4],
    last_change: Option<String>,
    root: u32,
    columns: Vec<crate::sqlite::Column>,
}

struct GeometryColumn {
    table: String,
    column: String,
    typ: String,
    srs_id: i64,
    z: i64,
    m: i64,
}

/// The rows of a table by its columns' names, rowid aliases filled in (namedRows).
fn named_rows(
    db: &mut Database,
    tables: &HashMap<String, (u32, Option<String>)>,
    table: &str,
) -> std::result::Result<Vec<HashMap<String, SqlValue>>, String> {
    let Some((root, Some(sql))) = tables.get(table) else {
        return Ok(Vec::new());
    };
    let columns = parse_create_table(sql)?.1;
    let mut rows = Vec::new();
    db.each_row(*root, &mut |rowid, values| {
        rows.push(
            columns
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let v = if c.rowid {
                        SqlValue::Int(rowid)
                    } else {
                        column_value(c, values.get(i).cloned().unwrap_or(SqlValue::Null))
                    };
                    (c.name.clone(), v)
                })
                .collect(),
        );
        Ok(())
    })?;
    Ok(rows)
}

fn num(v: Option<&SqlValue>) -> Option<f64> {
    match v {
        Some(SqlValue::Real(x)) => Some(*x),
        Some(SqlValue::Int(i)) => Some(*i as f64),
        _ => None,
    }
}

fn int(v: Option<&SqlValue>) -> Option<i64> {
    match v {
        Some(SqlValue::Int(i)) => Some(*i),
        Some(SqlValue::Real(x)) => Some(*x as i64),
        _ => None,
    }
}

fn string(v: Option<&SqlValue>) -> Option<String> {
    match v {
        Some(SqlValue::Text(t)) => Some(t.clone()),
        _ => None,
    }
}

/// Reads data.gpkg back: RB-OPEN, RB-GPKG-STRUCTURE, RB-HEADER, RB-ROWS, RB-VALUES and RB-GPKG-GEOMETRY.
#[allow(clippy::too_many_arguments)]
pub fn read_back(
    conn: &duckdb::Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    expected: &Expected,
    name: &str,
    at: &str,
    ordered: bool,
    path: &Path,
    file: &str,
) -> Result<Vec<Value>> {
    let source = shape_source(columns, spatial)
        .ok_or_else(|| EngineError::internal("The GeoPackage has no geometries to read back."))?;
    let a = analyse(conn, view, columns, source)?;
    let srs = gpkg_srs(known_crs(spatial).unwrap_or_default());
    let mut want = ColumnDigest::default();
    each_row(
        conn,
        view,
        columns,
        &source_columns(source),
        ordered,
        &mut |cells| {
            let g = row_geometry(cells).0;
            want.push(&g.map_or(Cell::Null, |g| {
                Cell::Geometry(form(&g, if has_z(&g, a.z) { 3 } else { 2 }).to_string())
            }));
            Ok(())
        },
    )?;
    let want = want.finish();
    let headers: Vec<String> = expected.columns.iter().map(OutColumn::header).collect();
    let (fid_name, geom_name) = own_columns(&headers);

    let mut db = match Database::open(path) {
        Ok(db) => db,
        Err(why) => {
            return Ok(vec![check(
                "RB-OPEN",
                false,
                format!("The file does not open as a GeoPackage: {why}."),
                Some(file),
            )]);
        }
    };
    let opened = (|| -> std::result::Result<_, String> {
        let mut tables = HashMap::new();
        for row in db.schema()? {
            if row.kind == "table" {
                tables.insert(row.name, (row.root, row.sql));
            }
        }
        let systems = named_rows(&mut db, &tables, "gpkg_spatial_ref_sys")?;
        let geometry_columns: Vec<GeometryColumn> =
            named_rows(&mut db, &tables, "gpkg_geometry_columns")?
                .iter()
                .filter_map(|r| {
                    Some(GeometryColumn {
                        table: string(r.get("table_name"))?,
                        column: string(r.get("column_name")).unwrap_or_default(),
                        typ: string(r.get("geometry_type_name")).unwrap_or_default(),
                        srs_id: int(r.get("srs_id")).unwrap_or(0),
                        z: int(r.get("z")).unwrap_or(0),
                        m: int(r.get("m")).unwrap_or(0),
                    })
                })
                .collect();
        let mut layers = Vec::new();
        for r in named_rows(&mut db, &tables, "gpkg_contents")? {
            let Some(table) = string(r.get("table_name")) else {
                continue;
            };
            let Some((root, Some(sql))) = tables.get(&table) else {
                continue;
            };
            layers.push(Layer {
                data_type: string(r.get("data_type")).unwrap_or_default(),
                identifier: string(r.get("identifier")),
                srs_id: int(r.get("srs_id")),
                extent: [
                    num(r.get("min_x")),
                    num(r.get("min_y")),
                    num(r.get("max_x")),
                    num(r.get("max_y")),
                ],
                last_change: string(r.get("last_change")),
                root: *root,
                columns: parse_create_table(sql)?.1,
                table,
            });
        }
        let sequence = named_rows(&mut db, &tables, "sqlite_sequence")?;
        Ok((systems, geometry_columns, layers, sequence))
    })();
    let (systems, geometry_columns, layers, sequence) = match opened {
        Ok(o) => o,
        Err(why) => {
            return Ok(vec![check(
                "RB-OPEN",
                false,
                format!("The file does not open as a GeoPackage: {why}."),
                Some(file),
            )]);
        }
    };
    let mut checks = vec![check(
        "RB-OPEN",
        true,
        "The file opens as an SQLite database.".into(),
        Some(file),
    )];
    let mut problems: Vec<String> = Vec::new();
    if db.application_id != APPLICATION_ID {
        problems.push("the database is not marked as a GeoPackage".into());
    }
    if db.user_version != USER_VERSION {
        problems.push(format!(
            "the database states version {}, not 10200",
            db.user_version
        ));
    }
    let system = |id: i64| systems.iter().find(|s| int(s.get("srs_id")) == Some(id));
    for id in [-1, 0, 4326] {
        if system(id).is_none() {
            problems.push(format!("gpkg_spatial_ref_sys has no row {id}"));
        }
    }
    let described = srs.as_ref().is_some_and(|want| {
        system(want.id).is_some_and(|s| {
            string(s.get("organization")).as_deref() == Some("EPSG")
                && int(s.get("organization_coordsys_id")) == Some(want.code)
                && string(s.get("definition")).as_deref() == Some(want.definition.as_str())
        })
    });
    if !described {
        problems.push(
            "gpkg_spatial_ref_sys does not describe the coordinate reference system of the data"
                .into(),
        );
    }
    let Some(layer) = layers.first().filter(|_| layers.len() == 1) else {
        problems.push(format!(
            "gpkg_contents lists {} tables, not one",
            layers.len()
        ));
        checks.push(check(
            "RB-GPKG-STRUCTURE",
            false,
            format!("GeoPackage structure problems: {}.", problems.join("; ")),
            Some(file),
        ));
        return Ok(checks);
    };
    let srs_id = srs.as_ref().map(|s| s.id);
    if layer.table != TABLE || layer.data_type != "features" {
        problems.push("gpkg_contents does not list the feature table".into());
    }
    if layer.identifier.as_deref() != Some(name) {
        problems.push("the layer is not named after the dataset".into());
    }
    if layer.last_change.as_deref() != Some(at) {
        problems.push("the last change of the layer is not the time of the export".into());
    }
    if layer.srs_id != srs_id {
        problems.push("gpkg_contents does not give the layer the system of the data".into());
    }
    let described_column = geometry_columns
        .iter()
        .find(|g| g.table == layer.table)
        .is_some_and(|g| {
            g.column == geom_name
                && g.typ == a.geometry_type
                && Some(g.srs_id) == srs_id
                && g.z == i64::from(a.z)
                && g.m == 0
        });
    if !described_column {
        problems
            .push("gpkg_geometry_columns does not describe the geometry column as written".into());
    }
    let fid = layer.columns.first();
    if !fid.is_some_and(|c| c.rowid && c.name == fid_name) {
        problems.push(format!(
            "the first column is not the feature ID \"{fid_name}\""
        ));
    }
    let geom = layer.columns.get(1);
    if !geom.is_some_and(|c| c.name == geom_name && c.typ == a.geometry_type) {
        problems.push(format!(
            "the second column is not the geometry column \"{geom_name}\" of type {}",
            a.geometry_type
        ));
    }
    let fields: Vec<&crate::sqlite::Column> = layer.columns.iter().skip(2).collect();
    for (col, c) in expected.columns.iter().zip(&fields) {
        if c.typ != column_type(col.kind) {
            problems.push(format!("the field {} is declared {}", c.name, c.typ));
        }
    }
    let mut values: Vec<Option<ColumnDigest>> = expected
        .columns
        .iter()
        .map(|_| Some(ColumnDigest::default()))
        .collect();
    let mut shapes = ColumnDigest::default();
    let (mut count, mut out_of_order, mut other_system, mut mistyped, mut misboxed) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut bounds: Option<[f64; 4]> = None;
    let geometry_name = geometry_columns
        .iter()
        .find(|g| g.table == layer.table)
        .map(|g| g.column.clone());
    let geometry_at = layer
        .columns
        .iter()
        .position(|c| Some(&c.name) == geometry_name.as_ref());
    let read = db.each_row(layer.root, &mut |rowid, row| {
        count += 1;
        if rowid != count as i64 {
            out_of_order += 1;
        }
        let mut k = 0;
        let mut blob = None;
        for (i, c) in layer.columns.iter().enumerate() {
            if c.rowid {
                continue;
            }
            let v = column_value(c, row.get(i).cloned().unwrap_or(SqlValue::Null));
            if Some(i) == geometry_at {
                blob = Some(v);
                continue;
            }
            if let Some(col) = expected.columns.get(k) {
                match (retype(&v, col.kind), &mut values[k]) {
                    (Some(cell), Some(d)) => d.push(&cell),
                    _ => values[k] = None,
                }
            }
            k += 1;
        }
        let Some(SqlValue::Blob(blob)) = blob else {
            shapes.push(&Cell::Null);
            return Ok(());
        };
        let g = read_gpkg_geometry(&blob)?;
        if Some(g.srs_id) != srs_id {
            other_system += 1;
        }
        if a.geometry_type != "GEOMETRY" && type_name(&g.geometry) != a.geometry_type {
            mistyped += 1;
        }
        let env = envelope(&g.geometry);
        let fits = g.empty == env.is_none()
            && match (&g.envelope, env) {
                (None, None) => true,
                (None, Some(_)) => matches!(g.geometry, Geom::Point(_)),
                (Some(read), Some(e)) => {
                    read.len() == 4 && read.iter().zip(e).all(|(x, y)| same(*x, y))
                }
                (Some(_), None) => false,
            };
        if !fits {
            misboxed += 1;
        }
        if let Some(e) = env {
            bounds = Some(match bounds {
                None => [e[0], e[2], e[1], e[3]],
                Some(b) => [
                    js_min(b[0], e[0]),
                    js_min(b[1], e[2]),
                    js_max(b[2], e[1]),
                    js_max(b[3], e[3]),
                ],
            });
        }
        shapes.push(&Cell::Geometry(form(&g.geometry, 3).to_string()));
        Ok(())
    });
    if let Err(why) = read {
        problems.push(format!("the features do not read: {why}"));
    }
    if out_of_order > 0 {
        problems.push("the feature IDs are not 1, 2, 3… in row order".into());
    }
    if other_system > 0 {
        problems.push(format!("{other_system} geometries name another system"));
    }
    if mistyped > 0 {
        problems.push(format!(
            "{mistyped} geometries are not of the type the layer states"
        ));
    }
    if misboxed > 0 {
        problems.push(format!(
            "{misboxed} geometries carry an envelope or empty flag that does not fit them"
        ));
    }
    let bounded = match bounds {
        None => layer.extent.iter().all(Option::is_none),
        Some(b) => layer
            .extent
            .iter()
            .zip(b)
            .all(|(x, y)| x.is_some_and(|x| same(x, y))),
    };
    if !bounded {
        problems.push("the extent of the layer does not bound its geometries".into());
    }
    let counted = sequence.len() == 1
        && string(sequence[0].get("name")).as_deref() == Some(TABLE)
        && int(sequence[0].get("seq")) == Some(count as i64);
    if if count > 0 {
        !counted
    } else {
        !sequence.is_empty()
    } {
        problems.push("sqlite_sequence does not hold the last feature ID".into());
    }
    checks.push(if problems.is_empty() {
        check(
            "RB-GPKG-STRUCTURE",
            true,
            format!(
                "A GeoPackage 1.2 with one layer of {count} features in row order, typed fields, the system of the data by its EPSG code and Well-Known Text, and an extent that bounds the geometries."
            ),
            Some(file),
        )
    } else {
        problems.truncate(5);
        check(
            "RB-GPKG-STRUCTURE",
            false,
            format!("GeoPackage structure problems: {}.", problems.join("; ")),
            Some(file),
        )
    });
    let names: Vec<String> = fields.iter().map(|c| c.name.clone()).collect();
    checks.push(header_check(expected, &names, file));
    checks.push(rows_check(count, expected.rows, file));
    let digests: Vec<Option<String>> = values
        .into_iter()
        .map(|d| d.map(ColumnDigest::finish))
        .collect();
    checks.push(values_check(expected, &digests, file));
    checks.push(if shapes.finish() == want && count == expected.rows {
        check(
            "RB-GPKG-GEOMETRY",
            true,
            "Every feature's geometry matches its row's, coordinate for coordinate.".into(),
            Some(file),
        )
    } else {
        check(
            "RB-GPKG-GEOMETRY",
            false,
            "The feature geometries differ from the geometries of the rows.".into(),
            Some(file),
        )
    });
    Ok(checks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_geometries_the_typescript_code_writes() {
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        // A point: no envelope, little-endian, then ISO WKB.
        assert_eq!(
            hex(&gpkg_geometry(&Geom::Point(vec![1.0, 2.0]), 4326, false)),
            "47500001e61000000101000000000000000000f03f0000000000000040"
        );
        // An empty point: the empty flag and NaN coordinates.
        assert_eq!(
            &gpkg_geometry(&Geom::Point(vec![]), 4326, true)[..4],
            [0x47, 0x50, 0, 0x11]
        );
        let line = Geom::LineString(vec![vec![0.0, 0.0, 1.0], vec![2.0, -1.0, 3.0]]);
        let blob = gpkg_geometry(&line, 27700, true);
        assert_eq!(&blob[..4], [0x47, 0x50, 0, 0x03]);
        let read = read_gpkg_geometry(&blob).unwrap();
        assert_eq!(read.srs_id, 27700);
        assert_eq!(read.envelope, Some(vec![0.0, 2.0, -1.0, 0.0]));
        assert_eq!(form(&read.geometry, 3), form(&line, 3));
        // Big-endian extended WKB with M is read too, its measures dropped.
        let mut be = vec![0x47, 0x50, 0, 0x00, 0, 0, 0x10, 0xe6, 0];
        be.extend_from_slice(&(0x4000_0001u32).to_be_bytes());
        for v in [1.0f64, 2.0, 9.0] {
            be.extend_from_slice(&v.to_be_bytes());
        }
        assert_eq!(
            form(&read_gpkg_geometry(&be).unwrap().geometry, 3),
            json!({"type": "Point", "coordinates": [1.0, 2.0]})
        );
        assert!(read_gpkg_geometry(&blob[..20]).is_err());
    }

    #[test]
    fn names_its_own_fields_apart_from_the_data() {
        let h = |xs: &[&str]| xs.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
        assert_eq!(own_columns(&h(&["a"])), ("fid".into(), "geom".into()));
        assert_eq!(
            own_columns(&h(&["FID", "geom", "geom_1"])),
            ("fid_1".into(), "geom_2".into())
        );
        assert_eq!(
            name_problem(&h(&["Depth", "depth"])).unwrap(),
            "A GeoPackage field name is unique whatever the case of its letters, and the columns \"Depth\" and \"depth\" differ only in case."
        );
        assert!(name_problem(&h(&["Ä", "ä"])).is_none());
    }
}
