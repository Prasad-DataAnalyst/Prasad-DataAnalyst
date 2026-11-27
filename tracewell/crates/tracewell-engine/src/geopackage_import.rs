//! The GeoPackage import, as formats/geopackage/importer.ts reads it: one layer of a GeoPackage,
//! read a page at a time with the SQLite reader of sqlite.rs (SAD decision D-16). The layer is the
//! table the options name, else the first gpkg_contents lists as features, else the first it
//! lists as attributes. Each row is located by its feature ID; its fields are the table's columns
//! but the feature ID and the geometry, typed as the TypeScript reader types them, and its
//! geometry is read from GeoPackageBinary, kept as the file has it.

use crate::error::{EngineError, Result};
use crate::geopackage::{named_rows, read_gpkg_geometry};
use crate::parse::Raw;
use crate::shapefile::Geom;
use crate::sqlite::{Column, Database, SqlValue, column_value, parse_create_table, sql_upper};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read as _;
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// A row: its feature ID, its fields by column, and its geometry as the JSON text JavaScript
/// writes for it.
pub type Row = (u64, Vec<Raw>, Option<String>);

const PARSE_FIX: &str = "Save the layer again as a GeoPackage from the GIS tool (in QGIS: Export › Save Features As), then import the new file.";

fn parse_failed(why: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The GeoPackage does not parse: {why}."),
        PARSE_FIX,
    )
}

fn re(cell: &'static OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("a valid pattern"))
}

/// A table gpkg_contents lists, with what the import needs of it.
struct Layer {
    table: String,
    data_type: String,
    srs_id: Option<i64>,
    root: u32,
    columns: Vec<Column>,
    /// The column gpkg_geometry_columns names, when the table has it.
    geometry: Option<String>,
    /// The srs_id gpkg_geometry_columns gives the geometry column.
    geometry_srs: Option<i64>,
}

struct Srs {
    id: i64,
    name: String,
    organization: String,
    code: i64,
    definition: String,
}

struct File {
    db: Database,
    has_contents: bool,
    srs: Vec<Srs>,
    layers: Vec<Layer>,
}

fn int(v: Option<&SqlValue>) -> Option<i64> {
    match v {
        Some(SqlValue::Int(i)) => Some(*i),
        Some(SqlValue::Real(x)) => Some(*x as i64),
        _ => None,
    }
}

fn text(v: Option<&SqlValue>) -> Option<String> {
    match v {
        Some(SqlValue::Text(t)) => Some(t.clone()),
        _ => None,
    }
}

fn open(path: &Path) -> Result<File> {
    let mut db = Database::open(path).map_err(parse_failed)?;
    let read = (|| -> std::result::Result<_, String> {
        let mut tables = HashMap::new();
        for row in db.schema()? {
            if row.kind == "table" {
                tables.insert(row.name, (row.root, row.sql));
            }
        }
        let srs = named_rows(&mut db, &tables, "gpkg_spatial_ref_sys")?
            .iter()
            .map(|r| Srs {
                id: int(r.get("srs_id")).unwrap_or(0),
                name: text(r.get("srs_name")).unwrap_or_default(),
                organization: text(r.get("organization")).unwrap_or_default(),
                code: int(r.get("organization_coordsys_id")).unwrap_or(0),
                definition: text(r.get("definition")).unwrap_or_default(),
            })
            .collect();
        let mut geometries: HashMap<String, (String, i64)> = HashMap::new();
        for r in named_rows(&mut db, &tables, "gpkg_geometry_columns")? {
            if let Some(table) = text(r.get("table_name")) {
                geometries.insert(
                    table,
                    (
                        text(r.get("column_name")).unwrap_or_default(),
                        int(r.get("srs_id")).unwrap_or(0),
                    ),
                );
            }
        }
        let mut layers = Vec::new();
        for r in named_rows(&mut db, &tables, "gpkg_contents")? {
            let Some(table) = text(r.get("table_name")) else {
                continue;
            };
            let Some((root, Some(sql))) = tables.get(&table) else {
                continue;
            };
            let columns = parse_create_table(sql)?.1;
            let named = geometries.get(&table);
            layers.push(Layer {
                data_type: text(r.get("data_type")).unwrap_or_default(),
                srs_id: int(r.get("srs_id")),
                root: *root,
                geometry: named
                    .map(|(c, _)| c.clone())
                    .filter(|c| columns.iter().any(|col| &col.name == c)),
                geometry_srs: named.map(|(_, s)| *s),
                columns,
                table,
            });
        }
        Ok((tables.contains_key("gpkg_contents"), srs, layers))
    })();
    let (has_contents, srs, layers) = read.map_err(parse_failed)?;
    Ok(File {
        db,
        has_contents,
        srs,
        layers,
    })
}

/// The tables a GeoPackage holds data in, in the order gpkg_contents lists them.
fn data_layers(file: &File) -> Vec<&Layer> {
    file.layers
        .iter()
        .filter(|l| l.data_type == "features" || l.data_type == "attributes")
        .collect()
}

fn layer_index(file: &File, wanted: Option<&str>) -> Result<usize> {
    let layers = data_layers(file);
    if layers.is_empty() {
        return Err(parse_failed(if file.has_contents {
            "its gpkg_contents table lists no table of features or attributes"
        } else {
            "it is an SQLite database without the gpkg_contents table of a GeoPackage"
        }));
    }
    let chosen = match wanted {
        None => layers
            .iter()
            .find(|l| l.data_type == "features")
            .unwrap_or(&layers[0]),
        Some(w) => match layers.iter().find(|l| l.table == w) {
            Some(l) => l,
            None => {
                return Err(EngineError::new(
                    "INVALID_INPUT",
                    format!("The GeoPackage has no layer named {}.", json!(w)),
                    format!(
                        "Choose one of its layers: {}.",
                        layers
                            .iter()
                            .map(|l| l.table.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ));
            }
        },
    };
    Ok(file
        .layers
        .iter()
        .position(|l| std::ptr::eq(l, *chosen))
        .expect("the layer is the file's"))
}

/// The layer's columns of fields: every column but the feature ID and the geometry.
fn field_columns(layer: &Layer) -> Vec<(usize, &Column)> {
    layer
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.rowid && Some(&c.name) != layer.geometry.as_ref())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A field as the TypeScript reader gives it (fieldOf).
fn field_of(v: SqlValue, c: &Column) -> Raw {
    match v {
        SqlValue::Null => Raw::Null,
        SqlValue::Text(t) => Raw::Text(t),
        SqlValue::Real(x) if x.is_finite() => Raw::Number(x),
        SqlValue::Real(x) if x.is_nan() => Raw::Text("NaN".into()),
        SqlValue::Real(x) => Raw::Text(if x > 0.0 { "Infinity" } else { "-Infinity" }.into()),
        SqlValue::Int(i) if sql_upper(&c.typ) == "BOOLEAN" && (i == 0 || i == 1) => {
            Raw::Bool(i == 1)
        }
        SqlValue::Int(i) if i.unsigned_abs() <= 9_007_199_254_740_991 => Raw::Number(i as f64),
        SqlValue::Int(i) => Raw::Text(i.to_string()),
        SqlValue::Blob(b) => Raw::Text(hex(&b)),
    }
}

/// A number of a position as it is kept: -0 as 0, and what is not finite as null.
fn settled(x: f64) -> Value {
    if x.is_finite() {
        json!(if x == 0.0 { 0.0 } else { x })
    } else {
        Value::Null
    }
}

/// A geometry as GeoJSON, its numbers settled.
fn geojson(g: &Geom) -> Value {
    let p = |p: &Vec<f64>| Value::Array(p.iter().map(|x| settled(*x)).collect());
    let ps = |ps: &[Vec<f64>]| Value::Array(ps.iter().map(p).collect());
    let pss = |pss: &[Vec<Vec<f64>>]| Value::Array(pss.iter().map(|x| ps(x)).collect());
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
            "geometries": Value::Array(x.iter().map(geojson).collect()),
        }),
    }
}

/// Calls `send` with the rows of a layer in feature ID order, the first `limit` of them.
fn each_row(
    file: &mut File,
    index: usize,
    limit: usize,
    send: &mut dyn FnMut(Row) -> Result<()>,
) -> Result<()> {
    let layer = &file.layers[index];
    let fields = field_columns(layer);
    let g = layer
        .geometry
        .as_ref()
        .and_then(|name| layer.columns.iter().position(|c| &c.name == name));
    let mut n = 0usize;
    let mut failure: Option<EngineError> = None;
    let stop = || "stop".to_string();
    let read = file.db.each_row(layer.root, &mut |rowid, values| {
        if n >= limit {
            return Err(stop());
        }
        n += 1;
        let row = (|| -> Result<Row> {
            if !(0..=9_007_199_254_740_991).contains(&rowid) {
                return Err(parse_failed(format!(
                    "the feature ID {rowid} is outside the range of row locations"
                )));
            }
            let geometry = match g.and_then(|g| values.get(g)) {
                None | Some(SqlValue::Null) => None,
                Some(SqlValue::Blob(blob)) => {
                    let read = read_gpkg_geometry(blob).map_err(|e| {
                        parse_failed(format!(
                            "the geometry of feature {rowid} does not read: {e}"
                        ))
                    })?;
                    Some(crate::canonical::stringify(&geojson(&read.geometry)))
                }
                Some(_) => {
                    return Err(parse_failed(format!(
                        "the geometry of feature {rowid} is not a GeoPackage geometry"
                    )));
                }
            };
            let fields = fields
                .iter()
                .map(|(i, c)| {
                    field_of(
                        column_value(c, values.get(*i).cloned().unwrap_or(SqlValue::Null)),
                        c,
                    )
                })
                .collect();
            Ok((rowid as u64, fields, geometry))
        })();
        match row.and_then(&mut *send) {
            Ok(()) => Ok(()),
            Err(e) => {
                failure = Some(e);
                Err(stop())
            }
        }
    });
    if let Some(e) = failure {
        return Err(e);
    }
    match read {
        Err(why) if why != stop() => Err(parse_failed(why)),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------
// Detections

fn crs_detection(file: &File, layer: &Layer) -> Value {
    let det = |code: &str, confidence: &str, method: &str, evidence: String| {
        crate::detect::det(
            json!({ "code": code, "source": "geopackage-srs" }),
            confidence,
            method,
            evidence,
            false,
        )
    };
    let id = layer.geometry_srs.or(layer.srs_id);
    let srs = id.and_then(|id| file.srs.iter().find(|s| s.id == id));
    let (Some(id), Some(srs)) = (id, srs) else {
        return det(
            "unknown",
            "low",
            "geopackage-srs",
            format!(
                "gpkg_spatial_ref_sys has no row for the layer's srs_id {}, so the coordinate reference system is not known.",
                id.map_or("null".to_string(), |i| i.to_string())
            ),
        );
    };
    let name = if srs.name.is_empty() {
        String::new()
    } else {
        format!(" ({})", srs.name)
    };
    if sql_upper(&srs.organization) == "EPSG" && srs.code > 0 {
        return det(
            &format!("EPSG:{}", srs.code),
            "high",
            "geopackage-srs",
            format!(
                "gpkg_spatial_ref_sys gives the layer the coordinate reference system EPSG:{}{name}.",
                srs.code
            ),
        );
    }
    if sql_upper(&srs.organization) == "NONE" || id == 0 || id == -1 {
        return det(
            "unknown",
            "low",
            "geopackage-srs",
            format!(
                "The layer's srs_id {id} is the undefined {} system, so the coordinate reference system is not known.",
                if id == 0 { "geographic" } else { "Cartesian" }
            ),
        );
    }
    static AUTHORITY: OnceLock<regex::Regex> = OnceLock::new();
    let authority = re(
        &AUTHORITY,
        r#"AUTHORITY\["EPSG",[ ]*"?(\d{1,9})"?\]\][ \t\r\n]*$"#,
    )
    .captures(&srs.definition)
    .and_then(|c| c[1].parse::<u64>().ok());
    if let Some(code) = authority {
        return det(
            &format!("EPSG:{code}"),
            "high",
            "geopackage-srs-wkt",
            format!(
                "gpkg_spatial_ref_sys describes the layer's system{name} with Well-Known Text that names EPSG:{code}."
            ),
        );
    }
    det(
        "unknown",
        "low",
        "geopackage-srs",
        format!(
            "gpkg_spatial_ref_sys gives the layer the system {}:{}{name}, which has no EPSG code.",
            srs.organization, srs.code
        ),
    )
}

fn detections(file: &File, layer: &Layer, sample: &[Row], count: u64) -> Vec<(String, Value)> {
    let format_count = crate::csv::format_count;
    let layers = data_layers(file);
    let listed = layers
        .iter()
        .map(|l| format!("{} ({})", l.table, l.data_type))
        .collect::<Vec<_>>()
        .join(", ");
    let (encoding, label) = match file.db.encoding {
        2 => ("utf-16le", "UTF-16LE"),
        3 => ("utf-16be", "UTF-16BE"),
        _ => ("utf-8", "UTF-8"),
    };
    let det = |value: Value, method: &str, evidence: String| {
        crate::detect::det(value, "high", method, evidence, false)
    };
    let mut out = vec![
        (
            "encoding".to_string(),
            det(
                json!(encoding),
                "sqlite-header",
                format!("The SQLite header gives the text encoding {label}."),
            ),
        ),
        (
            "layer".to_string(),
            det(
                json!(layer.table),
                "geopackage-contents",
                if layers.len() == 1 {
                    format!("The GeoPackage holds one table of data, {listed}.")
                } else {
                    format!(
                        "The GeoPackage holds {} tables of data: {listed}; {} is read.",
                        layers.len(),
                        layer.table
                    )
                },
            ),
        ),
        (
            "rowCount".to_string(),
            det(
                json!(count),
                "geopackage-rows",
                format!(
                    "The table {} holds {} rows.",
                    layer.table,
                    format_count(count)
                ),
            ),
        ),
    ];
    if layer.geometry.is_some() {
        out.push(("crs".to_string(), crs_detection(file, layer)));
        let mut types: Vec<String> = Vec::new();
        for (_, _, g) in sample {
            let Some(t) = g
                .as_deref()
                .and_then(|g| serde_json::from_str::<Value>(g).ok())
                .and_then(|g| g["type"].as_str().map(str::to_string))
            else {
                continue;
            };
            if !types.contains(&t) {
                types.push(t);
            }
        }
        let over = if (sample.len() as u64) < count {
            format!("the first {}", format_count(sample.len() as u64))
        } else {
            format!("all {}", format_count(count))
        };
        let found = if types.is_empty() {
            "no geometry types".to_string()
        } else {
            format!("geometry types {}", types.join(", "))
        };
        out.push((
            "geometryTypes".to_string(),
            det(
                json!(types),
                "geometry-types",
                format!("Found {found} over {over} features."),
            ),
        ));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The import

pub struct Read {
    /// The format options: the layer and its geometry column.
    pub options: Value,
    pub header: Vec<String>,
    pub rows: Vec<Row>,
    pub detections: Vec<(String, Value)>,
    /// Whether the rows carry a geometry: the layer has a geometry column.
    pub geometry: bool,
}

/// The sniff: the layer, its detections and its first `sample` rows.
pub fn sniff(path: &Path, sample: usize) -> Result<Read> {
    let mut file = open(path)?;
    let index = layer_index(&file, None)?;
    let mut rows = Vec::new();
    each_row(&mut file, index, sample, &mut |r| {
        rows.push(r);
        Ok(())
    })?;
    let root = file.layers[index].root;
    let count = file.db.count(root).map_err(parse_failed)?;
    let layer = &file.layers[index];
    Ok(Read {
        options: json!({
            "format": "geopackage",
            "geopackage": { "layer": layer.table, "geometry": layer.geometry },
        }),
        header: field_columns(layer)
            .into_iter()
            .map(|(_, c)| c.name.clone())
            .collect(),
        detections: detections(&file, layer, &rows, count),
        geometry: layer.geometry.is_some(),
        rows,
    })
}

/// Hashes the file and reads the layer's rows. Returns the notes (none), the SHA-256 and the size.
pub fn read_rows(
    path: &Path,
    layer: Option<&str>,
    send: &mut dyn FnMut(Row) -> Result<()>,
    cancel: &AtomicBool,
    bytes_read: &AtomicU64,
) -> Result<(Vec<crate::csv::Note>, String, u64)> {
    let mut hasher = Sha256::new();
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    bytes_read.store(size, Ordering::Relaxed);
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let mut file = open(path)?;
    let index = layer_index(&file, layer)?;
    let mut n = 0u64;
    each_row(&mut file, index, usize::MAX, &mut |row| {
        if n.is_multiple_of(1024) && cancel.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The import was cancelled.",
                "Start the import again when you are ready.",
            ));
        }
        n += 1;
        send(row)
    })?;
    Ok((Vec::new(), digest, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/messy")
            .join(name)
    }

    #[test]
    fn reads_the_layers_sqlite_wrote() {
        let wells = sniff(&fixture("gpkg_wells_points_wgs84.gpkg"), 1000).unwrap();
        assert_eq!(
            wells.options,
            json!({ "format": "geopackage", "geopackage": { "layer": "wells", "geometry": "geom" } })
        );
        assert_eq!(wells.header.len(), 9);
        assert_eq!(wells.rows.len(), 39);
        let locs: Vec<u64> = wells.rows.iter().take(8).map(|r| r.0).collect();
        assert_eq!(locs, [1, 2, 3, 4, 5, 6, 8, 9]);
        assert_eq!(wells.rows[1].1[4], Raw::Number(250.0));
        assert_eq!(wells.rows[0].1[6], Raw::Bool(true));
        assert_eq!(
            wells.rows[7].2.as_deref(),
            Some(r#"{"type":"Point","coordinates":[1.45,57.18,-1200.5]}"#)
        );
        let crs = &wells.detections.iter().find(|(k, _)| k == "crs").unwrap().1;
        assert_eq!(crs["value"]["code"], "EPSG:4326");
        let blocks = sniff(&fixture("gpkg_licence_blocks_bng.gpkg"), 1000).unwrap();
        assert_eq!(blocks.rows[1].1[4], Raw::Text("Øresund Energi ApS".into()));
        assert_eq!(
            blocks.rows[3].1[5],
            Raw::Text("Relinquished in 2020".into())
        );
        let encoding = &blocks
            .detections
            .iter()
            .find(|(k, _)| k == "encoding")
            .unwrap()
            .1;
        assert_eq!(encoding["value"], "utf-16le");
        let mut operators = Vec::new();
        read_rows(
            &fixture("gpkg_licence_blocks_bng.gpkg"),
            Some("operators"),
            &mut |r| {
                operators.push(r);
                Ok(())
            },
            &AtomicBool::new(false),
            &AtomicU64::new(0),
        )
        .unwrap();
        assert_eq!(operators.len(), 3);
        assert!(operators.iter().all(|r| r.2.is_none() && r.1.len() == 2));
        let missing = read_rows(
            &fixture("gpkg_licence_blocks_bng.gpkg"),
            Some("wells"),
            &mut |_| Ok(()),
            &AtomicBool::new(false),
            &AtomicU64::new(0),
        );
        assert_eq!(
            missing.unwrap_err().fix,
            "Choose one of its layers: blocks, operators."
        );
    }
}
