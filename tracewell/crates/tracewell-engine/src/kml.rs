//! The Google Earth profile, as the TypeScript export/kml.ts plans it, formats/kml writes and
//! reads it and readback.ts checks it: the same rules, the same bytes and the same checks. Each
//! row is a Placemark named by the first ID column, its values as ExtendedData by header and its
//! geometry, or the point of its latitude and longitude, in WGS 84. A multi-part geometry or a
//! collection is a MultiGeometry, read back as a multi-part geometry when its members are all of
//! one kind.

use crate::canonical::canonical_number;
use crate::digest::{Cell, ColumnDigest, cell_at};
use crate::error::{EngineError, Result};
use crate::export::{Expected, OutColumn, Spatial, check, retype_text, rows_check, values_check};
use crate::import::quote_ident;
use crate::json::{J, parse};
use crate::parse::Kind;
use crate::stream::each_batch;
use crate::xlsx::xml::{Attrs, Handler};
use duckdb::Connection;
use serde_json::{Value, json};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

const NAMESPACE: &str = "http://www.opengis.net/kml/2.2";

/// Where the places come from (geometrySource): the geometry column, or the latitude and
/// longitude columns, as places among the output columns.
#[derive(Clone, Copy)]
enum Source {
    Column(usize),
    LatLon(Option<usize>, Option<usize>),
}

fn source(columns: &[OutColumn], spatial: &Spatial) -> Option<Source> {
    if let Some(j) = spatial
        .geometry_column
        .as_deref()
        .and_then(|g| columns.iter().position(|c| c.id == g))
    {
        return Some(Source::Column(j));
    }
    let lat = columns.iter().position(|c| c.role == "latitude");
    let lon = columns.iter().position(|c| c.role == "longitude");
    (lat.is_some() && lon.is_some()).then_some(Source::LatLon(lat, lon))
}

fn source_columns(s: Source) -> Vec<usize> {
    match s {
        Source::Column(j) => vec![j],
        Source::LatLon(lat, lon) => vec![lat.unwrap_or(0), lon.unwrap_or(0)],
    }
}

/// The attribute columns (kmlAttributes): every column but the geometry column.
fn attributes(columns: &[OutColumn], s: Source) -> Vec<usize> {
    (0..columns.len())
        .filter(|j| !matches!(s, Source::Column(g) if g == *j))
        .collect()
}

/// A row's geometry as JSON, and whether a value had no valid shape.
fn row_geometry(cells: &[Cell]) -> (Option<J>, bool) {
    match cells {
        [Cell::Geometry(text)] => match parse(text) {
            Ok(g) if crate::geo::has_shape(&g) => (Some(g), false),
            _ => (None, true),
        },
        [Cell::Null] => (None, false),
        [_] => (None, true),
        // The point of the latitude (first) and longitude (second).
        [Cell::Num(y), Cell::Num(x)] => (
            Some(J::Obj(vec![
                ("type".into(), J::Str("Point".into())),
                ("coordinates".into(), J::Arr(vec![J::Num(*x), J::Num(*y)])),
            ])),
            false,
        ),
        _ => (None, false),
    }
}

fn member<'a>(g: &'a J, key: &str) -> Option<&'a J> {
    match g {
        J::Obj(m) => m.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn kind(g: &J) -> &str {
    match member(g, "type") {
        Some(J::Str(t)) => t,
        _ => "",
    }
}

fn items(j: Option<&J>) -> &[J] {
    match j {
        Some(J::Arr(v)) => v,
        _ => &[],
    }
}

/// The most numbers any position of a geometry has.
fn longest(g: &J) -> usize {
    fn visit(c: &J, most: &mut usize) {
        if let J::Arr(v) = c {
            if matches!(v.first(), Some(J::Num(_))) {
                *most = (*most).max(v.len());
            } else {
                v.iter().for_each(|x| visit(x, most));
            }
        }
    }
    let mut most = 0;
    if kind(g) == "GeometryCollection" {
        for m in items(member(g, "geometries")) {
            most = most.max(longest(m));
        }
    } else if let Some(c) = member(g, "coordinates") {
        visit(c, &mut most);
    }
    most
}

/// Characters XML 1.0 cannot carry.
fn not_xml(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}')
}

fn order_by(ordered: bool) -> &'static str {
    if ordered { " ORDER BY __rid" } else { "" }
}

fn each_row(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    picked: &[usize],
    ordered: bool,
    f: &mut dyn FnMut(&[Cell]) -> Result<()>,
) -> Result<()> {
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

/// The text of a value, or None for no value.
fn text_of(cell: Cell) -> Option<String> {
    match cell.exportable() {
        Cell::Null => None,
        c => Some(c.text()),
    }
}

// ---------------------------------------------------------------------------------------------
// The plan

pub struct KmlPlan {
    pub substitutions: Vec<Value>,
    /// The columns the placemarks hold, and those that go to data-long-text.csv.
    pub attributes: Vec<usize>,
    pub unfit: Vec<usize>,
}

/// Why KML cannot hold this dataset (kmlPlan's refusals), before any data is read.
pub fn refusal(columns: &[OutColumn], spatial: &Spatial) -> Option<(String, String)> {
    if source(columns, spatial).is_none() {
        return Some((
            "The dataset has no geometry column and no latitude and longitude columns.".into(),
            "Set the latitude and longitude roles on the coordinate columns, or export as CSV or Excel.".into(),
        ));
    }
    match spatial.crs.as_deref() {
        Some("OGC:CRS84" | "EPSG:4326") => None,
        other => Some((
            format!(
                "KML holds WGS 84 longitude and latitude; this dataset is in {}.",
                other.unwrap_or("an undeclared coordinate system")
            ),
            "Transform the coordinates to EPSG:4326 first (Data › Transform coordinates), or export as a Shapefile, which keeps the coordinate reference system of the data.".into(),
        )),
    }
}

pub fn plan(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
) -> Result<KmlPlan> {
    let s = source(columns, spatial)
        .ok_or_else(|| EngineError::internal("The KML profile has no places to write."))?;
    let src = source_columns(s);
    let attrs = attributes(columns, s);
    let picked: Vec<usize> = src.iter().chain(&attrs).copied().collect();
    let (mut bad, mut long) = (0u64, 0u64);
    let mut unfit = vec![false; attrs.len()];
    each_row(conn, view, columns, &picked, false, &mut |cells| {
        let (g, is_bad) = row_geometry(&cells[..src.len()]);
        if is_bad {
            bad += 1;
        }
        if g.as_ref().is_some_and(|g| longest(g) > 3) {
            long += 1;
        }
        for (k, u) in unfit.iter_mut().enumerate() {
            if !*u {
                *u = text_of(cells[src.len() + k].clone()).is_some_and(|t| t.chars().any(not_xml));
            }
        }
        Ok(())
    })?;
    let unfit: Vec<usize> = attrs
        .iter()
        .zip(&unfit)
        .filter(|(_, u)| **u)
        .map(|(j, _)| *j)
        .collect();
    let geometries = |n: u64| format!("{n} geometr{}", if n > 1 { "ies" } else { "y" });
    let mut substitutions = Vec::new();
    if !unfit.is_empty() {
        let names: Vec<&str> = unfit.iter().map(|&j| columns[j].name.as_str()).collect();
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": format!("the column{} {}", if unfit.len() > 1 { "s" } else { "" }, names.join(", ")),
            "why": "Some values hold characters XML cannot carry, such as control characters.",
            "instead": "These columns are delivered in data-long-text.csv in the package, row for row with the placemarks.",
        }));
    }
    if bad > 0 {
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": geometries(bad),
            "why": "They do not have the shape of a geometry: a misplaced array or an unknown type.",
            "instead": "Their placemarks have no geometry; their other values are kept.",
        }));
    }
    if long > 0 {
        substitutions.push(json!({
            "ruleId": "TW-EXP-002",
            "what": geometries(long),
            "why": "Their positions hold more than three numbers, and a KML position holds longitude, latitude and height.",
            "instead": "Each position keeps its first three numbers; the GeoJSON export keeps them all.",
        }));
    }
    Ok(KmlPlan {
        substitutions,
        attributes: attrs.into_iter().filter(|j| !unfit.contains(j)).collect(),
        unfit,
    })
}

// ---------------------------------------------------------------------------------------------
// The writer (formats/kml/writer.ts)

fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\r' => out.push_str("&#13;"),
            _ => out.push(c),
        }
    }
}

fn escape_attribute(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\r' => out.push_str("&#13;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("&#9;"),
            '\n' => out.push_str("&#10;"),
            _ => out.push(c),
        }
    }
}

fn position(p: &J, out: &mut String) {
    for (i, x) in items(Some(p)).iter().take(3).enumerate() {
        if i > 0 {
            out.push(',');
        }
        if let J::Num(n) = x {
            out.push_str(&canonical_number(*n));
        }
    }
}

fn coordinates(ps: &[J], out: &mut String) {
    out.push_str("<coordinates>");
    for (i, p) in ps.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        position(p, out);
    }
    out.push_str("</coordinates>");
}

fn ring(ps: &[J], out: &mut String) {
    out.push_str("<LinearRing>");
    coordinates(ps, out);
    out.push_str("</LinearRing>");
}

fn polygon(rings: &[J], out: &mut String) {
    out.push_str("<Polygon>");
    for (i, r) in rings.iter().enumerate() {
        let tag = if i == 0 {
            "outerBoundaryIs"
        } else {
            "innerBoundaryIs"
        };
        out.push_str(&format!("<{tag}>"));
        ring(items(Some(r)), out);
        out.push_str(&format!("</{tag}>"));
    }
    out.push_str("</Polygon>");
}

/// A geometry as KML (geometryXml).
fn geometry_xml(g: &J, out: &mut String) {
    let c = items(member(g, "coordinates"));
    match kind(g) {
        "Point" => {
            out.push_str("<Point>");
            coordinates(
                std::slice::from_ref(member(g, "coordinates").unwrap_or(&J::Null)),
                out,
            );
            out.push_str("</Point>");
        }
        "LineString" => {
            out.push_str("<LineString>");
            coordinates(c, out);
            out.push_str("</LineString>");
        }
        "Polygon" => polygon(c, out),
        "MultiPoint" => {
            out.push_str("<MultiGeometry>");
            for p in c {
                out.push_str("<Point>");
                coordinates(std::slice::from_ref(p), out);
                out.push_str("</Point>");
            }
            out.push_str("</MultiGeometry>");
        }
        "MultiLineString" => {
            out.push_str("<MultiGeometry>");
            for l in c {
                out.push_str("<LineString>");
                coordinates(items(Some(l)), out);
                out.push_str("</LineString>");
            }
            out.push_str("</MultiGeometry>");
        }
        "MultiPolygon" => {
            out.push_str("<MultiGeometry>");
            for p in c {
                polygon(items(Some(p)), out);
            }
            out.push_str("</MultiGeometry>");
        }
        _ => {
            out.push_str("<MultiGeometry>");
            for m in items(member(g, "geometries")) {
                geometry_xml(m, out);
            }
            out.push_str("</MultiGeometry>");
        }
    }
}

/// Writes data.kml: one placemark per row of the output view.
#[allow(clippy::too_many_arguments)]
pub fn write(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    attributes: &[usize],
    name: &str,
    ordered: bool,
    path: &Path,
) -> Result<()> {
    let s = source(columns, spatial)
        .ok_or_else(|| EngineError::internal("The KML profile has no places to write."))?;
    let src = source_columns(s);
    let picked: Vec<usize> = src.iter().chain(attributes).copied().collect();
    let named = attributes.iter().position(|&j| columns[j].role == "id");
    let headers: Vec<String> = attributes.iter().map(|&j| columns[j].header()).collect();
    let mut out = BufWriter::with_capacity(1 << 20, File::create(path)?);
    let mut head = String::new();
    head.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    head.push_str(&format!("<kml xmlns=\"{NAMESPACE}\">\n<Document>\n<name>"));
    escape_text(name, &mut head);
    head.push_str("</name>\n");
    out.write_all(head.as_bytes())?;
    let mut text = String::new();
    each_row(conn, view, columns, &picked, ordered, &mut |cells| {
        text.clear();
        text.push_str("<Placemark>\n");
        let values: Vec<Option<String>> = cells[src.len()..].iter().cloned().map(text_of).collect();
        if let Some(Some(n)) = named.map(|k| &values[k]) {
            text.push_str("<name>");
            escape_text(n, &mut text);
            text.push_str("</name>\n");
        }
        text.push_str("<ExtendedData>\n");
        for (header, value) in headers.iter().zip(&values) {
            text.push_str("<Data name=\"");
            escape_attribute(header, &mut text);
            text.push_str("\"><value>");
            escape_text(value.as_deref().unwrap_or(""), &mut text);
            text.push_str("</value></Data>\n");
        }
        text.push_str("</ExtendedData>\n");
        if let (Some(g), _) = row_geometry(&cells[..src.len()]) {
            geometry_xml(&g, &mut text);
            text.push('\n');
        }
        text.push_str("</Placemark>\n");
        out.write_all(text.as_bytes())?;
        Ok(())
    })?;
    out.write_all(b"</Document>\n</kml>\n")?;
    out.flush()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The geometry a reader takes back (kmlForm, multiGeometry)

fn positions3(c: &[J]) -> Value {
    Value::Array(c.iter().map(pos3).collect())
}

fn pos3(p: &J) -> Value {
    Value::Array(
        items(Some(p))
            .iter()
            .take(3)
            .map(|x| {
                if let J::Num(n) = x {
                    json!(n)
                } else {
                    Value::Null
                }
            })
            .collect(),
    )
}

/// A MultiGeometry's members as GeoJSON (multiGeometry).
fn multi(members: Vec<Value>) -> Value {
    let all = |t: &str| !members.is_empty() && members.iter().all(|m| m["type"] == t);
    let coords = |ms: &[Value]| Value::Array(ms.iter().map(|m| m["coordinates"].clone()).collect());
    if all("Point") {
        json!({ "type": "MultiPoint", "coordinates": coords(&members) })
    } else if all("LineString") {
        json!({ "type": "MultiLineString", "coordinates": coords(&members) })
    } else if all("Polygon") {
        json!({ "type": "MultiPolygon", "coordinates": coords(&members) })
    } else {
        json!({ "type": "GeometryCollection", "geometries": members })
    }
}

fn kml_form(g: &J) -> Value {
    let c = items(member(g, "coordinates"));
    let rings = |rs: &[J]| Value::Array(rs.iter().map(|r| positions3(items(Some(r)))).collect());
    match kind(g) {
        "Point" => {
            json!({ "type": "Point", "coordinates": pos3(member(g, "coordinates").unwrap_or(&J::Null)) })
        }
        "LineString" => json!({ "type": "LineString", "coordinates": positions3(c) }),
        "Polygon" => json!({ "type": "Polygon", "coordinates": rings(c) }),
        "MultiPoint" => multi(
            c.iter()
                .map(|p| json!({ "type": "Point", "coordinates": pos3(p) }))
                .collect(),
        ),
        "MultiLineString" => multi(
            c.iter()
                .map(|l| json!({ "type": "LineString", "coordinates": positions3(items(Some(l))) }))
                .collect(),
        ),
        "MultiPolygon" => multi(
            c.iter()
                .map(|p| json!({ "type": "Polygon", "coordinates": rings(items(Some(p))) }))
                .collect(),
        ),
        _ => multi(
            items(member(g, "geometries"))
                .iter()
                .map(kml_form)
                .collect(),
        ),
    }
}

// ---------------------------------------------------------------------------------------------
// The reader (formats/kml/reader.ts) and the read-back (readback.ts readKmlFile)

enum Building {
    Simple {
        kind: &'static str,
        positions: Vec<Value>,
    },
    Polygon {
        rings: Vec<Value>,
        outer: bool,
    },
    Ring(Vec<Value>),
    Multi(Vec<Value>),
}

struct Placemark {
    name: Option<String>,
    data: Vec<(String, String)>,
    geometry: Option<Value>,
    geometries: u64,
}

#[derive(Default)]
struct Reader {
    root: Option<String>,
    namespace: Option<String>,
    documents: u64,
    name: Option<String>,
    placemarks: Vec<Placemark>,
    path: Vec<String>,
    geometry: Vec<Building>,
    current: Option<Placemark>,
    buffer: Option<String>,
    data_name: Option<String>,
    value: String,
}

fn parse_positions(text: &str) -> Result<Vec<Value>> {
    text.split_whitespace()
        .map(|t| {
            t.split(',')
                .map(|x| {
                    x.parse::<f64>()
                        .ok()
                        .filter(|n| n.is_finite())
                        .map(|n| json!(n))
                        .ok_or_else(|| {
                            EngineError::new(
                                "FORMAT",
                                format!("the coordinates {} are not numbers", json!(t)),
                                "",
                            )
                        })
                })
                .collect::<Result<Vec<_>>>()
                .map(Value::Array)
        })
        .collect()
}

impl Reader {
    fn finish(&mut self, g: Value) {
        if let Some(Building::Multi(members)) = self.geometry.last_mut() {
            members.push(g);
        } else if let Some(p) = &mut self.current {
            p.geometries += 1;
            p.geometry = Some(g);
        }
    }
}

impl Handler for Reader {
    fn open(&mut self, name: &str, attrs: &Attrs, _self_closing: bool) -> Result<()> {
        if self.path.is_empty() {
            self.root = Some(name.to_string());
            self.namespace = attrs.get("xmlns").map(String::from);
        }
        let parent = self.path.last().cloned();
        self.path.push(name.to_string());
        match name {
            "Document" => self.documents += 1,
            "Placemark" => {
                self.current = Some(Placemark {
                    name: None,
                    data: Vec::new(),
                    geometry: None,
                    geometries: 0,
                });
            }
            "name" if matches!(parent.as_deref(), Some("Placemark" | "Document")) => {
                self.buffer = Some(String::new());
            }
            "Data" => {
                self.data_name = Some(attrs.get("name").unwrap_or("").to_string());
                self.value.clear();
            }
            "value" | "coordinates" => self.buffer = Some(String::new()),
            "Point" => self.geometry.push(Building::Simple {
                kind: "Point",
                positions: Vec::new(),
            }),
            "LineString" => self.geometry.push(Building::Simple {
                kind: "LineString",
                positions: Vec::new(),
            }),
            "Polygon" => self.geometry.push(Building::Polygon {
                rings: Vec::new(),
                outer: false,
            }),
            "LinearRing" => self.geometry.push(Building::Ring(Vec::new())),
            "MultiGeometry" => self.geometry.push(Building::Multi(Vec::new())),
            "outerBoundaryIs" => {
                if let Some(Building::Polygon { outer, .. }) = self.geometry.last_mut() {
                    *outer = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn text(&mut self, text: &str) -> Result<()> {
        if let Some(b) = &mut self.buffer {
            b.push_str(text);
        }
        Ok(())
    }

    fn close(&mut self, name: &str) -> Result<()> {
        self.path.pop();
        let parent = self.path.last().cloned();
        match name {
            "name" => {
                if let Some(text) = self.buffer.take() {
                    match parent.as_deref() {
                        Some("Placemark") => {
                            if let Some(p) = &mut self.current {
                                p.name = Some(text);
                            }
                        }
                        Some("Document") => self.name = Some(text),
                        _ => {}
                    }
                }
            }
            "value" => self.value = self.buffer.take().unwrap_or_default(),
            "Data" => {
                let name = self.data_name.take().unwrap_or_default();
                let value = std::mem::take(&mut self.value);
                if let Some(p) = &mut self.current {
                    p.data.push((name, value));
                }
            }
            "coordinates" => {
                let parsed = parse_positions(&self.buffer.take().unwrap_or_default())?;
                match self.geometry.last_mut() {
                    Some(Building::Simple { positions, .. } | Building::Ring(positions)) => {
                        *positions = parsed;
                    }
                    _ => {}
                }
            }
            "Point" | "LineString" => {
                if let Some(Building::Simple { kind, positions }) = self.geometry.pop() {
                    let g = if kind == "Point" {
                        json!({ "type": "Point", "coordinates": positions.into_iter().next().unwrap_or(json!([])) })
                    } else {
                        json!({ "type": "LineString", "coordinates": positions })
                    };
                    self.finish(g);
                }
            }
            "LinearRing" => {
                if let Some(Building::Ring(positions)) = self.geometry.pop()
                    && let Some(Building::Polygon { rings, outer }) = self.geometry.last_mut()
                {
                    // The outer boundary comes first, however the file orders it.
                    if *outer {
                        rings.insert(0, Value::Array(positions));
                    } else {
                        rings.push(Value::Array(positions));
                    }
                    *outer = false;
                }
            }
            "Polygon" => {
                if let Some(Building::Polygon { rings, .. }) = self.geometry.pop() {
                    self.finish(json!({ "type": "Polygon", "coordinates": rings }));
                }
            }
            "MultiGeometry" => {
                if let Some(Building::Multi(members)) = self.geometry.pop() {
                    self.finish(multi(members));
                }
            }
            "Placemark" => {
                if let Some(p) = self.current.take() {
                    self.placemarks.push(p);
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn geometry_cell(g: Option<&Value>) -> Cell {
    g.map_or(Cell::Null, |g| Cell::Geometry(g.to_string()))
}

/// Reads data.kml back (readKmlFile): RB-OPEN, RB-KML-STRUCTURE, RB-HEADER, RB-ROWS, RB-VALUES
/// and RB-KML-GEOMETRY.
#[allow(clippy::too_many_arguments)]
pub fn read_back(
    conn: &Connection,
    view: &str,
    columns: &[OutColumn],
    spatial: &Spatial,
    expected: &Expected,
    document_name: &str,
    ordered: bool,
    path: &Path,
    file: &str,
) -> Result<Vec<Value>> {
    let s = source(columns, spatial)
        .ok_or_else(|| EngineError::internal("The KML profile has no places to read back."))?;
    let mut want = ColumnDigest::default();
    each_row(
        conn,
        view,
        columns,
        &source_columns(s),
        ordered,
        &mut |cells| {
            let g = row_geometry(cells).0.map(|g| kml_form(&g));
            want.push(&geometry_cell(g.as_ref()));
            Ok(())
        },
    )?;
    let want = want.finish();
    let bytes = std::fs::read(path)?;
    let mut doc = Reader::default();
    if let Err(e) = crate::xlsx::xml::parse(&bytes, "data.kml", &mut doc) {
        return Ok(vec![check(
            "RB-OPEN",
            false,
            format!(
                "The file does not parse as KML: {}.",
                e.message.trim_end_matches('.')
            ),
            Some(file),
        )]);
    }
    let mut checks = vec![check(
        "RB-OPEN",
        true,
        "The file parses as KML.".into(),
        Some(file),
    )];
    let headers: Vec<String> = expected.columns.iter().map(OutColumn::header).collect();
    let same = |p: &Placemark| {
        p.data.len() == headers.len() && p.data.iter().zip(&headers).all(|((n, _), h)| n == h)
    };
    let mut problems: Vec<String> = Vec::new();
    if doc.root.as_deref() != Some("kml") || doc.namespace.as_deref() != Some(NAMESPACE) {
        problems.push("the root is not a KML 2.2 kml element".into());
    }
    if doc.documents != 1 {
        problems.push(format!(
            "it has {} Document elements instead of one",
            doc.documents
        ));
    }
    if doc.name.as_deref() != Some(document_name) {
        problems.push("the Document is not named after the dataset".into());
    }
    let n = doc.placemarks.len() as u64;
    if n != expected.rows {
        problems.push(format!(
            "it has {n} placemarks instead of {}",
            expected.rows
        ));
    }
    let misnamed = doc.placemarks.iter().filter(|p| !same(p)).count();
    if misnamed > 0 {
        problems.push(format!(
            "{misnamed} placemarks do not hold the columns in order"
        ));
    }
    let doubled = doc.placemarks.iter().filter(|p| p.geometries > 1).count();
    if doubled > 0 {
        problems.push(format!("{doubled} placemarks have more than one geometry"));
    }
    checks.push(if problems.is_empty() {
        check(
            "RB-KML-STRUCTURE",
            true,
            "A KML 2.2 document with one placemark per row, each holding the columns as extended data and at most one geometry.".into(),
            Some(file),
        )
    } else {
        check(
            "RB-KML-STRUCTURE",
            false,
            format!("KML structure problems: {}.", problems.join("; ")),
            Some(file),
        )
    });
    let keys: Vec<String> = doc
        .placemarks
        .first()
        .map(|p| p.data.iter().map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    checks.push(if doc.placemarks.is_empty() || keys == headers {
        check(
            "RB-HEADER",
            true,
            "Every placemark holds the columns with the expected names and units, in order.".into(),
            Some(file),
        )
    } else {
        check(
            "RB-HEADER",
            false,
            format!(
                "The placemark data are {} instead of {}.",
                json!(keys),
                json!(headers)
            ),
            Some(file),
        )
    });
    checks.push(rows_check(n, expected.rows, file));
    let values: Vec<Option<String>> = expected
        .columns
        .iter()
        .enumerate()
        .map(|(j, col)| {
            let mut d = ColumnDigest::default();
            for p in &doc.placemarks {
                let text = p.data.get(j).map_or("", |(_, v)| v.as_str());
                d.push(&retype_text(text, col.kind)?);
            }
            Some(d.finish())
        })
        .collect();
    checks.push(values_check(expected, &values, file));
    let mut got = ColumnDigest::default();
    for p in &doc.placemarks {
        got.push(&geometry_cell(p.geometry.as_ref()));
    }
    checks.push(if got.finish() == want {
        check(
            "RB-KML-GEOMETRY",
            true,
            "Every placemark's geometry matches its row's, coordinate for coordinate.".into(),
            Some(file),
        )
    } else {
        check(
            "RB-KML-GEOMETRY",
            false,
            "The placemark geometries differ from the geometries of the rows.".into(),
            Some(file),
        )
    });
    Ok(checks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_as_the_typescript_writer_does() {
        let mut t = String::new();
        escape_text("a & <b>\r\n", &mut t);
        assert_eq!(t, "a &amp; &lt;b&gt;&#13;\n");
        let mut a = String::new();
        escape_attribute("x\t\"y\"\n", &mut a);
        assert_eq!(a, "x&#9;&quot;y&quot;&#10;");
    }

    #[test]
    fn reads_a_multigeometry_by_its_members() {
        let g = parse(r#"{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[1,2,3,4]}]}"#)
            .unwrap();
        assert_eq!(
            kml_form(&g),
            json!({ "type": "MultiPoint", "coordinates": [[1.0, 2.0, 3.0]] })
        );
        let mut xml = String::new();
        geometry_xml(&g, &mut xml);
        assert_eq!(
            xml,
            "<MultiGeometry><Point><coordinates>1,2,3</coordinates></Point></MultiGeometry>"
        );
    }
}
