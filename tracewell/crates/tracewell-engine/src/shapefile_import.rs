//! Shapefile import (src/formats/shapefile/importer.ts): a ZIP archive holding a Shapefile, read
//! in memory, with the same rows, detections and messages. The .shp is the archive's first .shp
//! at the root, else its first anywhere, and its .dbf, .prj and .cpg share its name in any case.
//! Each record is a row located by its index (0-based): the .dbf fields, then the shape as
//! GeoJSON. Polygon rings are grouped as the format orders them (a clockwise ring starts a
//! polygon, the rings after it are its holes); Z types keep their heights; measures are not read.

use crate::error::{EngineError, Result};
use crate::parse::Raw;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// The largest .shp and .dbf read together.
pub const SHAPEFILE_IMPORT_MAX_BYTES: u64 = 1 << 30;

/// A record as a row: its 0-based index, its fields, and its shape as JSON text.
pub type Row = (u64, Vec<Raw>, Option<String>);

const PARSE_FIX: &str = "Export the layer again as a Shapefile from the GIS tool, zip its files together, then import the archive.";

fn parse_failed(why: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The Shapefile does not parse: {why}."),
        PARSE_FIX,
    )
}

fn re(cell: &'static OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("a valid pattern"))
}

/// The .shp of an archive (shpEntry): the first at the root, else the first anywhere.
pub fn shp_entry(names: &[String]) -> Option<String> {
    let shp: Vec<&String> = names
        .iter()
        .filter(|n| n.to_lowercase().ends_with(".shp"))
        .collect();
    shp.iter()
        .find(|n| !n.contains('/'))
        .or_else(|| shp.first())
        .map(|n| (*n).clone())
}

struct Parts {
    entry: String,
    shp: Vec<u8>,
    dbf: Option<Vec<u8>>,
    prj: Option<Vec<u8>>,
    cpg: Option<Vec<u8>>,
}

fn parts_of(path: &Path) -> Result<Parts> {
    use std::io::Read;
    let mut head = [0u8; 4];
    let n = std::fs::File::open(path)?.read(&mut head)?;
    if n == 4 && head == [0x00, 0x00, 0x27, 0x0A] {
        return Err(EngineError::new(
            "FORMAT_UNSUPPORTED",
            "A Shapefile is several files (.shp, .dbf, .prj and others), and this is its .shp alone.",
            "Put the Shapefile\u{2019}s files in one ZIP archive and import the archive.",
        ));
    }
    let entries = crate::zip::read_entries(path)
        .map_err(|_| parse_failed("it is not a valid ZIP archive"))?;
    let files: Vec<&crate::zip::Entry> =
        entries.iter().filter(|e| !e.name.ends_with('/')).collect();
    let names: Vec<String> = files.iter().map(|e| e.name.clone()).collect();
    let Some(entry) = shp_entry(&names) else {
        return Err(parse_failed("the ZIP archive holds no .shp file"));
    };
    let base = entry[..entry.len() - 4].to_lowercase();
    let sibling = |ext: &str| {
        files
            .iter()
            .find(|e| e.name.to_lowercase() == format!("{base}.{ext}"))
            .copied()
    };
    let shp = files
        .iter()
        .find(|e| e.name == entry)
        .copied()
        .ok_or_else(|| parse_failed("the ZIP archive holds no .shp file"))?;
    let dbf = sibling("dbf");
    if shp.size + dbf.map_or(0, |d| d.size) > SHAPEFILE_IMPORT_MAX_BYTES {
        return Err(EngineError::new(
            "FORMAT_UNSUPPORTED",
            format!(
                "The Shapefile's .shp and .dbf are larger than the {} GiB that is read.",
                SHAPEFILE_IMPORT_MAX_BYTES >> 30
            ),
            "Export the layer as FlatGeobuf, or split it into smaller Shapefiles, then import those.",
        ));
    }
    let read = |e: Option<&crate::zip::Entry>| -> Result<Option<Vec<u8>>> {
        let Some(e) = e else { return Ok(None) };
        let mut out = Vec::with_capacity(e.size as usize);
        crate::zip::read_entry(path, e, &mut |b| {
            out.extend_from_slice(b);
            Ok(())
        })
        .map_err(|_| parse_failed(format!("{} in the ZIP archive is damaged", e.name)))?;
        Ok(Some(out))
    };
    Ok(Parts {
        shp: read(Some(shp))?.unwrap_or_default(),
        dbf: read(dbf)?,
        prj: read(sibling("prj"))?,
        cpg: read(sibling("cpg"))?,
        entry,
    })
}

// ---------------------------------------------------------------------------------------------
// Shapes (.shp)

fn f64_at(b: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(b[at..at + 8].try_into().unwrap_or([0; 8]))
}

fn i32_le(b: &[u8], at: usize) -> i32 {
    i32::from_le_bytes(b[at..at + 4].try_into().unwrap_or([0; 4]))
}

fn i32_be(b: &[u8], at: usize) -> i32 {
    i32::from_be_bytes(b[at..at + 4].try_into().unwrap_or([0; 4]))
}

/// A number as it is kept: what is not finite is null, -0 is 0.
fn settled(x: f64) -> Value {
    if x.is_finite() {
        json!(if x == 0.0 { 0.0 } else { x })
    } else {
        Value::Null
    }
}

/// Twice the signed area of a ring, a null coordinate counting as 0 as JavaScript counts it.
fn ring_area(ring: &[Value]) -> f64 {
    let n = |p: &Value, k: usize| p[k].as_f64().unwrap_or(0.0);
    ring.windows(2)
        .map(|w| n(&w[0], 0) * n(&w[1], 1) - n(&w[1], 0) * n(&w[0], 1))
        .sum()
}

fn shape_of(c: &[u8], n: usize) -> Result<Option<Value>> {
    let damaged = || parse_failed(format!("record {n} of the .shp file is damaged"));
    let need = |end: i64| {
        if end > c.len() as i64 {
            Err(damaged())
        } else {
            Ok(())
        }
    };
    if c.len() < 4 {
        return Ok(None);
    }
    let typ = i32_le(c, 0);
    let z = matches!(typ, 11 | 13 | 15 | 18);
    let at = |i: usize, z_at: Option<usize>| -> Value {
        let mut p = vec![settled(f64_at(c, i)), settled(f64_at(c, i + 8))];
        if let Some(k) = z_at {
            p.push(settled(f64_at(c, k)));
        }
        Value::Array(p)
    };
    Ok(match typ {
        0 | 31 => None,
        1 | 11 | 21 => {
            need(if typ == 11 { 28 } else { 20 })?;
            Some(json!({ "type": "Point", "coordinates": at(4, (typ == 11).then_some(20)) }))
        }
        8 | 18 | 28 => {
            need(40)?;
            let count = i32_le(c, 36) as i64;
            if count < 0 {
                return Err(damaged());
            }
            need(40 + 16 * count + if z { 16 + 8 * count } else { 0 })?;
            let z_start = (40 + 16 * count + 16) as usize;
            let points: Vec<Value> = (0..count as usize)
                .map(|i| at(40 + 16 * i, z.then_some(z_start + 8 * i)))
                .collect();
            Some(json!({ "type": "MultiPoint", "coordinates": points }))
        }
        3 | 13 | 23 | 5 | 15 | 25 => {
            need(44)?;
            let parts = i32_le(c, 36) as i64;
            let count = i32_le(c, 40) as i64;
            if parts < 0 || count < 0 {
                return Err(damaged());
            }
            let points_at = 44 + 4 * parts;
            need(points_at + 16 * count + if z { 16 + 8 * count } else { 0 })?;
            let z_start = points_at + 16 * count + 16;
            let starts: Vec<i64> = (0..parts as usize)
                .map(|i| i32_le(c, 44 + 4 * i) as i64)
                .collect();
            let mut rings: Vec<Vec<Value>> = Vec::with_capacity(starts.len());
            for (i, &s) in starts.iter().enumerate() {
                let end = starts.get(i + 1).copied().unwrap_or(count);
                if s < 0 || end < s || end > count {
                    return Err(damaged());
                }
                rings.push(
                    (s..end)
                        .map(|k| {
                            at(
                                (points_at + 16 * k) as usize,
                                z.then_some((z_start + 8 * k) as usize),
                            )
                        })
                        .collect(),
                );
            }
            if matches!(typ, 3 | 13 | 23) {
                Some(if rings.len() == 1 {
                    json!({ "type": "LineString", "coordinates": rings[0] })
                } else {
                    json!({ "type": "MultiLineString", "coordinates": rings })
                })
            } else {
                let mut polygons: Vec<Vec<Vec<Value>>> = Vec::new();
                for ring in rings {
                    // A clockwise ring starts a polygon; any other is a hole of the one before it.
                    match polygons.last_mut() {
                        Some(current) if ring_area(&ring) >= 0.0 || ring_area(&ring).is_nan() => {
                            current.push(ring)
                        }
                        _ => polygons.push(vec![ring]),
                    }
                }
                Some(if polygons.len() == 1 {
                    json!({ "type": "Polygon", "coordinates": polygons[0] })
                } else {
                    json!({ "type": "MultiPolygon", "coordinates": polygons })
                })
            }
        }
        _ => {
            return Err(parse_failed(format!(
                "record {n} of the .shp file has the unknown shape type {typ}"
            )));
        }
    })
}

fn read_shapes(shp: &[u8]) -> Result<Vec<Option<Value>>> {
    if shp.len() < 100 || i32_be(shp, 0) != 9994 {
        return Err(parse_failed(
            "the .shp file does not start with the Shapefile file code",
        ));
    }
    let mut out = Vec::new();
    let mut at = 100usize;
    while at + 8 <= shp.len() {
        let n = out.len() + 1;
        let words = i32_be(shp, at + 4) as i64;
        let end = at as i64 + 8 + 2 * words;
        if words < 0 || end > shp.len() as i64 {
            return Err(parse_failed(format!(
                "record {n} of the .shp file is cut short"
            )));
        }
        out.push(shape_of(&shp[at + 8..end as usize], n)?);
        at = end as usize;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Attributes (.dbf)

struct DbfField {
    name: Vec<u8>,
    typ: u8,
    offset: usize,
    length: usize,
}

struct Dbf<'a> {
    fields: Vec<DbfField>,
    records: Vec<&'a [u8]>,
}

fn read_dbf(dbf: &[u8]) -> Result<Dbf<'_>> {
    let cut = || parse_failed("the .dbf file is cut short");
    if dbf.len() < 32 {
        return Err(cut());
    }
    let count = u32::from_le_bytes([dbf[4], dbf[5], dbf[6], dbf[7]]) as u64;
    let header_length = u16::from_le_bytes([dbf[8], dbf[9]]) as usize;
    let record_length = u16::from_le_bytes([dbf[10], dbf[11]]) as usize;
    let mut fields = Vec::new();
    let mut offset = 1usize;
    let mut at = 32usize;
    while at + 32 <= header_length && at < dbf.len() && dbf[at] != 0x0D {
        let raw = &dbf[at..(at + 11).min(dbf.len())];
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        let length = dbf.get(at + 16).copied().unwrap_or(0) as usize;
        fields.push(DbfField {
            name: raw[..end].to_vec(),
            typ: dbf.get(at + 11).copied().unwrap_or(0),
            offset,
            length,
        });
        offset += length;
        at += 32;
    }
    if header_length as u64 + count * record_length as u64 > dbf.len() as u64
        || record_length < offset
    {
        return Err(cut());
    }
    let records = (0..count as usize)
        .map(|i| &dbf[header_length + i * record_length..header_length + (i + 1) * record_length])
        .collect();
    Ok(Dbf { fields, records })
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

fn decode(bytes: &[u8], encoding: &str) -> String {
    let Ok(mut d) = crate::encoding::TextDecoder::new(encoding, 0) else {
        return latin1(bytes);
    };
    let mut out = Vec::with_capacity(bytes.len());
    d.decode(bytes, &mut out);
    d.finish(&mut out);
    String::from_utf8(out).unwrap_or_default()
}

/// The encoding of the .dbf text and its detection (dbfEncoding).
fn dbf_encoding(dbf: &[u8], d: &Dbf, cpg: Option<&[u8]>) -> Result<(&'static str, Value)> {
    let det = |value: &'static str, confidence: &str, method: &str, evidence: String| {
        (
            value,
            crate::detect::det(json!(value), confidence, method, evidence, false),
        )
    };
    if let Some(cpg) = cpg {
        let name = latin1(cpg)
            .trim_matches(crate::units::is_js_space)
            .to_string();
        let value = match name.to_lowercase().as_str() {
            "utf-8" | "utf8" | "65001" => "utf-8",
            "1252" | "windows-1252" | "cp1252" | "ansi 1252" | "iso-8859-1" | "iso8859-1"
            | "88591" | "8859_1" | "iso88591" | "latin1" => "windows-1252",
            _ => {
                return Err(EngineError::new(
                    "FORMAT_UNSUPPORTED",
                    format!(
                        "The Shapefile's .cpg names the encoding \"{name}\", which is not read."
                    ),
                    "Export the layer again with its attributes in UTF-8, then import it.",
                ));
            }
        };
        return Ok(det(
            value,
            "high",
            "cpg",
            format!("The .cpg file names the encoding \"{name}\"."),
        ));
    }
    let driver = dbf.get(29).copied().unwrap_or(0);
    if driver == 0x03 || driver == 0x57 {
        return Ok(det(
            "windows-1252",
            "high",
            "dbf-language-driver",
            format!(
                "The .dbf language driver {driver} is the Windows ANSI code page (windows-1252)."
            ),
        ));
    }
    let text = d.records.iter().all(|r| {
        d.fields.iter().all(|f| {
            f.typ != b'C' || std::str::from_utf8(&r[f.offset..f.offset + f.length]).is_ok()
        })
    });
    Ok(if text {
        det(
            "utf-8",
            "medium",
            "utf8-valid",
            "There is no .cpg file and every text field is valid UTF-8.".into(),
        )
    } else {
        det(
            "windows-1252",
            "low",
            "fallback",
            "There is no .cpg file and some text is not UTF-8, so it is read as windows-1252."
                .into(),
        )
    })
}

fn trim_end(b: &[u8]) -> &[u8] {
    let mut end = b.len();
    while end > 0 && (b[end - 1] == b' ' || b[end - 1] == 0) {
        end -= 1;
    }
    &b[..end]
}

fn trim_both(b: &[u8]) -> &[u8] {
    let t = trim_end(b);
    let start = t.iter().position(|&c| c != b' ').unwrap_or(t.len());
    &t[start..]
}

fn value_of(bytes: &[u8], f: &DbfField, encoding: &str) -> Raw {
    match f.typ {
        b'L' => match trim_both(bytes).first().copied().unwrap_or(b'?') {
            b'T' | b't' | b'Y' | b'y' => Raw::Bool(true),
            b'F' | b'f' | b'N' | b'n' => Raw::Bool(false),
            _ => Raw::Null,
        },
        b'D' => {
            let t = latin1(trim_both(bytes));
            if t.is_empty() {
                Raw::Null
            } else if t.len() == 8 && t.bytes().all(|c| c.is_ascii_digit()) {
                Raw::Date(format!("{}-{}-{}", &t[..4], &t[4..6], &t[6..]))
            } else {
                Raw::Text(t)
            }
        }
        b'N' | b'F' => {
            let t = latin1(trim_both(bytes));
            if t.is_empty() || t.bytes().all(|c| c == b'*' || c == b'?') {
                Raw::Null
            } else {
                Raw::Text(t)
            }
        }
        _ => {
            let t = trim_end(bytes);
            if t.is_empty() {
                Raw::Null
            } else {
                Raw::Text(decode(t, encoding))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The CRS (.prj)

fn crs_detection(prj: Option<&[u8]>) -> Value {
    let det = |code: &str, confidence: &str, method: &str, evidence: String| {
        crate::detect::det(
            json!({ "code": code, "source": "shapefile-prj" }),
            confidence,
            method,
            evidence,
            false,
        )
    };
    let Some(prj) = prj else {
        return det(
            "unknown",
            "low",
            "shapefile-prj",
            "The archive holds no .prj file beside the .shp file, so the coordinate reference system is not known.".into(),
        );
    };
    let text = latin1(prj);
    let text = text.trim_matches(crate::units::is_js_space);
    let known = crate::geodesy::supported_crs();
    let code_name = |c: &Value| {
        (
            c["code"].as_str().unwrap_or("").to_string(),
            c["name"].as_str().unwrap_or("").to_string(),
        )
    };
    for c in &known {
        let (code, name) = code_name(c);
        if crate::geodesy::esri_wkt(&code).as_deref() == Some(text) {
            return det(
                &code,
                "high",
                "shapefile-prj",
                format!("The .prj file is the ESRI WKT of {code} ({name})."),
            );
        }
    }
    static AUTHORITY: OnceLock<regex::Regex> = OnceLock::new();
    let authority = re(
        &AUTHORITY,
        r#"AUTHORITY\["EPSG",[ ]*"?(\d{1,9})"?\]\][ \t\r\n]*$"#,
    );
    if let Some(n) = authority
        .captures(text)
        .and_then(|m| m.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
    {
        let code = format!("EPSG:{n}");
        return det(
            &code,
            "high",
            "shapefile-prj",
            format!("The .prj file names {code}."),
        );
    }
    static NAME: OnceLock<regex::Regex> = OnceLock::new();
    let name_of = |wkt: &str| {
        re(&NAME, r#"^(?:PROJCS|GEOGCS)\["([^"]*)""#)
            .captures(wkt)
            .and_then(|m| m.get(1))
            .map(|m| m.as_str().to_string())
    };
    let Some(name) = name_of(text) else {
        return det(
            "unknown",
            "low",
            "shapefile-prj",
            "The .prj file does not describe a coordinate reference system that can be read."
                .into(),
        );
    };
    for c in &known {
        let (code, crs_name) = code_name(c);
        if crate::geodesy::esri_wkt(&code)
            .as_deref()
            .and_then(name_of)
            .as_deref()
            == Some(name.as_str())
        {
            return det(
                &code,
                "medium",
                "shapefile-prj-name",
                format!(
                    "The .prj file names \"{name}\", the ESRI name of {code} ({crs_name}); its parameters differ from the registry's."
                ),
            );
        }
    }
    det(
        "unknown",
        "low",
        "shapefile-prj",
        format!(
            "The .prj file describes \"{name}\", which is not a coordinate reference system in the registry."
        ),
    )
}

// ---------------------------------------------------------------------------------------------
// The importer

pub struct Read {
    pub entry: String,
    pub header: Vec<String>,
    pub rows: Vec<Row>,
    pub detections: Vec<(String, Value)>,
}

fn read_all(parts: Parts) -> Result<Read> {
    let shapes = read_shapes(&parts.shp)?;
    let dbf = parts.dbf.as_deref().map(read_dbf).transpose()?;
    let encoding = match (&dbf, parts.dbf.as_deref()) {
        (Some(d), Some(bytes)) => Some(dbf_encoding(bytes, d, parts.cpg.as_deref())?),
        _ => None,
    };
    let enc = encoding.as_ref().map_or("utf-8", |e| e.0);
    let fields: &[DbfField] = dbf.as_ref().map_or(&[], |d| &d.fields);
    let count = shapes
        .len()
        .max(dbf.as_ref().map_or(0, |d| d.records.len()));
    let mut types: Vec<String> = Vec::new();
    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let record = dbf.as_ref().and_then(|d| d.records.get(i));
        let values = fields
            .iter()
            .map(|f| match record {
                None => Raw::Null,
                Some(r) => value_of(&r[f.offset..f.offset + f.length], f, enc),
            })
            .collect();
        let geometry = shapes.get(i).cloned().flatten();
        if let Some(g) = &geometry {
            let t = g["type"].as_str().unwrap_or("").to_string();
            if !types.contains(&t) {
                types.push(t);
            }
        }
        rows.push((
            i as u64,
            values,
            geometry.map(|g| crate::canonical::stringify(&g)),
        ));
    }
    let format_count = crate::csv::format_count;
    let found = if types.is_empty() {
        "no geometry types".to_string()
    } else {
        format!("geometry types {}", types.join(", "))
    };
    let mut detections = Vec::new();
    if let Some((_, d)) = &encoding {
        detections.push(("encoding".to_string(), d.clone()));
    }
    detections.push(("crs".to_string(), crs_detection(parts.prj.as_deref())));
    detections.push((
        "geometryTypes".to_string(),
        crate::detect::det(
            json!(types),
            "high",
            "geometry-types",
            format!(
                "Found {found} over all {} shapes.",
                format_count(shapes.len() as u64)
            ),
            false,
        ),
    ));
    detections.push((
        "rowCount".to_string(),
        crate::detect::det(
            json!(count),
            "high",
            "shapefile-records",
            format!(
                "The .shp and .dbf files hold {} records.",
                format_count(count as u64)
            ),
            false,
        ),
    ));
    Ok(Read {
        entry: parts.entry,
        header: fields.iter().map(|f| decode(&f.name, enc)).collect(),
        rows,
        detections,
    })
}

/// The sniff: everything, the first `sample` rows as the sample.
pub fn sniff(path: &Path, sample: usize) -> Result<Read> {
    let mut r = read_all(parts_of(path)?)?;
    r.rows.truncate(sample);
    Ok(r)
}

/// Hashes the archive and reads its records as rows. Returns the notes (none), the SHA-256 and
/// the size.
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
    drop(original);
    let r = read_all(parts_of(path)?)?;
    for (i, row) in r.rows.into_iter().enumerate() {
        if i.is_multiple_of(1024) && cancel.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                "CANCELLED",
                "The import was cancelled.",
                "Start the import again when you are ready.",
            ));
        }
        send(row)?;
    }
    Ok((Vec::new(), digest, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_rings_by_orientation_and_keeps_heights() {
        let mut c = vec![0u8; 44 + 8 + 16 * 8];
        c[..4].copy_from_slice(&5i32.to_le_bytes());
        c[36..40].copy_from_slice(&2i32.to_le_bytes());
        c[40..44].copy_from_slice(&8i32.to_le_bytes());
        c[48..52].copy_from_slice(&4i32.to_le_bytes());
        let pts: [[f64; 2]; 8] = [
            [0.0, 0.0],
            [0.0, 9.0],
            [9.0, 9.0],
            [0.0, 0.0],
            [1.0, 1.0],
            [2.0, 1.0],
            [2.0, 2.0],
            [1.0, 1.0],
        ];
        for (i, p) in pts.iter().enumerate() {
            c[52 + 16 * i..60 + 16 * i].copy_from_slice(&p[0].to_le_bytes());
            c[60 + 16 * i..68 + 16 * i].copy_from_slice(&p[1].to_le_bytes());
        }
        let g = shape_of(&c, 1).ok().flatten().unwrap();
        assert_eq!(
            crate::canonical::stringify(&g),
            r#"{"type":"Polygon","coordinates":[[[0,0],[0,9],[9,9],[0,0]],[[1,1],[2,1],[2,2],[1,1]]]}"#
        );
        let mut z = vec![0u8; 36];
        z[..4].copy_from_slice(&11i32.to_le_bytes());
        for (i, x) in [1.5f64, 2.5, -0.0].iter().enumerate() {
            z[4 + 8 * i..12 + 8 * i].copy_from_slice(&x.to_le_bytes());
        }
        let p = shape_of(&z, 1).ok().flatten().unwrap();
        assert_eq!(
            crate::canonical::stringify(&p),
            r#"{"type":"Point","coordinates":[1.5,2.5,0]}"#
        );
        assert_eq!(
            shp_entry(&["a/x.shp".into(), "y.SHP".into()]).as_deref(),
            Some("y.SHP")
        );
    }
}
