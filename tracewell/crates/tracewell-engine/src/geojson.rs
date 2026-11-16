//! GeoJSON import (src/formats/geojson): a FeatureCollection, whose features are read one at a
//! time, a single Feature, or a bare Geometry, which becomes one feature without properties.
//! Each feature is a row: its properties are the fields, in first-seen key order over the file,
//! and its geometry is carried beside them as the JSON text JavaScript would write for it, kept as
//! the file has it. Whether a geometry is valid is the rules' business (TW-GEO-001).
//!
//! The legacy `crs` member of the 2008 specification is recorded, never applied: no coordinates
//! are transformed. Without one RFC 7946 applies: longitude and latitude on WGS84 (OGC:CRS84).

use crate::csv::format_count;
use crate::detect::det;
use crate::error::{EngineError, Result};
use crate::json::{J, RecordColumns, parse, skip_space, stringify, value_extent};
use crate::parse::Raw;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------------------------
// Errors (errors.ts)

const BROKEN_JSON_FIX: &str = "Open the file in a text editor or GIS tool, correct the JSON (or export the layer again as GeoJSON), then import the new copy.";
const NOT_GEOJSON_FIX: &str = "Import a GeoJSON FeatureCollection, a single Feature or a single Geometry object. Other JSON files can be converted to GeoJSON in a GIS tool first.";

fn broken_json(message: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The GeoJSON file is not valid JSON: {message}"),
        BROKEN_JSON_FIX,
    )
}

fn not_geojson(message: impl Into<String>) -> EngineError {
    EngineError::new("FORMAT_UNSUPPORTED", message, NOT_GEOJSON_FIX)
}

// ---------------------------------------------------------------------------------------------
// The document (parser.ts)

/// The RFC 7946 geometry type names.
const GEOMETRY_TYPES: [&str; 7] = [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
];

/// Top-level members kept for a single Feature, a bare Geometry and the CRS detection.
const ROOT_MEMBERS: [&str; 7] = [
    "type",
    "crs",
    "properties",
    "geometry",
    "coordinates",
    "geometries",
    "bbox",
];

/// One element of the features array (or the single Feature or Geometry), by its 0-based index.
pub struct Feature {
    pub index: u64,
    pub geometry: Option<J>,
    pub properties: Option<J>,
}

#[derive(Clone, Debug, PartialEq)]
enum At {
    /// Before the top-level object.
    Root,
    /// In the top-level object: before the first key, or after a member.
    Object { first: bool },
    /// After a key of the top-level object, before ':' and its value.
    Key(String),
    /// In the features array: before the first element, or after an element.
    Features { first: bool },
    /// In a "features" member that is an object, before its first key.
    MemberKey,
    /// After that key, before ':' and its value, which settles that the member is not an array.
    MemberValue,
    /// After the top-level object: only white space may follow.
    Done,
}

/// Reads a GeoJSON document from text that arrives in pieces. Each feature is parsed on its own
/// and handed over, so memory stays bounded by the largest single feature.
pub struct Scan {
    at: At,
    /// Text not consumed yet.
    buf: Vec<u8>,
    /// The kept top-level members; a repeated one takes its last value.
    root: Vec<(String, J)>,
    count: u64,
    finished: bool,
}

impl Default for Scan {
    fn default() -> Self {
        Scan {
            at: At::Root,
            buf: Vec::new(),
            root: Vec::new(),
            count: 0,
            finished: false,
        }
    }
}

impl Scan {
    /// Features handed over so far.
    pub fn features(&self) -> u64 {
        self.count
    }

    /// The value of the top-level `crs` member, when one was seen.
    pub fn crs(&self) -> Option<&J> {
        self.root_member("crs")
    }

    /// The value of the top-level `type` member, when one was seen.
    pub fn root_type(&self) -> Option<&J> {
        self.root_member("type")
    }

    fn root_member(&self, key: &str) -> Option<&J> {
        self.root.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn broken(&self, reason: impl std::fmt::Display) -> EngineError {
        broken_json(format!(
            "{reason} (after {} features).",
            format_count(self.count)
        ))
    }

    fn element(&self, from: usize, to: usize) -> Result<J> {
        // As the TypeScript reader's TextDecoder: a byte that is not UTF-8 reads as U+FFFD. A
        // value starts and ends on ASCII, so no character is cut.
        let text = String::from_utf8_lossy(&self.buf[from..to]);
        parse(&text).map_err(|e| self.broken(e))
    }

    /// The start of the next item of a container after a value, or None when the text stops
    /// before that item starts.
    fn after_separator(&self, i: usize, first: bool, close: char) -> Result<Option<usize>> {
        if first {
            return Ok(Some(i));
        }
        if self.buf[i] != b',' {
            return Err(self.broken(format!(
                "Expected ',' or '{close}' but found {:?}",
                self.buf[i] as char
            )));
        }
        let j = skip_space(&self.buf, i + 1);
        Ok((j < self.buf.len()).then_some(j))
    }

    /// The key at `j` and where it ends, or None when the text stops inside it.
    fn key_at(&self, j: usize, complete: bool) -> Result<Option<(String, usize)>> {
        if self.buf[j] != b'"' {
            return Err(self.broken(format!(
                "Expected a key but found {:?}",
                self.buf[j] as char
            )));
        }
        let Some(end) = value_extent(&self.buf, j, complete) else {
            return Ok(None);
        };
        match self.element(j, end)? {
            J::Str(key) => Ok(Some((key, end))),
            _ => Err(self.broken("Expected a key")),
        }
    }

    /// The top-level object's start, after white space. JavaScript's white space is wider than
    /// JSON's: such a character before the object is not valid JSON, and before anything else the
    /// file is simply not a GeoJSON object.
    fn root_start(&self, complete: bool) -> Result<Option<usize>> {
        let text = String::from_utf8_lossy(&self.buf);
        let mut stray = false;
        for (i, ch) in text.char_indices() {
            if matches!(ch, ' ' | '\t' | '\n' | '\r') {
                continue;
            }
            if crate::units::is_js_space(ch) || ch == '\u{FEFF}' {
                stray = true;
                continue;
            }
            if ch != '{' {
                return Err(not_geojson(
                    "The file is JSON but not a GeoJSON object: its top level is not an object.",
                ));
            }
            if stray {
                return Err(self.broken("Unexpected white space before the GeoJSON object"));
            }
            return Ok(Some(i));
        }
        if stray && complete {
            return Err(self.broken("Unexpected white space where the GeoJSON object should be"));
        }
        Ok(None)
    }

    fn run(&mut self, complete: bool, out: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        let mut i = 0;
        loop {
            if self.at == At::Root {
                match self.root_start(complete)? {
                    Some(start) => {
                        i = start + 1;
                        self.at = At::Object { first: true };
                    }
                    None => {
                        // White space only so far: nothing of it is needed again.
                        if self
                            .buf
                            .iter()
                            .all(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
                        {
                            i = self.buf.len();
                        }
                        break;
                    }
                }
                continue;
            }
            i = skip_space(&self.buf, i);
            if i >= self.buf.len() {
                break;
            }
            let c = self.buf[i];
            match self.at.clone() {
                At::Root => unreachable!("the root is handled above"),
                At::Object { .. } if c == b'}' => {
                    i += 1;
                    self.at = At::Done;
                }
                At::Object { first } => {
                    let Some(j) = self.after_separator(i, first, '}')? else {
                        break;
                    };
                    let Some((key, end)) = self.key_at(j, complete)? else {
                        break;
                    };
                    i = end;
                    self.at = At::Key(key);
                }
                At::Key(key) => {
                    if c != b':' {
                        return Err(self.broken(format!("Expected ':' but found {:?}", c as char)));
                    }
                    let j = skip_space(&self.buf, i + 1);
                    let Some(&v) = self.buf.get(j) else {
                        break;
                    };
                    if key == "features" && v == b'[' {
                        i = j + 1;
                        self.at = At::Features { first: true };
                        continue;
                    }
                    if key == "features" && v == b'{' {
                        i = j + 1;
                        self.at = At::MemberKey;
                        continue;
                    }
                    let Some(end) = value_extent(&self.buf, j, complete) else {
                        break;
                    };
                    // Every value is parsed, kept or not: the document must be JSON throughout.
                    let value = self.element(j, end)?;
                    if ROOT_MEMBERS.contains(&key.as_str()) {
                        match self.root.iter_mut().find(|(k, _)| *k == key) {
                            Some(slot) => slot.1 = value,
                            None => self.root.push((key, value)),
                        }
                    }
                    i = end;
                    self.at = At::Object { first: false };
                }
                At::Features { .. } if c == b']' => {
                    i += 1;
                    self.at = At::Object { first: false };
                }
                At::Features { first } => {
                    let Some(j) = self.after_separator(i, first, ']')? else {
                        break;
                    };
                    let Some(end) = value_extent(&self.buf, j, complete) else {
                        break;
                    };
                    let value = self.element(j, end)?;
                    i = end;
                    self.at = At::Features { first: false };
                    // A "features" array is a foreign member when the type, already seen, says
                    // Feature or Geometry.
                    let foreign = self
                        .root_member("type")
                        .is_some_and(|t| !matches!(t, J::Str(t) if t == "FeatureCollection"));
                    if !foreign {
                        self.emit(value, out)?;
                    }
                }
                At::MemberKey if c == b'}' => {
                    i += 1;
                    self.at = At::Object { first: false };
                }
                At::MemberKey => {
                    let Some((_, end)) = self.key_at(i, complete)? else {
                        break;
                    };
                    i = end;
                    self.at = At::MemberValue;
                }
                At::MemberValue => {
                    if c != b':' {
                        return Err(self.broken(format!("Expected ':' but found {:?}", c as char)));
                    }
                    let j = skip_space(&self.buf, i + 1);
                    if j >= self.buf.len() {
                        break;
                    }
                    let Some(end) = value_extent(&self.buf, j, complete) else {
                        break;
                    };
                    self.element(j, end)?;
                    return Err(not_geojson("The \"features\" member is not an array."));
                }
                At::Done => {
                    return Err(self.broken(format!(
                        "Unexpected text after the JSON value: {:?}",
                        c as char
                    )));
                }
            }
        }
        self.buf.drain(..i.min(self.buf.len()));
        Ok(())
    }

    fn emit(&mut self, value: J, out: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        let (mut geometry, mut properties) = (None, None);
        if let J::Obj(members) = value {
            for (k, v) in members {
                match k.as_str() {
                    "geometry" => geometry = Some(v),
                    "properties" => properties = Some(v),
                    _ => {}
                }
            }
        }
        out(Feature {
            index: self.count,
            geometry,
            properties,
        })?;
        self.count += 1;
        Ok(())
    }

    /// Adds text and hands over every feature it completes.
    pub fn push(&mut self, text: &[u8], out: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        self.buf.extend_from_slice(text);
        self.run(false, out)
    }

    /// Ends the document: checks it was complete and hands over the single Feature or Geometry.
    pub fn finish(&mut self, out: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        self.run(true, out)?;
        match self.at {
            At::Root => {
                return Err(not_geojson(
                    "The file is empty: it holds no GeoJSON object.",
                ));
            }
            At::Done => {}
            _ => return Err(self.broken("Unexpected end of JSON input")),
        }
        let kind = match self.root_member("type") {
            Some(J::Str(t)) => Some(t.clone()),
            _ => None,
        };
        let Some(kind) = kind else {
            return Err(not_geojson(
                "The top-level object has no \"type\" member, so it is not a GeoJSON object.",
            ));
        };
        if kind == "FeatureCollection" {
            return Ok(());
        }
        let feature = kind == "Feature";
        if !feature && !GEOMETRY_TYPES.contains(&kind.as_str()) {
            return Err(not_geojson(format!(
                "The top-level object has type \"{kind}\", which is not a GeoJSON object type."
            )));
        }
        if self.count > 0 {
            return Err(not_geojson(format!(
                "The top-level object is a {kind} but also holds a \"features\" array before its type."
            )));
        }
        let single = if feature {
            let mut members = Vec::new();
            for key in ["geometry", "properties"] {
                if let Some(v) = self.root_member(key) {
                    members.push((key.to_string(), v.clone()));
                }
            }
            J::Obj(members)
        } else {
            // The bare geometry with its members in the RFC 7946 order: type, then coordinates or
            // geometries, then bbox.
            let mut geometry = vec![("type".to_string(), J::Str(kind))];
            for key in ["coordinates", "geometries", "bbox"] {
                if let Some(v) = self.root_member(key) {
                    geometry.push((key.to_string(), v.clone()));
                }
            }
            J::Obj(vec![("geometry".to_string(), J::Obj(geometry))])
        };
        self.emit(single, out)
    }
}

// ---------------------------------------------------------------------------------------------
// Rows (rows.ts)

/// A feature as a row: its 0-based index, one field per property key seen so far, and its
/// geometry as JSON text (None when the feature has none).
pub type Row = (u64, Vec<Raw>, Option<String>);

/// Feature properties as table rows, with what the features' geometries are.
#[derive(Default)]
pub struct PropertyColumns {
    pub properties: RecordColumns,
    /// Geometry types in first-seen order.
    pub geometry_types: Vec<String>,
    /// Features whose geometry is null, missing or not an object with a type.
    pub without_geometry: u64,
}

impl PropertyColumns {
    pub fn row_of(&mut self, feature: Feature) -> Row {
        let fields = match &feature.properties {
            Some(J::Obj(members)) => self.properties.row_of(members),
            _ => self.properties.row_of(&[]),
        };
        // Kept as written: an object with a type name is a geometry, valid or not.
        let kind = match &feature.geometry {
            Some(J::Obj(members)) => members.iter().find_map(|(k, v)| match v {
                J::Str(t) if k == "type" => Some(t.clone()),
                _ => None,
            }),
            _ => None,
        };
        let geometry = match (kind, &feature.geometry) {
            (Some(kind), Some(g)) => {
                if !self.geometry_types.contains(&kind) {
                    self.geometry_types.push(kind);
                }
                Some(stringify(g))
            }
            _ => {
                self.without_geometry += 1;
                None
            }
        };
        (feature.index, fields, geometry)
    }
}

// ---------------------------------------------------------------------------------------------
// CRS (crs.ts)

/// Largest code accepted as an EPSG code; anything longer is not an EPSG identifier.
const MAX_EPSG_CODE: f64 = 999_999.0;

fn epsg_code(text: &str) -> Option<String> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: f64 = text.parse().ok()?;
    (n > 0.0 && n <= MAX_EPSG_CODE).then(|| format!("EPSG:{}", n as u64))
}

/// Named CRS forms that are longitude and latitude on a WGS84-compatible datum, and the OGC
/// names for the NAD datums.
fn ogc_name(name: &str) -> Option<String> {
    match name.to_uppercase().as_str() {
        "CRS84" => Some("OGC:CRS84".into()),
        "CRS83" => Some("EPSG:4269".into()),
        "CRS27" => Some("EPSG:4267".into()),
        _ => None,
    }
}

fn is_code(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn authority(text: &str) -> Option<&'static str> {
    if text.eq_ignore_ascii_case("EPSG") {
        Some("EPSG")
    } else if text.eq_ignore_ascii_case("OGC") {
        Some("OGC")
    } else {
        None
    }
}

/// Strips an ASCII prefix without regard to case.
fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// The authority and code of a CRS name in one of the forms seen in the wild: the OGC URN (with
/// or without a version), the OGC HTTP URI, and the short 'EPSG:n' form.
fn name_parts(name: &str) -> Option<(&'static str, &str)> {
    if let Some(rest) = strip_prefix_ci(name, "urn:ogc:def:crs:") {
        // authority ':' version (without a colon) ':' code
        let mut parts = rest.splitn(3, ':');
        let (a, version, code) = (parts.next()?, parts.next()?, parts.next()?);
        let _ = version;
        return (is_code(code))
            .then(|| authority(a))
            .flatten()
            .map(|a| (a, code));
    }
    for scheme in ["http://", "https://"] {
        if let Some(rest) = strip_prefix_ci(name, scheme)
            && let Some(rest) = strip_prefix_ci(rest, "www.opengis.net/def/crs/")
        {
            // authority '/' version (at least one character, without a slash) '/' code
            let mut parts = rest.splitn(3, '/');
            let (a, version, code) = (parts.next()?, parts.next()?, parts.next()?);
            return (!version.is_empty() && is_code(code))
                .then(|| authority(a))
                .flatten()
                .map(|a| (a, code));
        }
    }
    // 'EPSG:4326' or 'EPSG::4326'
    let (a, code) = name.split_once(':')?;
    let code = code.strip_prefix(':').unwrap_or(code);
    is_code(code)
        .then(|| authority(a))
        .flatten()
        .map(|a| (a, code))
}

/// The CRS code a 2008-style CRS name stands for, or None when the name is not recognised.
fn crs_code_from_name(name: &str) -> Option<String> {
    let trimmed = name.trim_matches(|c| crate::units::is_js_space(c) || c == '\u{FEFF}');
    if let Some(code) = ogc_name(trimmed) {
        return Some(code);
    }
    let (authority, code) = name_parts(trimmed)?;
    if authority == "EPSG" {
        epsg_code(code)
    } else {
        ogc_name(code)
    }
}

fn crs_value(code: &str, source: &str) -> Value {
    json!({ "code": code, "source": source })
}

fn found(code: &str, evidence: String) -> Value {
    det(
        crs_value(code, "geojson-crs-member"),
        "high",
        "geojson-crs-member",
        evidence,
        false,
    )
}

fn unknown_crs(evidence: &str) -> Value {
    det(
        crs_value("unknown", "geojson-crs-member"),
        "low",
        "geojson-crs-member",
        evidence,
        false,
    )
}

fn object_member<'a>(v: &'a J, key: &str) -> Option<&'a J> {
    match v {
        J::Obj(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// The detection for the value of a top-level `crs` member. A null member means "no CRS can be
/// assumed" in the 2008 specification, so it is reported as unknown rather than as the default.
fn crs_detection_of(crs: &J) -> Value {
    if matches!(crs, J::Null) {
        return unknown_crs(
            "The legacy \"crs\" member is null, which declares that no CRS can be assumed.",
        );
    }
    let property = |key: &str| {
        object_member(crs, "properties")
            .filter(|p| matches!(p, J::Obj(_)))
            .and_then(|p| object_member(p, key))
    };
    match object_member(crs, "type") {
        Some(J::Str(t)) if t == "name" => match property("name") {
            Some(J::Str(name)) => match crs_code_from_name(name) {
                Some(code) => found(
                    &code,
                    format!("The legacy \"crs\" member names \"{name}\" ({code})."),
                ),
                None => unknown_crs(&format!(
                    "The legacy \"crs\" member names \"{name}\", which is not a recognised CRS name."
                )),
            },
            _ => unknown_crs("The legacy \"crs\" member is of type \"name\" but gives no name."),
        },
        Some(J::Str(t)) if t == "EPSG" => {
            // The code as JavaScript's String() writes it.
            let text = match property("code") {
                Some(J::Num(n)) if n.is_finite() => Some(crate::canonical::canonical_number(*n)),
                Some(J::Num(n)) => Some(if *n > 0.0 { "Infinity" } else { "-Infinity" }.into()),
                Some(J::Str(s)) => Some(s.clone()),
                _ => None,
            };
            match text
                .as_deref()
                .and_then(|t| epsg_code(t).map(|code| (t, code)))
            {
                Some((text, code)) => found(
                    &code,
                    format!("The legacy \"crs\" member gives EPSG code {text} ({code})."),
                ),
                None => unknown_crs(
                    "The legacy \"crs\" member is of type \"EPSG\" but its code is not valid.",
                ),
            }
        }
        Some(J::Str(t)) if t == "link" => unknown_crs(
            "The legacy \"crs\" member links to an external CRS definition, which is not read.",
        ),
        _ => unknown_crs("The legacy \"crs\" member has a form that is not recognised."),
    }
}

// ---------------------------------------------------------------------------------------------
// Sniff (importer.ts)

/// What the head of a GeoJSON file shows: its rows and the detections after the encoding.
pub struct Head {
    pub keys: Vec<String>,
    pub rows: Vec<Row>,
    pub detections: Vec<(String, Value)>,
}

/// Reads the head of a file (decoded text of its first `bytes` bytes) for the preview: at most
/// `sample` rows, the property keys, the geometry types, the nested properties and the CRS.
pub fn sniff(text: &str, bytes: u64, complete: bool, sample: usize) -> Result<Head> {
    let mut scan = Scan::default();
    let mut columns = PropertyColumns::default();
    let mut rows: Vec<Row> = Vec::new();
    {
        let mut take = |f: Feature| -> Result<()> {
            let row = columns.row_of(f);
            if rows.len() < sample {
                rows.push(row);
            }
            Ok(())
        };
        scan.push(text.as_bytes(), &mut take)?;
        // A cut-off head ends mid-document by design; only a whole file must be a complete document.
        if complete {
            scan.finish(&mut take)?;
        }
    }
    let features = format!("{} features", format_count(scan.features()));
    let scope = if complete {
        format!("all {features} in the file")
    } else {
        format!("the {features} in the first {} bytes", format_count(bytes))
    };
    let confidence = if complete { "high" } else { "medium" };
    let crs = match scan.crs() {
        Some(crs) => crs_detection_of(crs),
        None => {
            let place = if complete {
                "The file".to_string()
            } else {
                format!("The first {} bytes of the file", format_count(bytes))
            };
            let evidence = format!(
                "{place} hold no \"crs\" member, so RFC 7946 applies: longitude and latitude on WGS84 (OGC:CRS84)."
            );
            let mut d = det(
                crs_value("OGC:CRS84", "rfc7946-default"),
                "high",
                "rfc7946-default",
                evidence,
                false,
            );
            // A legacy member normally precedes the features, so once they have started its
            // absence is settled.
            if !complete && scan.features() == 0 {
                d["confidence"] = json!("medium");
                d["assumed"] = json!(true);
            }
            d
        }
    };
    let keys = columns.properties.keys.clone();
    let types = &columns.geometry_types;
    let listed = if types.is_empty() {
        "no geometry types".to_string()
    } else {
        format!("geometry types {}", types.join(", "))
    };
    let mut detections = vec![
        ("crs".to_string(), crs),
        (
            "propertyKeys".to_string(),
            det(
                json!(keys),
                confidence,
                "property-key-union",
                format!(
                    "The union of property keys in first-seen order over {scope}: {} keys.",
                    keys.len()
                ),
                false,
            ),
        ),
        (
            "geometryTypes".to_string(),
            det(
                json!(types),
                confidence,
                "geometry-types",
                format!(
                    "Found {listed} over {scope}; {} features have no geometry.",
                    format_count(columns.without_geometry)
                ),
                false,
            ),
        ),
    ];
    let nested = columns.properties.nested_keys();
    if !nested.is_empty() {
        let quoted: Vec<String> = nested.iter().map(|k| format!("\"{k}\"")).collect();
        detections.push((
            "nestedProperties".to_string(),
            det(
                json!(nested),
                "medium",
                "json-text",
                format!(
                    "The properties {} hold objects or arrays; they are kept as JSON text in text columns.",
                    quoted.join(", ")
                ),
                false,
            ),
        ));
    }
    Ok(Head {
        keys,
        rows,
        detections,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows_of(text: &str, piece: usize) -> Result<(Vec<Row>, PropertyColumns)> {
        let mut scan = Scan::default();
        let mut columns = PropertyColumns::default();
        let mut rows = Vec::new();
        let mut take = |f: Feature| -> Result<()> {
            rows.push(columns.row_of(f));
            Ok(())
        };
        for chunk in text.as_bytes().chunks(piece.max(1)) {
            scan.push(chunk, &mut take)?;
        }
        scan.finish(&mut take)?;
        Ok((rows, columns))
    }

    const COLLECTION: &str = r#" {"type": "FeatureCollection", "name": "wells", "features": [
      {"type":"Feature","properties":{"well":"A-1","depth":1200.5},"geometry":{"type":"Point","coordinates":[2.5,57.1]}},
      {"type":"Feature","properties":{"depth":null,"tags":["x",1],"well":"B-2"},"geometry":null},
      {"type":"Feature","properties":null,"geometry":{"coordinates":[1,2],"type":"Point"}},
      7
    ], "crs": {"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::27700"}}}"#;

    #[test]
    fn reads_features_in_pieces_of_any_size() {
        let (whole, _) = rows_of(COLLECTION, usize::MAX).unwrap();
        for piece in [1, 2, 3, 7, 64] {
            let (rows, columns) = rows_of(COLLECTION, piece).unwrap();
            assert_eq!(rows, whole, "pieces of {piece}");
            assert_eq!(columns.properties.keys, ["well", "depth", "tags"]);
            assert_eq!(columns.geometry_types, ["Point"]);
            assert_eq!(columns.without_geometry, 2);
        }
        assert_eq!(
            whole,
            vec![
                (
                    0,
                    vec![Raw::Text("A-1".into()), Raw::Number(1200.5)],
                    Some(r#"{"type":"Point","coordinates":[2.5,57.1]}"#.to_string())
                ),
                (
                    1,
                    vec![
                        Raw::Text("B-2".into()),
                        Raw::Null,
                        Raw::Text(r#"["x",1]"#.into())
                    ],
                    None
                ),
                // The geometry keeps its members in the order the file has them.
                (
                    2,
                    vec![Raw::Null, Raw::Null, Raw::Null],
                    Some(r#"{"coordinates":[1,2],"type":"Point"}"#.to_string())
                ),
                (3, vec![Raw::Null, Raw::Null, Raw::Null], None),
            ]
        );
    }

    #[test]
    fn reads_a_single_feature_and_a_bare_geometry() {
        let (rows, _) = rows_of(
            r#"{"geometry":{"type":"Point","coordinates":[1,2]},"properties":{"a":1},"type":"Feature"}"#,
            5,
        )
        .unwrap();
        assert_eq!(
            rows,
            vec![(
                0,
                vec![Raw::Number(1.0)],
                Some(r#"{"type":"Point","coordinates":[1,2]}"#.to_string())
            )]
        );
        // A bare geometry's members come in the RFC 7946 order whatever the file's.
        let (rows, _) = rows_of(
            r#"{"bbox":[0,0,1,1],"coordinates":[[0,0],[1,1]],"type":"LineString"}"#,
            4,
        )
        .unwrap();
        assert_eq!(
            rows,
            vec![(
                0,
                vec![],
                Some(
                    r#"{"type":"LineString","coordinates":[[0,0],[1,1]],"bbox":[0,0,1,1]}"#
                        .to_string()
                )
            )]
        );
    }

    #[test]
    fn refuses_what_is_not_geojson() {
        let refusal = |text: &str| {
            let e = rows_of(text, usize::MAX).err().expect("a refusal");
            (e.code, e.message)
        };
        assert_eq!(
            refusal("[1, 2]"),
            (
                "FORMAT_UNSUPPORTED",
                "The file is JSON but not a GeoJSON object: its top level is not an object.".into()
            )
        );
        assert_eq!(
            refusal("  \n "),
            (
                "FORMAT_UNSUPPORTED",
                "The file is empty: it holds no GeoJSON object.".into()
            )
        );
        assert_eq!(
            refusal(r#"{"a": 1}"#).1,
            "The top-level object has no \"type\" member, so it is not a GeoJSON object."
        );
        assert_eq!(
            refusal(r#"{"type": "Topology"}"#).1,
            "The top-level object has type \"Topology\", which is not a GeoJSON object type."
        );
        assert_eq!(
            refusal(r#"{"type":"FeatureCollection","features":{"a":1}}"#).1,
            "The \"features\" member is not an array."
        );
        assert_eq!(
            refusal(r#"{"features":[{}],"type":"Feature"}"#).1,
            "The top-level object is a Feature but also holds a \"features\" array before its type."
        );
        assert_eq!(
            refusal(r#"{"type":"FeatureCollection","features":[{"a":1},{"b":"#).0,
            "PARSE_FAILED"
        );
        assert!(
            refusal(r#"{"type":"FeatureCollection","features":[{}]} x"#)
                .1
                .ends_with("(after 1 features).")
        );
        // A features array after a type that is not FeatureCollection is a foreign member.
        let (rows, _) = rows_of(
            r#"{"type":"Point","coordinates":[1,2],"features":[{},{}]}"#,
            usize::MAX,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        // An empty features object and a scalar are no features at all.
        for text in [
            r#"{"type":"FeatureCollection","features":{}}"#,
            r#"{"type":"FeatureCollection","features":null}"#,
        ] {
            assert_eq!(rows_of(text, 3).unwrap().0, vec![]);
        }
    }

    #[test]
    fn reads_legacy_crs_names() {
        let code = |name: &str| crs_code_from_name(name);
        assert_eq!(
            code("urn:ogc:def:crs:OGC:1.3:CRS84").as_deref(),
            Some("OGC:CRS84")
        );
        assert_eq!(
            code("urn:ogc:def:crs:EPSG::27700").as_deref(),
            Some("EPSG:27700")
        );
        assert_eq!(
            code(" URN:OGC:DEF:CRS:epsg:6.6:04326 ").as_deref(),
            Some("EPSG:4326")
        );
        assert_eq!(
            code("http://www.opengis.net/def/crs/EPSG/0/3857").as_deref(),
            Some("EPSG:3857")
        );
        assert_eq!(
            code("https://www.opengis.net/def/crs/OGC/1.3/CRS83").as_deref(),
            Some("EPSG:4269")
        );
        assert_eq!(code("EPSG:4326").as_deref(), Some("EPSG:4326"));
        assert_eq!(code("epsg::23031").as_deref(), Some("EPSG:23031"));
        assert_eq!(code("crs84").as_deref(), Some("OGC:CRS84"));
        assert_eq!(code("OGC:CRS27").as_deref(), Some("EPSG:4267"));
        for unknown in [
            "EPSG:0",
            "EPSG:1234567",
            "EPSG:abc",
            "urn:ogc:def:crs:EPSG:4326",
            "http://www.opengis.net/def/crs/EPSG//4326",
            "WGS84",
            "EPSG:::4326",
            "",
        ] {
            assert_eq!(code(unknown), None, "{unknown}");
        }
        let detection = |text: &str| crs_detection_of(&parse(text).unwrap());
        let named = detection(r#"{"type":"name","properties":{"name":"EPSG:27700"}}"#);
        assert_eq!(named["value"]["code"], "EPSG:27700");
        assert_eq!(named["assumed"], false);
        let epsg = detection(r#"{"type":"EPSG","properties":{"code":4326}}"#);
        assert_eq!(
            epsg["evidence"],
            "The legacy \"crs\" member gives EPSG code 4326 (EPSG:4326)."
        );
        for (text, evidence) in [
            (
                "null",
                "The legacy \"crs\" member is null, which declares that no CRS can be assumed.",
            ),
            (
                r#"{"type":"link","properties":{"href":"x"}}"#,
                "The legacy \"crs\" member links to an external CRS definition, which is not read.",
            ),
            (
                r#"{"type":"name","properties":{}}"#,
                "The legacy \"crs\" member is of type \"name\" but gives no name.",
            ),
            (
                r#"{"type":"EPSG","properties":{"code":"x"}}"#,
                "The legacy \"crs\" member is of type \"EPSG\" but its code is not valid.",
            ),
            (
                "5",
                "The legacy \"crs\" member has a form that is not recognised.",
            ),
        ] {
            let d = detection(text);
            assert_eq!(d["evidence"], evidence);
            assert_eq!(d["value"]["code"], "unknown");
            assert_eq!(d["assumed"], true);
        }
    }

    #[test]
    fn sniffs_the_head_of_a_file() {
        let head = sniff(COLLECTION, COLLECTION.len() as u64, true, 2).unwrap();
        assert_eq!(head.keys, ["well", "depth", "tags"]);
        assert_eq!(head.rows.len(), 2);
        let names: Vec<&str> = head.detections.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            ["crs", "propertyKeys", "geometryTypes", "nestedProperties"]
        );
        assert_eq!(head.detections[0].1["value"]["code"], "EPSG:27700");
        assert_eq!(
            head.detections[2].1["evidence"],
            "Found geometry types Point over all 4 features in the file; 2 features have no geometry."
        );
        // A head cut off before any feature leaves the CRS open.
        let cut = &COLLECTION[..30];
        let head = sniff(cut, 30, false, 2).unwrap();
        assert_eq!(head.detections[0].1["confidence"], "medium");
        assert_eq!(head.detections[0].1["assumed"], true);
        assert_eq!(
            head.detections[0].1["evidence"],
            "The first 30 bytes of the file hold no \"crs\" member, so RFC 7946 applies: longitude and latitude on WGS84 (OGC:CRS84)."
        );
    }
}
