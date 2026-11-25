//! KML and KMZ import (src/formats/kml/importer.ts): the same rows, columns, detections and
//! messages. A KMZ's KML document is its first .kml entry at the root, else its first .kml entry
//! anywhere. The document is decoded as its byte-order mark or XML declaration says (UTF-8 by
//! default, UTF-16, ISO-8859-1 and windows-1252 read as windows-1252) and read whole, up to
//! KML_MAX_BYTES; the sniff reads its first MiB, leaving unread what that cuts off, as the
//! TypeScript reader's streaming parser does.
//!
//! Each Placemark is a row located by its index (0-based): `folder`, `name`, `description`,
//! `timestamp`, `begin`, `end` and every ExtendedData Data value and SchemaData SimpleData, as
//! keys in first-seen order, their text as the file holds it; its first geometry beside them as
//! GeoJSON, positions as longitude,latitude[,altitude] on WGS 84.

use crate::error::{EngineError, Result};
use crate::parse::Raw;
use crate::xlsx::xml::{Attrs, Handler, parse_text};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// The largest KML document read, plain or inside a KMZ.
pub const KML_MAX_BYTES: u64 = 512 * 1024 * 1024;
const PREVIEW_MAX_BYTES: usize = 1 << 20;

/// A placemark as a row: its 0-based index, its fields, and its geometry as JSON text.
pub type Row = (u64, Vec<Raw>, Option<String>);

const PARSE_FIX: &str = "Open the file in Google Earth or a GIS tool and save it again as KML, then import the new copy.";

fn parse_failed(why: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The KML file does not parse: {why}."),
        PARSE_FIX,
    )
}

fn too_large() -> EngineError {
    EngineError::new(
        "FORMAT_UNSUPPORTED",
        format!(
            "The KML document is larger than the {} MiB that is read.",
            KML_MAX_BYTES / (1024 * 1024)
        ),
        "Split the layer into smaller files, or export it as FlatGeobuf, then import those.",
    )
}

fn re(cell: &'static OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("a valid pattern"))
}

/// XML whose root element is kml, after any declaration, processing instructions and comments.
pub fn has_kml_root(text: &str) -> bool {
    static ROOT: OnceLock<regex::Regex> = OnceLock::new();
    re(
        &ROOT,
        r"^(?:[ \t\r\n]*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->))*[ \t\r\n]*<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?kml[ \t\r\n/>]",
    )
    .is_match(text)
}

/// The KML entry of a KMZ (kmlEntry): the first .kml at the root, else the first .kml anywhere.
pub fn kml_entry(names: &[String]) -> Option<String> {
    let kml: Vec<&String> = names
        .iter()
        .filter(|n| n.to_lowercase().ends_with(".kml"))
        .collect();
    kml.iter()
        .find(|n| !n.contains('/'))
        .or_else(|| kml.first())
        .map(|n| (*n).clone())
}

fn is_zip(head: &[u8]) -> bool {
    head.starts_with(&[0x50, 0x4B, 0x03, 0x04])
}

/// The KML document's bytes and its entry: a KML file whole, or a KMZ's KML entry inflated.
fn document_of(path: &Path) -> Result<(Vec<u8>, Option<String>)> {
    let mut head = [0u8; 4];
    let size = std::fs::metadata(path)?.len();
    {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let n = f.read(&mut head)?;
        if n < 4 || !is_zip(&head) {
            if size > KML_MAX_BYTES {
                return Err(too_large());
            }
            return Ok((std::fs::read(path)?, None));
        }
    }
    let entries = crate::zip::read_entries(path)
        .map_err(|_| parse_failed("it is not a valid ZIP archive (KMZ)"))?;
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    let Some(entry) = kml_entry(&names) else {
        return Err(parse_failed("the KMZ archive holds no KML document"));
    };
    let e = entries
        .iter()
        .find(|e| e.name == entry)
        .ok_or_else(|| parse_failed("the KMZ archive holds no KML document"))?;
    if e.size > KML_MAX_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(e.size as usize);
    crate::zip::read_entry(path, e, &mut |b| {
        bytes.extend_from_slice(b);
        Ok(())
    })
    .map_err(|_| {
        parse_failed(format!(
            "the KML document {entry} in the KMZ archive is damaged"
        ))
    })?;
    Ok((bytes, Some(entry)))
}

// ---------------------------------------------------------------------------------------------
// Encoding (kmlEncoding)

/// The encoding of a KML document from its byte-order mark, else its XML declaration: the
/// encoding's name, the length of its mark, and the detection.
pub fn kml_encoding(head: &[u8]) -> Result<(&'static str, u64, Value)> {
    let bom = |value: &'static str, length: u64, name: &str| {
        (
            value,
            length,
            crate::detect::det(
                json!(value),
                "high",
                "bom",
                format!("The document starts with a {name} byte-order mark."),
                false,
            ),
        )
    };
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok(bom("utf-8", 3, "UTF-8"));
    }
    if head.starts_with(&[0xFF, 0xFE]) {
        return Ok(bom("utf-16le", 2, "UTF-16 LE"));
    }
    if head.starts_with(&[0xFE, 0xFF]) {
        return Ok(bom("utf-16be", 2, "UTF-16 BE"));
    }
    let start: String = head.iter().take(1024).map(|&b| b as char).collect();
    static DECLARED: OnceLock<regex::Regex> = OnceLock::new();
    let declared = re(
        &DECLARED,
        r#"^<\?xml[^>]*?[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*["']([A-Za-z0-9._-]+)["']"#,
    )
    .captures(&start)
    .and_then(|c| c.get(1))
    .map(|m| m.as_str().to_string());
    let Some(declared) = declared else {
        return Ok((
            "utf-8",
            0,
            crate::detect::det(
                json!("utf-8"),
                "high",
                "xml-default",
                "The XML declaration names no encoding, so the document is UTF-8.",
                false,
            ),
        ));
    };
    let value = match declared.to_lowercase().as_str() {
        "utf-8" | "utf8" | "us-ascii" | "ascii" => "utf-8",
        "iso-8859-1" | "iso8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" => {
            "windows-1252"
        }
        _ => {
            return Err(EngineError::new(
                "FORMAT_UNSUPPORTED",
                format!("The KML file declares the encoding \"{declared}\", which is not read."),
                "Save the file again as UTF-8 KML, then import the new copy.",
            ));
        }
    };
    Ok((
        value,
        0,
        crate::detect::det(
            json!(value),
            "high",
            "xml-declaration",
            format!("The XML declaration names the encoding \"{declared}\"."),
            false,
        ),
    ))
}

fn decode(bytes: &[u8], encoding: &str, bom_length: u64) -> Result<String> {
    let mut decoder = crate::encoding::TextDecoder::new(encoding, bom_length)?;
    let mut out = Vec::with_capacity(bytes.len());
    decoder.decode(bytes, &mut out);
    decoder.finish(&mut out);
    Ok(String::from_utf8(out).unwrap_or_default())
}

// ---------------------------------------------------------------------------------------------
// Placemarks as rows (KmlRows)

/// "lon,lat[,alt]" tuples apart by XML white space; a coordinate that is not a number, or not
/// finite, is null, and -0 is 0 (kmlPositions).
fn positions(text: &str) -> Vec<Value> {
    static NUMBER: OnceLock<regex::Regex> = OnceLock::new();
    let number = re(&NUMBER, r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$");
    text.split([' ', '\t', '\r', '\n'])
        .filter(|t| !t.is_empty())
        .map(|t| {
            Value::Array(
                t.split(',')
                    .map(|x| {
                        if !number.is_match(x) {
                            return Value::Null;
                        }
                        match x.parse::<f64>() {
                            Ok(n) if n.is_finite() => json!(if n == 0.0 { 0.0 } else { n }),
                            _ => Value::Null,
                        }
                    })
                    .collect(),
            )
        })
        .collect()
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

enum Building {
    Simple {
        kind: &'static str,
        positions: Vec<Value>,
    },
    Polygon {
        rings: Vec<Value>,
        outer: bool,
    },
    Multi(Vec<Value>),
}

fn header_of(key: &str) -> String {
    match key {
        "#folder" => "folder".into(),
        "#name" => "name".into(),
        "#description" => "description".into(),
        "#timestamp" => "timestamp".into(),
        "#begin" => "begin".into(),
        "#end" => "end".into(),
        k => k.strip_prefix("data:").unwrap_or(k).to_string(),
    }
}

struct KmlRows<'a> {
    index: HashMap<String, usize>,
    keys: Vec<String>,
    types: Vec<String>,
    path: Vec<String>,
    folders: Vec<Option<String>>,
    values: Option<Vec<Option<String>>>,
    geometry: Option<Value>,
    building: Vec<Building>,
    buffer: Option<String>,
    target: String,
    depth: usize,
    data_name: String,
    count: u64,
    on_row: &'a mut dyn FnMut(Row) -> Result<()>,
}

impl<'a> KmlRows<'a> {
    fn new(on_row: &'a mut dyn FnMut(Row) -> Result<()>) -> Self {
        KmlRows {
            index: HashMap::new(),
            keys: Vec::new(),
            types: Vec::new(),
            path: Vec::new(),
            folders: Vec::new(),
            values: None,
            geometry: None,
            building: Vec::new(),
            buffer: None,
            target: String::new(),
            depth: 0,
            data_name: String::new(),
            count: 0,
            on_row,
        }
    }

    fn header(&self) -> Vec<String> {
        self.keys.iter().map(|k| header_of(k)).collect()
    }

    fn set(&mut self, key: &str, value: String) {
        let Some(values) = self.values.as_mut() else {
            return;
        };
        let i = match self.index.get(key) {
            Some(&i) => i,
            None => {
                let i = self.keys.len();
                self.index.insert(key.to_string(), i);
                self.keys.push(key.to_string());
                i
            }
        };
        if values.len() <= i {
            values.resize(i + 1, None);
        }
        values[i] = Some(value);
    }

    fn collect(&mut self, target: String) {
        if self.buffer.is_some() {
            return;
        }
        self.buffer = Some(String::new());
        self.target = target;
        self.depth = self.path.len();
    }

    fn finish(&mut self, g: Value) {
        if let Some(Building::Multi(members)) = self.building.last_mut() {
            members.push(g);
        } else if self.geometry.is_none() {
            let t = g["type"].as_str().unwrap_or("").to_string();
            if !self.types.contains(&t) {
                self.types.push(t);
            }
            self.geometry = Some(g);
        }
    }
}

const GEOMETRY: [&str; 5] = [
    "Point",
    "LineString",
    "LinearRing",
    "Polygon",
    "MultiGeometry",
];

impl Handler for KmlRows<'_> {
    fn open(&mut self, name: &str, attrs: &Attrs, _self_closing: bool) -> Result<()> {
        if self.path.is_empty() && name != "kml" {
            return Err(parse_failed(format!("its root element is {name}, not kml")));
        }
        let parent = self.path.last().cloned().unwrap_or_default();
        self.path.push(name.to_string());
        if name == "Folder" {
            self.folders.push(None);
            return Ok(());
        }
        if name == "Placemark" {
            self.values = Some(Vec::new());
            self.geometry = None;
            self.building.clear();
            let folder: Vec<&str> = self
                .folders
                .iter()
                .filter_map(|f| f.as_deref())
                .filter(|f| !f.is_empty())
                .collect();
            let folder = folder.join(" / ");
            if !folder.is_empty() {
                self.set("#folder", folder);
            }
            return Ok(());
        }
        if self.values.is_none() {
            if name == "name" && parent == "Folder" {
                self.collect("folder-name".into());
            }
            return Ok(());
        }
        if GEOMETRY.contains(&name) {
            self.building.push(match name {
                "Polygon" => Building::Polygon {
                    rings: Vec::new(),
                    outer: false,
                },
                "MultiGeometry" => Building::Multi(Vec::new()),
                "Point" => Building::Simple {
                    kind: "Point",
                    positions: Vec::new(),
                },
                "LineString" => Building::Simple {
                    kind: "LineString",
                    positions: Vec::new(),
                },
                _ => Building::Simple {
                    kind: "LinearRing",
                    positions: Vec::new(),
                },
            });
            return Ok(());
        }
        match name {
            "name" | "description" if parent == "Placemark" => self.collect(format!("#{name}")),
            "when" if parent == "TimeStamp" => self.collect("#timestamp".into()),
            "begin" | "end" if parent == "TimeSpan" => self.collect(format!("#{name}")),
            "Data" => self.data_name = attrs.get("name").unwrap_or("").to_string(),
            "value" if parent == "Data" => {
                let key = format!("data:{}", self.data_name);
                self.collect(key);
            }
            "SimpleData" if parent == "SchemaData" => {
                self.collect(format!("data:{}", attrs.get("name").unwrap_or("")))
            }
            "coordinates" if !self.building.is_empty() => self.collect("coordinates".into()),
            "outerBoundaryIs" => {
                if let Some(Building::Polygon { outer, .. }) = self.building.last_mut() {
                    *outer = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn text(&mut self, text: &str) -> Result<()> {
        if let Some(b) = self.buffer.as_mut() {
            b.push_str(text);
        }
        Ok(())
    }

    fn close(&mut self, name: &str) -> Result<()> {
        if self.buffer.is_some() && self.path.len() == self.depth {
            let text = self.buffer.take().unwrap_or_default();
            match self.target.as_str() {
                "folder-name" => {
                    if let Some(f) = self.folders.last_mut() {
                        *f = Some(text);
                    }
                }
                "coordinates" => {
                    if let Some(Building::Simple { positions: p, .. }) = self.building.last_mut() {
                        *p = positions(&text);
                    }
                }
                _ => {
                    let key = self.target.clone();
                    self.set(&key, text);
                }
            }
        }
        self.path.pop();
        if name == "Folder" {
            self.folders.pop();
            return Ok(());
        }
        if self.values.is_none() {
            return Ok(());
        }
        if name == "Placemark" {
            let values = self.values.take().unwrap_or_default();
            let fields = (0..self.keys.len())
                .map(|i| {
                    values
                        .get(i)
                        .cloned()
                        .flatten()
                        .map_or(Raw::Null, Raw::Text)
                })
                .collect();
            let geometry = self
                .geometry
                .take()
                .map(|g| crate::canonical::stringify(&g));
            let row = (self.count, fields, geometry);
            self.count += 1;
            return (self.on_row)(row);
        }
        if !GEOMETRY.contains(&name) {
            return Ok(());
        }
        let Some(g) = self.building.pop() else {
            return Ok(());
        };
        match g {
            Building::Simple {
                kind: "Point",
                positions,
            } => {
                let first = positions.into_iter().next().unwrap_or(json!([]));
                self.finish(json!({ "type": "Point", "coordinates": first }));
            }
            Building::Simple {
                kind: "LineString",
                positions,
            } => self.finish(json!({ "type": "LineString", "coordinates": positions })),
            Building::Simple { positions, .. } => {
                if let Some(Building::Polygon { rings, outer }) = self.building.last_mut() {
                    // The outer boundary comes first, however the file orders it.
                    if *outer {
                        rings.insert(0, Value::Array(positions));
                    } else {
                        rings.push(Value::Array(positions));
                    }
                    *outer = false;
                } else {
                    self.finish(json!({ "type": "LineString", "coordinates": positions }));
                }
            }
            Building::Polygon { rings, .. } => {
                self.finish(json!({ "type": "Polygon", "coordinates": rings }))
            }
            Building::Multi(members) => self.finish(multi(members)),
        }
        Ok(())
    }
}

/// Parses KML text, mapping what the XML parser refuses to the KML messages.
fn parse_kml(text: &str, rows: &mut KmlRows, head: bool) -> Result<()> {
    parse_text(text, "doc.kml", rows, head).map_err(|e| {
        if e.message.starts_with("The KML file does not parse") {
            e
        } else if e.message.contains("declares a document type") {
            parse_failed("it declares a document type, which KML never needs")
        } else if e.code == "PARSE_FAILED" {
            parse_failed("it is not well-formed XML")
        } else {
            e
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Sniff and read

pub struct Sniff {
    pub entry: Option<String>,
    pub header: Vec<String>,
    pub detections: Vec<(String, Value)>,
    pub rows: Vec<Row>,
}

/// The sniff (importer.ts sniff): the first MiB of the document, its placemarks as the sample.
pub fn sniff(path: &Path, sample: usize) -> Result<Sniff> {
    let (bytes, entry) = document_of_head(path)?;
    let (head, complete) = bytes;
    let (encoding, bom_length, encoding_detection) = kml_encoding(&head)?;
    let text = decode(&head, encoding, bom_length)?;
    let mut rows: Vec<Row> = Vec::new();
    let mut count = 0u64;
    let mut take = |r: Row| -> Result<()> {
        count += 1;
        if rows.len() < sample {
            rows.push(r);
        }
        Ok(())
    };
    let mut reader = KmlRows::new(&mut take);
    parse_kml(&text, &mut reader, !complete)?;
    let header = reader.header();
    let types = reader.types.clone();
    drop(reader);
    let format_count = crate::csv::format_count;
    let scope = if complete {
        format!("all {} placemarks in the document", format_count(count))
    } else {
        format!(
            "the {} placemarks in the first {} bytes",
            format_count(count),
            format_count(head.len() as u64)
        )
    };
    let confidence = if complete { "high" } else { "medium" };
    let found = if types.is_empty() {
        "no geometry types".to_string()
    } else {
        format!("geometry types {}", types.join(", "))
    };
    let detections = vec![
        ("encoding".to_string(), encoding_detection),
        (
            "crs".to_string(),
            crate::detect::det(
                json!({ "code": "OGC:CRS84", "source": "kml-specification" }),
                "high",
                "kml-specification",
                "KML holds longitude and latitude on WGS 84, as the KML 2.2 specification fixes it.",
                false,
            ),
        ),
        (
            "propertyKeys".to_string(),
            crate::detect::det(
                json!(header),
                confidence,
                "placemark-field-union",
                format!(
                    "The union of placemark fields in first-seen order over {scope}: {} fields.",
                    header.len()
                ),
                false,
            ),
        ),
        (
            "geometryTypes".to_string(),
            crate::detect::det(
                json!(types),
                confidence,
                "geometry-types",
                format!("Found {found} over {scope}."),
                false,
            ),
        ),
    ];
    Ok(Sniff {
        entry,
        header,
        detections,
        rows,
    })
}

type Head = ((Vec<u8>, bool), Option<String>);

/// The first MiB of the document, and whether it is the whole document.
fn document_of_head(path: &Path) -> Result<Head> {
    use std::io::Read;
    let mut head = [0u8; 4];
    let n = std::fs::File::open(path)?.read(&mut head)?;
    if n == 4 && is_zip(&head) {
        let (bytes, entry) = document_of(path)?;
        let complete = bytes.len() <= PREVIEW_MAX_BYTES;
        let mut bytes = bytes;
        bytes.truncate(PREVIEW_MAX_BYTES);
        return Ok(((bytes, complete), entry));
    }
    let size = std::fs::metadata(path)?.len();
    if size > KML_MAX_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(PREVIEW_MAX_BYTES as u64)
        .read_to_end(&mut bytes)?;
    let complete = bytes.len() as u64 >= size;
    Ok(((bytes, complete), None))
}

/// Hashes the file and reads its placemarks as rows (importer.ts read). Returns the notes (none),
/// the SHA-256 and the size.
pub fn read_rows(
    path: &Path,
    send: &mut dyn FnMut(Row) -> Result<()>,
    cancel: &AtomicBool,
    bytes_read: &AtomicU64,
) -> Result<(Vec<crate::csv::Note>, String, u64)> {
    let original = std::fs::read(path)?;
    let size = original.len() as u64;
    bytes_read.store(size, Ordering::Relaxed);
    let digest: String = Sha256::digest(&original)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let (bytes, _) = if is_zip(&original) {
        drop(original);
        document_of(path)?
    } else {
        if size > KML_MAX_BYTES {
            return Err(too_large());
        }
        (original, None)
    };
    let head = &bytes[..bytes.len().min(1024)];
    let (encoding, bom_length, _) = kml_encoding(head)?;
    let text = decode(&bytes, encoding, bom_length)?;
    drop(bytes);
    let mut n = 0u64;
    let mut take = |r: Row| -> Result<()> {
        if n.is_multiple_of(1024) && cancel.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The import was cancelled.",
                "Start the import again when you are ready.",
            ));
        }
        n += 1;
        send(r)
    };
    let mut reader = KmlRows::new(&mut take);
    parse_kml(&text, &mut reader, false)?;
    Ok((Vec::new(), digest, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows_of(text: &str) -> Vec<Row> {
        let mut rows = Vec::new();
        let mut take = |r: Row| -> Result<()> {
            rows.push(r);
            Ok(())
        };
        let mut reader = KmlRows::new(&mut take);
        parse_kml(text, &mut reader, false).ok().unwrap();
        drop(reader);
        rows
    }

    #[test]
    fn reads_placemarks_as_the_typescript_reader_does() {
        let rows = rows_of(
            "<kml><Folder><name>A</name><Placemark><name>P</name><ExtendedData><Data name=\"d\"><value>1</value></Data></ExtendedData><Polygon><innerBoundaryIs><LinearRing><coordinates>1,1 2,1 1,1</coordinates></LinearRing></innerBoundaryIs><outerBoundaryIs><LinearRing><coordinates>0,0 9,0 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Folder><Placemark><MultiGeometry><Point><coordinates>abc,-0</coordinates></Point><Point><coordinates>3,4,5</coordinates></Point></MultiGeometry></Placemark></kml>",
        );
        assert_eq!(
            rows[0].1,
            vec![
                Raw::Text("A".into()),
                Raw::Text("P".into()),
                Raw::Text("1".into())
            ]
        );
        assert_eq!(
            rows[0].2.as_deref(),
            Some(r#"{"type":"Polygon","coordinates":[[[0,0],[9,0],[0,0]],[[1,1],[2,1],[1,1]]]}"#)
        );
        assert_eq!(rows[1].1, vec![Raw::Null, Raw::Null, Raw::Null]);
        assert_eq!(
            rows[1].2.as_deref(),
            Some(r#"{"type":"MultiPoint","coordinates":[[null,0],[3,4,5]]}"#)
        );
    }

    #[test]
    fn finds_the_root_entry_and_the_encoding() {
        let names = ["files/a.kml".to_string(), "doc.kml".to_string()];
        assert_eq!(kml_entry(&names).as_deref(), Some("doc.kml"));
        assert!(has_kml_root(
            "<?xml version=\"1.0\"?>\n<!-- x -->\n<kml:kml xmlns:kml=\"y\">"
        ));
        assert!(!has_kml_root("<gpx>"));
        let latin = b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><kml/>";
        assert_eq!(kml_encoding(latin).ok().map(|e| e.0), Some("windows-1252"));
        assert!(kml_encoding(b"<?xml version=\"1.0\" encoding=\"Shift_JIS\"?>").is_err());
    }
}
