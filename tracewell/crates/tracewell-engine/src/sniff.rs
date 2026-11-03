//! The import preview of delimited text (sniff), ported from the TypeScript src/io/encoding.ts
//! (sniffEncoding), src/formats/csv (sniff.ts, dialect.ts, header.ts, numbers.ts, quote.ts,
//! lines.ts) and src/ingest (format.ts, preview.ts, templates.ts, overrides.ts): from the first
//! MiB of a file to its options, detections, header, sample rows, column plans, parsed preview
//! rows and assumptions, with the same evidence texts, so both engines show the same preview.
//!
//! The text is UTF-8 here and JavaScript strings are UTF-16, but every character the dialect
//! analysis acts on (delimiters, quotes, CR and LF) is ASCII, so byte offsets and code-unit
//! offsets find the same splits. Lengths the TypeScript measures in code units are measured so.

use crate::csv::{TableLayout, TableReader, format_count, plural};
use crate::detect::{DetectOptions, collect_assumptions, det, detect_columns, detect_lat_lon_crs};
use crate::encoding::TextDecoder;
use crate::error::{EngineError, Result};
use crate::import::column_parser;
use crate::parse::{Parsed, Raw};
use crate::units::{get_unit, js_trim};
use duckdb::Connection;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

/// The bytes the first preview reads, so it is fast for any file size.
pub const PREVIEW_MAX_BYTES: usize = 1_048_576;
/// Enough of the file to see past a BOM, leading white space and the first line.
const FORMAT_SNIFF_BYTES: usize = 65_536;
/// The sniff's sample holds at most this many rows.
const SAMPLE_MAX_ROWS: usize = 1000;
/// Rows from the header on that the header-row detection inspects: header, units row and 50 below.
const HEADER_SCAN_ROWS: usize = 52;
/// Rows the preview parses and shows.
const PREVIEW_ROWS: usize = 200;
/// Rough in-memory size of a parsed cell, for the preview's budget warning only.
const BYTES_PER_CELL: f64 = 16.0;

const LF: u8 = b'\n';
const CR: u8 = b'\r';
const QUOTE: u8 = b'"';
const DELIMITERS: [u8; 4] = *b",;\t|";

/// JavaScript's `\s`, which the regex crate's Unicode `\s` differs from by U+FEFF and U+0085.
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

fn re(cell: &'static OnceLock<Regex>, pattern: impl FnOnce() -> String) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&pattern()).expect("a valid pattern"))
}

fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript's Math.round for the non-negative numbers it is used on here.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// A property set in the import settings: the user's, never assumed.
fn from_settings(value: Value, what: &str) -> Value {
    json!({
        "value": value,
        "confidence": "high",
        "assumed": false,
        "source": "user",
        "method": "user-override",
        "evidence": format!("The {what} is set in the import settings."),
    })
}

fn user_value(value: Value, evidence: &str) -> Value {
    json!({
        "value": value,
        "confidence": "high",
        "assumed": false,
        "source": "user",
        "method": "user-override",
        "evidence": evidence,
    })
}

// ---------------------------------------------------------------------------------------------
// Encoding (io/encoding.ts)

/// The encoding detection of a file's first bytes, and the length of its byte-order mark.
pub struct EncodingSniff {
    pub value: &'static str,
    pub bom_length: u64,
    pub detection: Value,
}

const UTF16_MIN_ZERO_SHARE: f64 = 0.5;
const UTF16_MAX_OTHER_ZERO_SHARE: f64 = 0.1;
const UTF16_MIN_PAIRS: usize = 2;

pub fn sniff_encoding(head: &[u8]) -> EncodingSniff {
    sniff_bom(head)
        .or_else(|| sniff_utf16(head))
        .or_else(|| sniff_utf8(head))
        .unwrap_or_else(|| encoding_fallback(head))
}

fn encoding(value: &'static str, bom_length: u64, detection: Value) -> EncodingSniff {
    EncodingSniff {
        value,
        bom_length,
        detection,
    }
}

fn sniff_bom(head: &[u8]) -> Option<EncodingSniff> {
    let boms: [(&[u8], &'static str, &str); 3] = [
        (
            &[0xEF, 0xBB, 0xBF],
            "utf-8",
            "UTF-8 byte-order mark (EF BB BF)",
        ),
        (
            &[0xFF, 0xFE],
            "utf-16le",
            "UTF-16 little-endian byte-order mark (FF FE)",
        ),
        (
            &[0xFE, 0xFF],
            "utf-16be",
            "UTF-16 big-endian byte-order mark (FE FF)",
        ),
    ];
    let (bytes, value, label) = boms.into_iter().find(|(b, _, _)| head.starts_with(b))?;
    let evidence = format!("The file starts with the {label}.");
    Some(encoding(
        value,
        bytes.len() as u64,
        det(json!(value), "high", "bom", evidence, false),
    ))
}

fn sniff_utf16(head: &[u8]) -> Option<EncodingSniff> {
    let pairs = head.len() / 2;
    if pairs < UTF16_MIN_PAIRS {
        return None;
    }
    let (mut even, mut odd) = (0usize, 0usize);
    for pair in head.chunks_exact(2) {
        even += usize::from(pair[0] == 0);
        odd += usize::from(pair[1] == 0);
    }
    let looks_like = |zeros: usize, other: usize| {
        zeros as f64 / pairs as f64 >= UTF16_MIN_ZERO_SHARE
            && other as f64 / pairs as f64 <= UTF16_MAX_OTHER_ZERO_SHARE
    };
    let (value, zeros, which) = if looks_like(odd, even) {
        ("utf-16le", odd, "second")
    } else if looks_like(even, odd) {
        ("utf-16be", even, "first")
    } else {
        return None;
    };
    let share = js_round(zeros as f64 / pairs as f64 * 100.0);
    let evidence = format!(
        "There is no byte-order mark, but {share}% of the {} byte pairs read have a zero {which} byte, the pattern of {} text.",
        format_count(pairs as u64),
        value.to_uppercase()
    );
    Some(encoding(
        value,
        0,
        det(
            json!(value),
            "medium",
            "utf16-zero-pattern",
            evidence,
            false,
        ),
    ))
}

struct Utf8Scan {
    invalid_at: Option<usize>,
    multi_byte: usize,
    cut_off_at: Option<usize>,
}

/// The allowed range of the second byte for each lead byte; later bytes are always 0x80-0xBF.
fn second_byte_range(lead: u8) -> Option<(usize, u8, u8)> {
    match lead {
        0xC2..=0xDF => Some((2, 0x80, 0xBF)),
        0xE0 => Some((3, 0xA0, 0xBF)),
        0xED => Some((3, 0x80, 0x9F)),
        0xE1..=0xEF => Some((3, 0x80, 0xBF)),
        0xF0 => Some((4, 0x90, 0xBF)),
        0xF1..=0xF3 => Some((4, 0x80, 0xBF)),
        0xF4 => Some((4, 0x80, 0x8F)),
        _ => None,
    }
}

fn sequence_length(bytes: &[u8], i: usize) -> usize {
    let Some((length, low, high)) = second_byte_range(bytes[i]) else {
        return 0;
    };
    for k in 1..length {
        let Some(&b) = bytes.get(i + k) else { break };
        let (min, max) = if k == 1 { (low, high) } else { (0x80, 0xBF) };
        if b < min || b > max {
            return 0;
        }
    }
    length
}

fn scan_utf8(bytes: &[u8]) -> Utf8Scan {
    let mut multi_byte = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] < 0x80 {
            i += 1;
            continue;
        }
        let length = sequence_length(bytes, i);
        if length == 0 {
            return Utf8Scan {
                invalid_at: Some(i),
                multi_byte,
                cut_off_at: None,
            };
        }
        if i + length > bytes.len() {
            return Utf8Scan {
                invalid_at: None,
                multi_byte,
                cut_off_at: Some(i),
            };
        }
        multi_byte += 1;
        i += length;
    }
    Utf8Scan {
        invalid_at: None,
        multi_byte,
        cut_off_at: None,
    }
}

fn sniff_utf8(head: &[u8]) -> Option<EncodingSniff> {
    let scan = scan_utf8(head);
    if scan.invalid_at.is_some() {
        return None;
    }
    let d = if head.is_empty() {
        det(
            json!("utf-8"),
            "high",
            "empty",
            "The file is empty, so any encoding reads it the same.",
            false,
        )
    } else if let (0, Some(at)) = (scan.multi_byte, scan.cut_off_at) {
        let evidence = format!(
            "The bytes read are plain ASCII except for an incomplete multi-byte sequence at offset {}, the very end. UTF-8 is assumed; if the file ends there, it is not UTF-8 and is probably windows-1252.",
            format_count(at as u64)
        );
        det(json!("utf-8"), "medium", "utf8-cut-off", evidence, false)
    } else if scan.multi_byte == 0 {
        let evidence = format!(
            "The first {} bytes are plain ASCII, which reads the same in UTF-8.",
            format_count(head.len() as u64)
        );
        det(json!("utf-8"), "high", "ascii", evidence, false)
    } else {
        let evidence = format!(
            "The first {} bytes are valid UTF-8 and contain {} multi-byte characters.",
            format_count(head.len() as u64),
            format_count(scan.multi_byte as u64)
        );
        det(json!("utf-8"), "high", "utf8-valid", evidence, false)
    };
    Some(encoding("utf-8", 0, d))
}

fn encoding_fallback(head: &[u8]) -> EncodingSniff {
    let at = scan_utf8(head).invalid_at.unwrap_or(0);
    let evidence = format!(
        "Byte 0x{:02X} at offset {} is not valid UTF-8 and there is no byte-order mark, so windows-1252 (Western European) is assumed.",
        head.get(at).copied().unwrap_or(0),
        format_count(at as u64)
    );
    encoding(
        "windows-1252",
        0,
        det(
            json!("windows-1252"),
            "low",
            "fallback-windows-1252",
            evidence,
            true,
        ),
    )
}

/// Decodes a whole buffer after its byte-order mark, as decodeAll: bad sequences become U+FFFD.
fn decode_all(bytes: &[u8], encoding: &str, bom_length: u64) -> Result<String> {
    let mut decoder = TextDecoder::new(encoding, bom_length)?;
    let mut out = Vec::with_capacity(bytes.len() + 16);
    decoder.decode(bytes, &mut out);
    decoder.finish(&mut out);
    Ok(match String::from_utf8(out) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

// ---------------------------------------------------------------------------------------------
// Format (ingest/format.ts)

fn extension_of(file_name: &str) -> String {
    file_name
        .rfind('.')
        .map_or(String::new(), |i| file_name[i + 1..].to_lowercase())
}

/// GeoJSON object types; one of them as the top-level "type" marks a JSON file as GeoJSON.
const GEOJSON_TYPES: [&str; 9] = [
    "FeatureCollection",
    "Feature",
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
];

/// The value of the top-level object's "type" member when it is a string within `text`
/// (format.ts topLevelType); members of nested objects are skipped.
fn top_level_type(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut depth = 0i64;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '"' => {
                let mut end = i + 1;
                while end < chars.len() && chars[end] != '"' {
                    end += if chars[end] == '\\' { 2 } else { 1 };
                }
                if end >= chars.len() {
                    return None;
                }
                if depth == 1 && chars[i..=end].iter().collect::<String>() == "\"type\"" {
                    let after: String = chars[end + 1..chars.len().min(end + 64)].iter().collect();
                    let rest = after.trim_start_matches(crate::units::is_js_space);
                    if let Some(rest) = rest.strip_prefix(':') {
                        let rest = rest.trim_start_matches(crate::units::is_js_space);
                        if let Some(value) = rest.strip_prefix('"')
                            && let Some(close) = value.find(['"', '\\'])
                            && value[close..].starts_with('"')
                        {
                            return Some(value[..close].to_string());
                        }
                    }
                }
                i = end;
            }
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}

/// The source format from the first bytes and the file name (format.ts detectFormat): CSV, TSV,
/// Parquet or JSON; Excel and GeoJSON files, which the native engine does not read yet, are refused.
fn detect_format(head: &[u8], file_name: &str) -> Result<&'static str> {
    let refuse = |what: &str| {
        Err(EngineError::unsupported(format!(
            "the import preview of {what} files"
        )))
    };
    // A ZIP archive is read as an .xlsx workbook, no other ZIP-based format being supported, and
    // an OLE compound file as a legacy .xls; the reader refuses what is not a workbook.
    if head.starts_with(&[0x50, 0x4B, 0x03, 0x04])
        || head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
    {
        return Ok("xlsx");
    }
    if head.starts_with(b"PAR1") {
        return Ok("parquet");
    }
    let sample = &head[..head.len().min(FORMAT_SNIFF_BYTES)];
    let e = sniff_encoding(sample);
    let decoded = decode_all(sample, e.value, e.bom_length)?;
    let text = decoded.strip_prefix('\u{FEFF}').unwrap_or(&decoded);
    let body = text.trim_start_matches(crate::units::is_js_space);
    let first = body.chars().next();
    let ext = extension_of(file_name);
    if matches!(first, Some('{' | '[')) {
        let geojson = ext == "geojson"
            || (first == Some('{')
                && top_level_type(body).is_some_and(|t| GEOJSON_TYPES.contains(&t.as_str())));
        return if geojson {
            refuse("GeoJSON")
        } else {
            Ok("json")
        };
    }
    if ext == "tsv" || ext == "tab" {
        return Ok("tsv");
    }
    if ext == "csv" {
        return Ok("csv");
    }
    let line = text.split('\n').next().unwrap_or("");
    let line = line.strip_suffix('\r').unwrap_or(line);
    let count = |c: char| line.matches(c).count();
    let others = count(',').max(count(';')).max(count('|'));
    Ok(if count('\t') > others { "tsv" } else { "csv" })
}

// ---------------------------------------------------------------------------------------------
// Tokenizing (tokenizer.ts, lines.ts)

struct Record {
    fields: Vec<String>,
    /// 1-based physical line of the record's first character.
    line: u64,
}

fn is_blank(fields: &[String]) -> bool {
    fields.len() == 1 && fields[0].is_empty()
}

fn field_text(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

/// Every record of `text`; with `complete` false, a record still open at the end is left out.
fn tokenize(text: &[u8], delimiter: u8, complete: bool) -> Vec<Record> {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Start,
        Unquoted,
        Quoted,
        QuoteSeen,
    }
    let mut out = Vec::new();
    let mut state = State::Start;
    let mut field: Vec<u8> = Vec::new();
    let mut fields: Vec<String> = Vec::new();
    let mut record_line = 0u64;
    let mut line = 1u64;
    let mut after_cr = false;
    let mut i = 0;
    macro_rules! end_field {
        () => {{
            fields.push(field_text(std::mem::take(&mut field)));
            state = State::Start;
        }};
    }
    macro_rules! end_record {
        () => {{
            fields.push(field_text(std::mem::take(&mut field)));
            out.push(Record {
                fields: std::mem::take(&mut fields),
                line: record_line,
            });
            state = State::Start;
            record_line = 0;
        }};
    }
    while i < text.len() {
        let c = text[i];
        if after_cr {
            after_cr = false;
            if c == LF {
                if state == State::Quoted {
                    field.push(LF);
                }
                i += 1;
                continue;
            }
        }
        match state {
            State::Start => {
                if record_line == 0 {
                    record_line = line;
                }
                if c == QUOTE {
                    state = State::Quoted;
                } else if c == delimiter {
                    end_field!();
                } else if c == LF || c == CR {
                    end_record!();
                    line += 1;
                    after_cr = c == CR;
                } else {
                    state = State::Unquoted;
                    continue;
                }
            }
            State::Unquoted => {
                if c == delimiter {
                    end_field!();
                } else if c == LF || c == CR {
                    end_record!();
                    line += 1;
                    after_cr = c == CR;
                } else {
                    field.push(c);
                }
            }
            State::Quoted => {
                if c == QUOTE {
                    state = State::QuoteSeen;
                } else {
                    field.push(c);
                    if c == LF || c == CR {
                        line += 1;
                        after_cr = c == CR;
                    }
                }
            }
            State::QuoteSeen => {
                if c == QUOTE {
                    field.push(QUOTE);
                    state = State::Quoted;
                } else if c == delimiter {
                    end_field!();
                } else if c == LF || c == CR {
                    end_record!();
                    line += 1;
                    after_cr = c == CR;
                } else {
                    // Text right after a closing quote keeps the quote and reads on unquoted.
                    field.push(QUOTE);
                    state = State::Unquoted;
                    continue;
                }
            }
        }
        i += 1;
    }
    if complete && record_line != 0 {
        fields.push(field_text(field));
        out.push(Record {
            fields,
            line: record_line,
        });
    }
    out
}

/// `text` after its first `lines` physical lines (LF, CR or CRLF each end one).
fn skip_lines(text: &[u8], lines: u64) -> &[u8] {
    let mut remaining = lines;
    let mut i = 0;
    while remaining > 0 && i < text.len() {
        let c = text[i];
        i += 1;
        if c == LF {
            remaining -= 1;
        } else if c == CR {
            remaining -= 1;
            if text.get(i) == Some(&LF) {
                i += 1;
            }
        }
    }
    if remaining > 0 { &[] } else { &text[i..] }
}

fn records_after_skip(text: &[u8], delimiter: u8, skip: u64, complete: bool) -> Vec<Record> {
    let mut records = tokenize(skip_lines(text, skip), delimiter, complete);
    for r in &mut records {
        r.line += skip;
    }
    records
}

/// `text` through its last line break; text without one is returned whole.
fn through_last_line_break(text: &str) -> &str {
    match text.rfind(['\n', '\r']) {
        Some(at) => &text[..=at],
        None => text,
    }
}

// ---------------------------------------------------------------------------------------------
// Delimiter and preamble (dialect.ts)

const PLAUSIBLE: f64 = 0.8;
const CONSISTENT: f64 = 0.99;
const MAX_PREAMBLE_LINES: usize = 50;
const TRAILING_DELIMITER_SHARE: f64 = 0.9;
const MESSY_SHARE: f64 = 0.5;

fn delimiter_name(d: u8) -> &'static str {
    match d {
        b',' => "comma",
        b';' => "semicolon",
        b'\t' => "tab",
        _ => "pipe",
    }
}

struct Candidate {
    delimiter: u8,
    /// The records that are not blank lines.
    lines: Vec<Record>,
    width: usize,
    header_index: usize,
    fitting: usize,
    consistency: f64,
}

fn modal_count(lines: &[Record]) -> usize {
    let mut counts: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for r in lines {
        if r.fields.len() >= 2 {
            *counts.entry(r.fields.len()).or_default() += 1;
        }
    }
    let (mut best, mut best_frequency) = (0, 0);
    for (count, frequency) in counts {
        if frequency > best_frequency || (frequency == best_frequency && count > best) {
            best = count;
            best_frequency = frequency;
        }
    }
    best
}

/// Whether a line fits the width, allowing for trailing delimiters.
fn fitter(lines: &[Record], width: usize) -> impl Fn(&Record) -> bool + use<> {
    let full: Vec<&Record> = lines.iter().filter(|r| r.fields.len() == width).collect();
    let end_empty = full
        .iter()
        .filter(|r| r.fields[width - 1].is_empty())
        .count();
    let short_fits =
        !full.is_empty() && end_empty as f64 / full.len() as f64 >= TRAILING_DELIMITER_SHARE;
    move |r: &Record| {
        let n = r.fields.len();
        n == width
            || (n == width + 1 && r.fields[width].is_empty())
            || (short_fits && n + 1 == width)
    }
}

fn fit_from(
    lines: &[Record],
    header_index: usize,
    fits: &impl Fn(&Record) -> bool,
) -> (usize, usize, f64) {
    let rest = &lines[header_index.min(lines.len())..];
    let fitting = rest.iter().filter(|r| fits(r)).count();
    let consistency = if rest.is_empty() {
        0.0
    } else {
        fitting as f64 / rest.len() as f64
    };
    (header_index, fitting, consistency)
}

fn analyse_candidate(text: &[u8], delimiter: u8) -> Candidate {
    let lines: Vec<Record> = tokenize(text, delimiter, true)
        .into_iter()
        .filter(|r| !is_blank(&r.fields))
        .collect();
    let width = modal_count(&lines);
    let mut c = Candidate {
        delimiter,
        lines,
        width,
        header_index: 0,
        fitting: 0,
        consistency: 0.0,
    };
    if width == 0 {
        return c;
    }
    let fits = fitter(&c.lines, width);
    let first = c.lines.iter().position(&fits);
    let start = first.filter(|&f| f <= MAX_PREAMBLE_LINES).unwrap_or(0);
    let titled = fit_from(&c.lines, start, &fits);
    // A title block is only believable above a consistent table; otherwise the header is the first line.
    let fit = if titled.2 >= PLAUSIBLE {
        titled
    } else {
        fit_from(&c.lines, 0, &fits)
    };
    (c.header_index, c.fitting, c.consistency) = fit;
    c
}

fn preferred(file_name: &str) -> u8 {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".tsv") || lower.ends_with(".tab") {
        b'\t'
    } else {
        b','
    }
}

fn is_plausible(c: &Candidate) -> bool {
    c.width >= 2 && c.consistency >= PLAUSIBLE
}

fn score(c: &Candidate) -> f64 {
    if c.lines.is_empty() {
        0.0
    } else {
        c.fitting as f64 / c.lines.len() as f64
    }
}

fn compare(a: &Candidate, b: &Candidate, prefer: u8) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (pa, pb) = (is_plausible(a), is_plausible(b));
    if pa != pb {
        return if pa {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    if pa && a.header_index != b.header_index {
        return a.header_index.cmp(&b.header_index);
    }
    if score(a) != score(b) {
        return score(b).partial_cmp(&score(a)).unwrap_or(Ordering::Equal);
    }
    if a.width != b.width {
        return b.width.cmp(&a.width);
    }
    if a.delimiter == prefer || b.delimiter == prefer {
        return if a.delimiter == prefer {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let at = |d: u8| DELIMITERS.iter().position(|&x| x == d).unwrap_or(0);
    at(a.delimiter).cmp(&at(b.delimiter))
}

fn choose_delimiter(text: &[u8], file_name: &str) -> (Candidate, Value) {
    let prefer = preferred(file_name);
    let mut ranked: Vec<Candidate> = DELIMITERS
        .iter()
        .map(|&d| analyse_candidate(text, d))
        .collect();
    ranked.sort_by(|a, b| compare(a, b, prefer));
    if ranked[0].width < 2 {
        let lines = ranked[0].lines.len();
        let at = ranked
            .iter()
            .position(|c| c.delimiter == prefer)
            .unwrap_or(0);
        return (ranked.swap_remove(at), no_delimiter(prefer, lines));
    }
    let best = ranked.remove(0);
    let d = delimiter_detection(&best, &ranked);
    (best, d)
}

fn delimiter_value(d: u8) -> Value {
    json!((d as char).to_string())
}

fn no_delimiter(prefer: u8, lines: usize) -> Value {
    let name = delimiter_name(prefer);
    let evidence = if lines == 0 {
        format!("The file has no lines to inspect, so the {name} is assumed.")
    } else {
        format!(
            "No comma, semicolon, tab or pipe splits the lines into two or more fields, so the file reads as a single column and the {name} is assumed."
        )
    };
    det(delimiter_value(prefer), "low", "default", evidence, true)
}

fn delimiter_detection(best: &Candidate, others: &[Candidate]) -> Value {
    let name = delimiter_name(best.delimiter);
    let rest = best.lines.len() - best.header_index;
    let rival = others
        .iter()
        .find(|c| is_plausible(c) && c.header_index <= best.header_index);
    let share = format!(
        "{} of {}",
        format_count(best.fitting as u64),
        plural(rest as u64, "line")
    );
    let mut evidence = format!(
        "Splitting on the {name} gives {} fields on {share} from the header on.",
        format_count(best.width as u64)
    );
    if let Some(r) = rival {
        evidence += &format!(
            " Splitting on the {} is almost as consistent, so this is uncertain.",
            delimiter_name(r.delimiter)
        );
    }
    let value = delimiter_value(best.delimiter);
    if rest < 2 {
        return det(
            value,
            "medium",
            "field-count-consistency",
            format!("{evidence} The sample has no data lines."),
            false,
        );
    }
    let confidence = if best.consistency >= CONSISTENT && rival.is_none() {
        "high"
    } else if best.consistency >= PLAUSIBLE {
        "medium"
    } else {
        let competitor = others
            .iter()
            .any(|c| c.width >= 2 && score(c) >= MESSY_SHARE);
        if best.consistency >= MESSY_SHARE && !competitor {
            "medium"
        } else {
            "low"
        }
    };
    det(
        value,
        confidence,
        "field-count-consistency",
        evidence,
        false,
    )
}

fn detect_skip_lines(c: &Candidate) -> Value {
    let Some(header) = c.lines.get(c.header_index) else {
        return det(
            json!(0),
            "high",
            "empty",
            "The file has no lines with text, so there is nothing to skip.",
            false,
        );
    };
    let skip = header.line - 1;
    let line = format_count(skip + 1);
    if c.width < 2 {
        let evidence = format!(
            "No delimiter splits the lines into fields, so title rows cannot be told from the header by their field count. The first line with text, line {line}, is taken as the header."
        );
        return det(json!(skip), "medium", "single-column", evidence, false);
    }
    let width = format_count(c.width as u64);
    if c.header_index == 0 {
        let evidence = if skip == 0 {
            format!(
                "The first line already has the table's {width} fields, so it is the header and no lines are skipped."
            )
        } else {
            format!(
                "The first {} {} empty, so the header is on line {line} and the empty {} skipped.",
                plural(skip, "line"),
                if skip == 1 { "is" } else { "are" },
                if skip == 1 { "line is" } else { "lines are" }
            )
        };
        let confidence = if c.consistency >= PLAUSIBLE {
            "high"
        } else {
            "medium"
        };
        return det(
            json!(skip),
            confidence,
            "field-count-consistency",
            evidence,
            false,
        );
    }
    let preamble = &c.lines[..c.header_index];
    let all_short = preamble.iter().all(|r| r.fields.len() < c.width);
    let shape = if all_short {
        "fewer fields than"
    } else {
        "a different number of fields from"
    };
    let one = preamble.len() == 1;
    let evidence = format!(
        "The first {} with text {} {shape} the table's {width}, so {} read as a title block. The header is on line {line} and the {} above it {} skipped.",
        plural(preamble.len() as u64, "line"),
        if one { "has" } else { "have" },
        if one { "it is" } else { "they are" },
        plural(skip, "line"),
        if skip == 1 { "is" } else { "are" }
    );
    let confidence = if all_short && c.consistency >= CONSISTENT {
        "high"
    } else {
        "medium"
    };
    det(json!(skip), confidence, "title-block", evidence, false)
}

// ---------------------------------------------------------------------------------------------
// Number separators (numbers.ts)

const SHAPE_COUNT: usize = 11;
const AMBIGUOUS_COMMA: usize = 0;
const AMBIGUOUS_POINT: usize = 1;
const COMMA_GROUPED_POINT: usize = 2;
const POINT_GROUPED_COMMA: usize = 3;
const COMMA_GROUPS: usize = 4;
const POINT_GROUPS: usize = 5;
const SPACE_GROUPS: usize = 6;
const SPACE_GROUPED_POINT: usize = 7;
const SPACE_GROUPED_COMMA: usize = 8;
const POINT: usize = 9;
const COMMA: usize = 10;

fn shape_patterns() -> &'static Vec<Regex> {
    static CELL: OnceLock<Vec<Regex>> = OnceLock::new();
    CELL.get_or_init(|| {
        [
            r"^[1-9][0-9]{0,2},[0-9]{3}$",
            r"^[1-9][0-9]{0,2}\.[0-9]{3}$",
            r"^[1-9][0-9]{0,2}(?:,[0-9]{3})+\.[0-9]+$",
            r"^[1-9][0-9]{0,2}(?:\.[0-9]{3})+,[0-9]+$",
            r"^[1-9][0-9]{0,2}(?:,[0-9]{3}){2,}$",
            r"^[1-9][0-9]{0,2}(?:\.[0-9]{3}){2,}$",
            r"^[1-9][0-9]{0,2}(?: [0-9]{3})+$",
            r"^[1-9][0-9]{0,2}(?: [0-9]{3})+\.[0-9]+$",
            r"^[1-9][0-9]{0,2}(?: [0-9]{3})+,[0-9]+$",
            r"^(?:[0-9]+\.[0-9]+|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$",
            r"^[0-9]+,[0-9]+$",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("a valid pattern"))
        .collect()
    })
}

fn strip_sign(t: &str) -> &str {
    t.strip_prefix(['+', '-']).unwrap_or(t)
}

fn shape_of(text: &str) -> Option<usize> {
    let t = strip_sign(js_trim(text));
    if t.is_empty() || utf16_len(t) > 40 {
        return None;
    }
    shape_patterns().iter().position(|p| p.is_match(t))
}

/// True when `text` reads as a number in either decimal style.
fn looks_numeric(text: &str) -> bool {
    static INTEGER: OnceLock<Regex> = OnceLock::new();
    let t = strip_sign(js_trim(text));
    !t.is_empty()
        && (re(&INTEGER, || r"^[0-9]+(?:[eE][+-]?[0-9]+)?$".into()).is_match(t)
            || shape_of(t).is_some())
}

struct NumberEvidence {
    counts: [usize; SHAPE_COUNT],
    examples: [Option<String>; SHAPE_COUNT],
}

fn collect_number_evidence(rows: &[(u64, Vec<Raw>)]) -> NumberEvidence {
    let mut e = NumberEvidence {
        counts: [0; SHAPE_COUNT],
        examples: Default::default(),
    };
    for (_, fields) in rows {
        // Only text says how numbers are written; native numbers have no separators.
        for field in fields.iter().filter_map(|f| match f {
            Raw::Text(t) => Some(t),
            _ => None,
        }) {
            if let Some(shape) = shape_of(field) {
                e.counts[shape] += 1;
                if e.examples[shape].is_none() {
                    e.examples[shape] = Some(js_trim(field).to_string());
                }
            }
        }
    }
    e
}

impl NumberEvidence {
    fn total(&self, shapes: &[usize]) -> usize {
        shapes.iter().map(|&s| self.counts[s]).sum()
    }

    fn example(&self, shapes: &[usize]) -> String {
        shapes
            .iter()
            .find_map(|&s| self.examples[s].as_deref())
            .map(quoted)
            .unwrap_or_default()
    }

    fn votes(&self, n: usize, shapes: &[usize]) -> String {
        format!(
            "{} such as {}",
            plural(n as u64, "value"),
            self.example(shapes)
        )
    }
}

const COMMA_DECIMAL: [usize; 4] = [
    COMMA,
    POINT_GROUPED_COMMA,
    POINT_GROUPS,
    SPACE_GROUPED_COMMA,
];
const POINT_DECIMAL: [usize; 4] = [
    POINT,
    COMMA_GROUPED_POINT,
    COMMA_GROUPS,
    SPACE_GROUPED_POINT,
];
const AMBIGUOUS: [usize; 2] = [AMBIGUOUS_COMMA, AMBIGUOUS_POINT];

fn agree<'a>(n: usize, singular: &'a str, plural_form: &'a str) -> &'a str {
    if n == 1 { singular } else { plural_form }
}

fn detect_decimal(e: &NumberEvidence, delimiter: u8) -> Value {
    let comma = e.total(&COMMA_DECIMAL);
    let point = e.total(&POINT_DECIMAL);
    if comma > 0 && point > 0 {
        let value = if comma > point || (comma == point && delimiter == b';') {
            ","
        } else {
            "."
        };
        let choice = if comma == point {
            format!(
                "Both are equally common, so the {} is used.",
                if value == "," {
                    "comma, usual with semicolons,"
                } else {
                    "point"
                }
            )
        } else {
            format!(
                "The more common {} is used.",
                if value == "," { "comma" } else { "point" }
            )
        };
        let evidence = format!(
            "The sample mixes both styles: {} {} and {} {}. {choice}",
            e.votes(comma, &COMMA_DECIMAL),
            agree(comma, "has a decimal comma", "have decimal commas"),
            e.votes(point, &POINT_DECIMAL),
            agree(point, "has a decimal point", "have decimal points"),
        );
        return det(
            json!(value),
            "low",
            "number-shapes-conflict",
            evidence,
            false,
        );
    }
    if comma > 0 {
        let evidence = format!(
            "{} {} a comma before the fractional part.",
            e.votes(comma, &COMMA_DECIMAL),
            agree(comma, "uses", "use")
        );
        let confidence = if comma >= 3 { "high" } else { "medium" };
        return det(json!(","), confidence, "number-shapes", evidence, false);
    }
    if point > 0 {
        let comma_file = delimiter == b',';
        let mut evidence = format!(
            "{} {} a point before the fractional part.",
            e.votes(point, &POINT_DECIMAL),
            agree(point, "uses", "use")
        );
        if comma_file {
            evidence += " Fields are separated by commas, and no quoted value has a decimal comma.";
        }
        let confidence = if point >= 3 || comma_file {
            "high"
        } else {
            "medium"
        };
        return det(json!("."), confidence, "number-shapes", evidence, false);
    }
    if delimiter == b',' {
        return det(
            json!("."),
            "high",
            "comma-delimiter",
            "Fields are separated by commas, so numbers use a decimal point unless they are quoted, and no quoted value has a decimal comma.",
            false,
        );
    }
    let ambiguous = e.total(&AMBIGUOUS);
    if ambiguous > 0 {
        let semicolon = delimiter == b';';
        let evidence = format!(
            "{} could be a fraction or a grouped whole number. {}",
            e.votes(ambiguous, &AMBIGUOUS),
            if semicolon {
                "Semicolon-separated files usually come from locales that write decimal commas, so a comma is assumed."
            } else {
                "A decimal point is assumed."
            }
        );
        let value = if semicolon { "," } else { "." };
        return det(
            json!(value),
            "medium",
            "number-shapes-ambiguous",
            evidence,
            false,
        );
    }
    if delimiter == b';' {
        return det(
            json!("."),
            "medium",
            "no-fractions",
            "No number in the sample has a fractional part. Semicolon-separated files often use decimal commas, so the point is only assumed.",
            true,
        );
    }
    det(
        json!("."),
        "high",
        "no-fractions",
        "No number in the sample has a fractional part or digit grouping, so the decimal point changes nothing that was read.",
        false,
    )
}

fn group_shapes(sep: &str) -> &'static [usize] {
    match sep {
        "," => &[COMMA_GROUPS, COMMA_GROUPED_POINT],
        "." => &[POINT_GROUPS, POINT_GROUPED_COMMA],
        _ => &[SPACE_GROUPS, SPACE_GROUPED_POINT, SPACE_GROUPED_COMMA],
    }
}

fn separator_name(sep: &str) -> &'static str {
    match sep {
        "," => "comma",
        "." => "point",
        _ => "space",
    }
}

fn detect_thousands(e: &NumberEvidence, decimal: &str) -> Value {
    let candidates: [&str; 2] = if decimal == "," {
        [".", " "]
    } else {
        [",", " "]
    };
    let mut scored: Vec<(&str, usize)> = candidates
        .iter()
        .map(|&sep| (sep, e.total(group_shapes(sep))))
        .collect();
    scored.sort_by_key(|x| std::cmp::Reverse(x.1));
    let (best, other) = (scored[0], scored[1]);
    if best.1 > 0 {
        let confidence = if best.1 >= 2 && other.1 == 0 {
            "high"
        } else {
            "medium"
        };
        let evidence = format!(
            "{} {} digits with a {}.",
            e.votes(best.1, group_shapes(best.0)),
            agree(best.1, "groups", "group"),
            separator_name(best.0)
        );
        return det(json!(best.0), confidence, "number-shapes", evidence, false);
    }
    // With a decimal comma, '1.234' is a grouped whole number; with a decimal point, so is '1,234'.
    let weak_shape = if decimal == "," {
        AMBIGUOUS_POINT
    } else {
        AMBIGUOUS_COMMA
    };
    let weak = e.counts[weak_shape];
    if weak > 0 {
        let sep = if decimal == "," { "." } else { "," };
        let evidence = format!(
            "{} {} grouped with a {}, given the decimal {}.",
            e.votes(weak, &[weak_shape]),
            agree(weak, "reads as a whole number", "read as whole numbers"),
            separator_name(sep),
            if decimal == "," { "comma" } else { "point" }
        );
        return det(
            json!(sep),
            "medium",
            "number-shapes-ambiguous",
            evidence,
            false,
        );
    }
    det(
        json!(""),
        "high",
        "no-grouping",
        "No number in the sample groups its digits.",
        false,
    )
}

// ---------------------------------------------------------------------------------------------
// Header rows (header.ts)

const ROWS_BELOW: usize = 50;
const NUMERIC_SHARE: f64 = 0.6;

fn known_units() -> &'static std::collections::HashSet<&'static str> {
    static CELL: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
    CELL.get_or_init(|| {
        [
            "psi psia psig kpa kpaa kpag mpa pa bar bara barg mbar atm inhg mmhg",
            "degc degf degr degk °c °f °r c f k deg °",
            "m km cm mm ft in mi yd m2 m3 km2 ft2 ft3 ha acre",
            "bbl stb bbl/d stb/d bopd bwpd bfpd m3/d m3/h sm3 sm3/d nm3 nm3/h scf mscf mmscf scf/d mscf/d mmscf/d mmscfd",
            "mcf mmcf bcf scf/bbl l ml gal gpm l/s l/min kl",
            "kg g t tonne tonnes lb lbm klb kt kg/h kg/s t/d t/h lb/h",
            "s sec min h hr hrs d day days yr",
            "% ppm ppb ppmv ppmw mg/l mg/kg g/l mol% vol% wt% frac fraction",
            "kg/m3 g/cm3 api °api sg lb/ft3",
            "w kw mw gw kwh mwh gj mj kj j btu mmbtu kcal",
            "v a hz rpm m/s ft/s km/h mph kn knots cp cst",
            "co2e tco2e kgco2e",
        ]
        .iter()
        .flat_map(|line| line.split(' '))
        .collect()
    })
}

const NULL_LIKE: [&str; 11] = [
    "na", "n/a", "#n/a", "null", "nan", "none", "nd", "n.d.", "-", "--", "?",
];

fn unit_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    re(&CELL, || {
        let s = JS_SPACE;
        format!(
            r"^(?:%|°[A-Za-z]?|[A-Za-zµμΩ°]{{1,8}}[23²³]?(?:{s}?[/·.*]{s}?[A-Za-zµμΩ°]{{1,8}}[23²³]?){{0,3}}(?:{s}?\((?:a|g|abs)\))?)$"
        )
    })
}

fn format_hint() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    re(&CELL, || {
        r"^[ymdhsYMDHS]{1,4}(?:[-/.: Tt][ymdhsYMDHS]{1,4})*$".into()
    })
}

#[derive(PartialEq)]
enum UnitKind {
    Known,
    Pattern,
}

/// Whether text in brackets, `[...]` or `(...)`, on one line as JavaScript's `.` requires.
fn bracketed(raw: &str) -> bool {
    let pair = (raw.starts_with('[') && raw.ends_with(']'))
        || (raw.starts_with('(') && raw.ends_with(')'));
    pair && raw.len() >= 2 && !raw[1..raw.len() - 1].contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

fn unit_kind(cell: &str) -> Option<UnitKind> {
    let raw = js_trim(cell);
    let brackets = bracketed(raw);
    let text = if brackets {
        js_trim(&raw[1..raw.len() - 1])
    } else {
        raw
    };
    // '[-]' and '(1)' are the usual marks of a dimensionless quantity.
    if brackets && (text == "-" || text == "1") {
        return Some(UnitKind::Known);
    }
    let lower = text.to_lowercase();
    if text.is_empty()
        || utf16_len(text) > 16
        || looks_numeric(text)
        || NULL_LIKE.contains(&lower.as_str())
    {
        return None;
    }
    if known_units().contains(lower.as_str()) {
        return Some(UnitKind::Known);
    }
    unit_pattern().is_match(text).then_some(UnitKind::Pattern)
}

fn numeric_below(rows: &[Vec<String>], col: usize) -> bool {
    let (mut filled, mut numbers) = (0usize, 0usize);
    for row in rows {
        let value = row.get(col).map_or("", |v| js_trim(v));
        if value.is_empty() {
            continue;
        }
        filled += 1;
        if looks_numeric(value) {
            numbers += 1;
        }
    }
    filled > 0 && numbers as f64 / filled as f64 >= NUMERIC_SHARE
}

fn all_numbers(row: &[String]) -> bool {
    let filled: Vec<&String> = row.iter().filter(|c| !js_trim(c).is_empty()).collect();
    !filled.is_empty() && filled.iter().all(|c| looks_numeric(c))
}

fn detect_header_rows(rows: &[Vec<String>]) -> Value {
    let Some(header) = rows.first() else {
        return det(
            json!(1),
            "low",
            "empty",
            "The file has no rows, so one header row is assumed.",
            true,
        );
    };
    if all_numbers(header) {
        return det(
            json!(1),
            "low",
            "header-looks-like-data",
            "Every cell of the first row is a number, so the file may have no header row. The first row is still used as the header.",
            false,
        );
    }
    let Some(candidate) = rows.get(1) else {
        return det(
            json!(1),
            "high",
            "no-data",
            "The file has a header row and no data rows.",
            false,
        );
    };
    let below = &rows[2.min(rows.len())..(2 + ROWS_BELOW).min(rows.len())];
    let (mut filled, mut units, mut known, mut numbers) = (0usize, 0usize, 0usize, 0usize);
    let mut examples: Vec<String> = Vec::new();
    for (col, cell) in candidate.iter().enumerate() {
        let text = js_trim(cell);
        if text.is_empty() || format_hint().is_match(text) {
            continue;
        }
        filled += 1;
        if looks_numeric(text) {
            numbers += 1;
        }
        let Some(kind) = unit_kind(text) else {
            continue;
        };
        if !numeric_below(below, col) {
            continue;
        }
        units += 1;
        if kind == UnitKind::Known {
            known += 1;
        }
        if examples.len() < 3 {
            examples.push(quoted(text));
        }
    }
    let examples = examples.join(", ");
    if numbers == 0 && units > 0 && units * 2 >= filled {
        let confidence = if units >= 2 && known == units {
            "high"
        } else {
            "medium"
        };
        let evidence = format!(
            "The second row holds units ({examples}) above {}, so the header is two rows: names, then units.",
            plural(units as u64, "numeric column")
        );
        return det(json!(2), confidence, "units-row", evidence, false);
    }
    if units > 0 {
        let evidence = format!(
            "{} of the {} cells in the second row look like units ({examples}), but not most of them, so the second row is read as data.",
            format_count(units as u64),
            format_count(filled as u64)
        );
        return det(json!(1), "medium", "units-row-partial", evidence, false);
    }
    det(
        json!(1),
        "high",
        "single-header",
        "The row under the header holds data, not units.",
        false,
    )
}

// ---------------------------------------------------------------------------------------------
// Quote (quote.ts)

fn double_quoted_fields(text: &[u8], delimiter: u8) -> usize {
    let mut count = 0;
    let mut open = false;
    for (i, &c) in text.iter().enumerate() {
        if c != QUOTE {
            continue;
        }
        let before = if i == 0 { LF } else { text[i - 1] };
        if !open && (before == delimiter || before == LF || before == CR) {
            count += 1;
        }
        open = !open;
    }
    count
}

fn detect_quote(text: &[u8], delimiter: u8, records: &[Record]) -> Value {
    let double = double_quoted_fields(text, delimiter);
    let mut single = 0usize;
    let mut example: Option<&str> = None;
    for r in records {
        for f in &r.fields {
            if f.len() >= 2 && f.starts_with('\'') && f.ends_with('\'') {
                single += 1;
                example.get_or_insert(f);
            }
        }
    }
    if single > double {
        let evidence = format!(
            "{} such as {} {} enclosed in single quotes. Only the double quote is a CSV quote, so single quotes stay part of the text.",
            plural(single as u64, "field"),
            quoted(example.unwrap_or("")),
            if single == 1 { "is" } else { "are" }
        );
        return det(json!("\""), "medium", "single-quotes-seen", evidence, false);
    }
    if double > 0 {
        let evidence = format!(
            "{} in the sample {} enclosed in double quotes.",
            plural(double as u64, "field"),
            if double == 1 { "is" } else { "are" }
        );
        return det(json!("\""), "high", "quoted-fields", evidence, false);
    }
    det(
        json!("\""),
        "high",
        "no-quotes",
        "No field in the sample is quoted, so the standard double quote is used.",
        false,
    )
}

// ---------------------------------------------------------------------------------------------
// Sniffing (sniff.ts)

/// Structural settings from the import settings; each replaces its detection.
#[derive(Default)]
struct Overrides {
    delimiter: Option<u8>,
    skip_lines: Option<u64>,
    header_rows: Option<u64>,
    decimal: Option<String>,
    thousands: Option<String>,
}

/// A sniffed file: the SniffResult, with the parts the preview reads kept typed.
pub struct Sniffed {
    format: String,
    options: Value,
    /// In the order the TypeScript lists them, which is the order of the assumptions.
    detections: Vec<(String, Value)>,
    header: Vec<Vec<String>>,
    rows: Vec<(u64, Vec<Raw>)>,
    notes: Vec<Value>,
    decimal: char,
    thousands: String,
    /// A workbook's sheets with their tables (SheetInfo); None for other formats.
    sheets: Option<Vec<Value>>,
}

impl Sniffed {
    fn to_json(&self) -> Value {
        let detections: Map<String, Value> = self.detections.iter().cloned().collect();
        let rows: Vec<Value> = self
            .rows
            .iter()
            .map(|(loc, fields)| {
                let fields: Vec<Value> = fields.iter().map(Raw::to_json).collect();
                json!({ "srcLoc": loc, "fields": fields })
            })
            .collect();
        let mut out = json!({
            "format": self.format,
            "options": self.options,
            "detections": detections,
            "header": self.header,
            "sampleRows": rows,
            "notes": self.notes,
        });
        if let Some(sheets) = &self.sheets {
            out["sheets"] = json!(sheets);
        }
        out
    }

    fn detection(&self, name: &str) -> Option<&Value> {
        self.detections
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
    }
}

/// A sample's header rows, data rows with their lines, and the reader's notes on them.
type Sample = (Vec<Vec<String>>, Vec<(u64, Vec<Raw>)>, Vec<Value>);

/// The header and up to SAMPLE_MAX_ROWS rows, read the way the import reads them.
fn assemble(
    sample: &[u8],
    delimiter: u8,
    skip: u64,
    header_rows: u64,
    complete: bool,
) -> Result<Sample> {
    let mut reader = TableReader::new(&TableLayout {
        delimiter,
        skip_lines: skip,
        header_rows: header_rows as usize,
        batch_rows: SAMPLE_MAX_ROWS,
        keep_blank: false,
    });
    reader.push(sample)?;
    if complete {
        reader.finish()?;
    }
    let mut rows: Vec<(u64, Vec<Raw>)> = Vec::new();
    'batches: for batch in reader.take_all() {
        for r in 0..batch.rows() {
            if rows.len() == SAMPLE_MAX_ROWS {
                break 'batches;
            }
            let fields = (0..batch.width)
                .map(|c| {
                    batch.cell(r, c).map_or(Raw::Null, |b| {
                        Raw::Text(String::from_utf8_lossy(b).into_owned())
                    })
                })
                .collect();
            rows.push((batch.locs[r] as u64, fields));
        }
    }
    // The TypeScript sample stops at its last row, so later rows report nothing.
    let last = if rows.len() == SAMPLE_MAX_ROWS {
        rows.last().map(|r| r.0)
    } else {
        None
    };
    let notes = reader
        .notes
        .iter()
        .filter(|n| n.src_loc.is_some_and(|l| last.is_none_or(|last| l <= last)))
        .map(crate::engine::note_json)
        .collect();
    Ok((reader.header_rows(), rows, notes))
}

fn sniff_text(
    text: &str,
    encoding: &str,
    bom_length: u64,
    file_name: &str,
    overrides: &Overrides,
    truncated: bool,
) -> Result<Sniffed> {
    let sample = if truncated {
        through_last_line_break(text)
    } else {
        text
    }
    .as_bytes();
    let (candidate, delimiter) = match overrides.delimiter {
        Some(d) => (
            analyse_candidate(sample, d),
            from_settings(delimiter_value(d), "delimiter"),
        ),
        None => choose_delimiter(sample, file_name),
    };
    let d = delimiter["value"]
        .as_str()
        .and_then(|s| s.bytes().next())
        .unwrap_or(b',');
    let skip_lines = match overrides.skip_lines {
        Some(n) => from_settings(json!(n), "number of lines to skip"),
        None => detect_skip_lines(&candidate),
    };
    let skip = skip_lines["value"].as_u64().unwrap_or(0);
    let records = records_after_skip(sample, d, skip, !truncated);
    let header_rows = match overrides.header_rows {
        Some(n) => from_settings(json!(n), "number of header rows"),
        None => {
            let scan: Vec<Vec<String>> = records
                .iter()
                .filter(|r| !is_blank(&r.fields))
                .take(HEADER_SCAN_ROWS)
                .map(|r| r.fields.clone())
                .collect();
            detect_header_rows(&scan)
        }
    };
    let header_count = header_rows["value"].as_u64().unwrap_or(1);
    let (header, rows, notes) = assemble(sample, d, skip, header_count, !truncated)?;
    let numbers = collect_number_evidence(&rows);
    let decimal = match &overrides.decimal {
        Some(v) => from_settings(json!(v), "decimal separator"),
        None => {
            let detected = detect_decimal(&numbers, d);
            if overrides.thousands.as_deref() != detected["value"].as_str() {
                detected
            } else {
                // A thousands separator set in the settings rules out the same decimal separator.
                let value = if detected["value"] == "." { "," } else { "." };
                let evidence = format!(
                    "The thousands separator set in the import settings is {}, so the decimal separator is {}.",
                    quoted(overrides.thousands.as_deref().unwrap_or("")),
                    quoted(value)
                );
                det(json!(value), "high", "implied-by-settings", evidence, false)
            }
        }
    };
    let decimal_value = decimal["value"].as_str().unwrap_or(".").to_string();
    let thousands = match &overrides.thousands {
        Some(v) => from_settings(json!(v), "thousands separator"),
        None => detect_thousands(&numbers, &decimal_value),
    };
    let thousands_value = thousands["value"].as_str().unwrap_or("").to_string();
    let quote = detect_quote(sample, d, &records);
    let format = if d == b'\t' { "tsv" } else { "csv" };
    let options = json!({
        "format": format,
        "csv": {
            "encoding": encoding,
            "bomLength": bom_length,
            "delimiter": (d as char).to_string(),
            "quote": "\"",
            "skipLines": skip,
            "headerRows": header_count,
            "decimalSeparator": decimal_value,
            "thousandsSeparator": thousands_value,
        },
    });
    Ok(Sniffed {
        format: format.into(),
        options,
        detections: vec![
            ("delimiter".into(), delimiter),
            ("quote".into(), quote),
            ("skipLines".into(), skip_lines),
            ("headerRows".into(), header_rows),
            ("decimalSeparator".into(), decimal),
            ("thousandsSeparator".into(), thousands),
        ],
        header,
        rows,
        notes,
        decimal: decimal_value.chars().next().unwrap_or('.'),
        thousands: thousands_value,
        sheets: None,
    })
}

fn encoding_note(d: &Value) -> Value {
    json!({
        "code": "TW-IMP-004",
        "message": format!(
            "The text encoding {} is assumed. {} If accented letters or symbols such as the degree sign look wrong in the preview, choose another encoding in the import settings.",
            d["value"].as_str().unwrap_or(""),
            d["evidence"].as_str().unwrap_or("")
        ),
        "detail": { "encoding": d["value"], "confidence": d["confidence"], "method": d["method"] },
    })
}

/// The file to preview.
pub struct Source<'a> {
    pub path: &'a Path,
    pub name: &'a str,
    pub size: u64,
}

fn read_head(src: &Source) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(PREVIEW_MAX_BYTES.min(src.size as usize));
    std::fs::File::open(src.path)?
        .take(PREVIEW_MAX_BYTES as u64)
        .read_to_end(&mut head)?;
    Ok(head)
}

fn csv_options_invalid(message: String) -> EngineError {
    EngineError::invalid(
        message,
        "Correct the value passed to the function; this is a defect in the calling code, not in the data.",
    )
}

/// The user's CSV options, checked as csvOptionsOf checks them.
fn user_csv(options: &Value) -> Result<(String, u64, Overrides)> {
    let csv = &options["csv"];
    let count = |name: &str| -> Result<u64> {
        csv[name].as_u64().ok_or_else(|| {
            csv_options_invalid(format!(
                "The CSV option {name} must be a whole number of 0 or more, not {}.",
                csv[name]
            ))
        })
    };
    let text = |name: &str| csv[name].as_str().unwrap_or("\u{0}").to_string();
    let delimiter = text("delimiter");
    let d = match delimiter.as_str() {
        "," | ";" | "\t" | "|" => delimiter.as_bytes()[0],
        _ => {
            return Err(csv_options_invalid(format!(
                "The CSV delimiter {} is not one of , ; tab or |.",
                quoted(&delimiter)
            )));
        }
    };
    if text("quote") != "\"" {
        return Err(csv_options_invalid(format!(
            "The CSV quote {} is not supported; only \" is.",
            quoted(&text("quote"))
        )));
    }
    let bom_length = count("bomLength")?;
    let skip = count("skipLines")?;
    let header_rows = count("headerRows")?;
    let decimal = text("decimalSeparator");
    if decimal != "." && decimal != "," {
        return Err(csv_options_invalid(format!(
            "The decimal separator {} is not '.' or ','.",
            quoted(&decimal)
        )));
    }
    let thousands = text("thousandsSeparator");
    if !["", ",", ".", " "].contains(&thousands.as_str()) {
        return Err(csv_options_invalid(format!(
            "The thousands separator {} is not '', ',', '.' or ' '.",
            quoted(&thousands)
        )));
    }
    if thousands == decimal {
        return Err(csv_options_invalid(format!(
            "The thousands and decimal separators are both {}.",
            quoted(&decimal)
        )));
    }
    let encoding = text("encoding");
    Ok((
        encoding,
        bom_length,
        Overrides {
            delimiter: Some(d),
            skip_lines: Some(skip),
            header_rows: Some(header_rows),
            decimal: Some(decimal),
            thousands: Some(thousands),
        },
    ))
}

/// Sniffs a delimited-text file (sniffSource): detected from its first MiB, or with the options
/// the user chose in the import settings, which are taken as given.
pub fn sniff_source(conn: &Connection, src: &Source, options: &Value) -> Result<Sniffed> {
    let head = read_head(src)?;
    let truncated = src.size > head.len() as u64;
    let format = if options.is_null() {
        detect_format(&head, src.name)?.to_string()
    } else {
        match options["format"].as_str() {
            Some(f @ ("csv" | "tsv" | "xlsx" | "parquet" | "json")) => f.to_string(),
            other => {
                return Err(EngineError::unsupported(format!(
                    "the import preview of {} files",
                    other.unwrap_or("other").to_uppercase()
                )));
            }
        }
    };
    if format == "json" {
        return sniff_json(src, &head, options);
    }
    if format == "xlsx" {
        return sniff_xlsx(src, options);
    }
    if format == "parquet" {
        let mut s = sniff_parquet(conn, src)?;
        // Settings chosen for the file read it again with them (resniffByReading).
        if !options.is_null() && &s.options != options {
            s.options = options.clone();
        }
        return Ok(s);
    }
    let e = sniff_encoding(&head);
    let text = decode_all(&head, e.value, e.bom_length)?;
    let mut base = sniff_text(
        &text,
        e.value,
        e.bom_length,
        src.name,
        &Overrides::default(),
        truncated,
    )?;
    if e.detection["assumed"] == true {
        base.notes.insert(0, encoding_note(&e.detection));
    }
    base.detections
        .insert(0, ("encoding".into(), e.detection.clone()));
    base.format = format.clone();
    if options.is_null() || &base.options == options {
        return Ok(base);
    }
    let (encoding, bom_length, overrides) = user_csv(options)?;
    let text = decode_all(&head, &encoding, bom_length)?;
    let mut s = sniff_text(
        &text, &encoding, bom_length, src.name, &overrides, truncated,
    )?;
    let encoding_detection = if e.detection["value"] == encoding.as_str() {
        e.detection
    } else {
        user_value(
            json!(encoding),
            "Chosen by the user in the import settings.",
        )
    };
    s.detections
        .insert(0, ("encoding".into(), encoding_detection));
    s.format = format;
    s.options = options.clone();
    Ok(s)
}

/// The first rows of a JSON file read with a layout, from the start of the file.
fn json_rows(
    path: &Path,
    layout: &crate::json::Layout,
    limit: usize,
) -> Result<Vec<(u64, Vec<Raw>)>> {
    let mut file = std::fs::File::open(path)?;
    let mut head = Vec::new();
    (&mut file)
        .take(PREVIEW_MAX_BYTES as u64)
        .read_to_end(&mut head)?;
    let e = sniff_encoding(&head);
    let mut decoder = TextDecoder::new(e.value, e.bom_length)?;
    let mut records = crate::json::Records::new(layout);
    let mut columns = crate::json::RecordColumns::default();
    let rows = std::cell::RefCell::new(Vec::new());
    let mut take = |loc: u64, v: crate::json::J| -> Result<()> {
        let mut rows = rows.borrow_mut();
        if rows.len() < limit {
            let fields = columns.row_of(&crate::json::members(v));
            rows.push((loc, fields));
        }
        Ok(())
    };
    // The sample stops at its last row, as the TypeScript reader stops reading there.
    let full = |rows: &std::cell::RefCell<Vec<(u64, Vec<Raw>)>>| rows.borrow().len() >= limit;
    let mut utf8 = Vec::new();
    decoder.decode(&head, &mut utf8);
    records.push(&utf8, &mut take)?;
    let mut buf = vec![0u8; 1 << 20];
    while !full(&rows) {
        let n = file.read(&mut buf)?;
        if n == 0 {
            utf8.clear();
            decoder.finish(&mut utf8);
            records.push(&utf8, &mut take)?;
            records.finish(&mut take)?;
            break;
        }
        utf8.clear();
        decoder.decode(&buf[..n], &mut utf8);
        records.push(&utf8, &mut take)?;
    }
    Ok(rows.into_inner())
}

/// A JSON file's sniff (json/importer.ts sniff): the layout and the keys from at most its first
/// MiB, with those records as the sample.
fn sniff_json(src: &Source, head: &[u8], options: &Value) -> Result<Sniffed> {
    let complete = head.len() as u64 >= src.size;
    let e = sniff_encoding(head);
    let text = decode_all(head, e.value, e.bom_length)?;
    let detected = crate::json::detect_layout(&text, complete)?;
    let mut records = crate::json::Records::new(&detected.layout);
    let mut columns = crate::json::RecordColumns::default();
    let mut rows = Vec::new();
    let mut take = |loc: u64, v: crate::json::J| -> Result<()> {
        let fields = columns.row_of(&crate::json::members(v));
        if rows.len() < SAMPLE_MAX_ROWS {
            rows.push((loc, fields));
        }
        Ok(())
    };
    records.push(text.as_bytes(), &mut take)?;
    // A cut-off head ends mid-document by design; only a whole file must be a complete document.
    if complete {
        records.finish(&mut take)?;
    }
    let mut detections = vec![("encoding".to_string(), e.detection)];
    detections.extend(crate::json::detections(
        &detected,
        &columns,
        records.count(),
        complete,
    ));
    let mut s = Sniffed {
        format: "json".into(),
        options: json!({
            "format": "json",
            "json": { "layout": detected.layout.name(), "member": detected.layout.member(), "nested": "json-text" },
        }),
        detections,
        header: vec![columns.keys.clone()],
        rows,
        notes: Vec::new(),
        decimal: '.',
        thousands: String::new(),
        sheets: None,
    };
    // Settings chosen for the file read it again with them (resniffByReading).
    if !options.is_null() && &s.options != options {
        let layout = crate::json::Layout::of_options(&options["json"]);
        s.rows = json_rows(src.path, &layout, SAMPLE_MAX_ROWS)?;
        s.options = options.clone();
    }
    Ok(s)
}

/// A workbook's sniff (xlsx/importer.ts sniff): its sheets and their tables, the chosen table's
/// flattened header and first rows. Settings chosen for the file read it again with them
/// (sniffXlsxWith).
fn sniff_xlsx(src: &Source, options: &Value) -> Result<Sniffed> {
    let mut x = crate::xlsx::sniff(src.path)?;
    if !options.is_null() && &x.options != options {
        x = crate::xlsx::sniff_with(src.path, options, &x)?;
    }
    Ok(Sniffed {
        format: "xlsx".into(),
        options: x.options,
        detections: x.detections,
        header: x.header,
        rows: x.rows,
        notes: x.notes.iter().map(crate::engine::note_json).collect(),
        decimal: '.',
        thousands: String::new(),
        sheets: Some(x.sheets),
    })
}

/// A Parquet file's sniff (parquet/import.ts sniff): the columns and row count from its footer,
/// and its first rows as typed fields.
fn sniff_parquet(conn: &Connection, src: &Source) -> Result<Sniffed> {
    let meta = crate::parquet::metadata(conn, src.path)?;
    let mut rows = Vec::new();
    crate::parquet::read_rows(
        conn,
        src.path,
        &meta,
        Some(meta.rows.min(SAMPLE_MAX_ROWS as u64)),
        &mut |loc, fields| {
            rows.push((loc, fields));
            Ok(true)
        },
    )?;
    Ok(Sniffed {
        format: "parquet".into(),
        options: json!({ "format": "parquet", "parquet": { "nested": "json-text" } }),
        detections: crate::parquet::detections(&meta),
        header: vec![meta.names.clone()],
        rows,
        notes: Vec::new(),
        decimal: '.',
        thousands: String::new(),
        sheets: None,
    })
}

// ---------------------------------------------------------------------------------------------
// Overrides and templates (overrides.ts, templates.ts)

/// The column overrides from the preview or a template, applied to the plans (applyOverrides).
pub fn apply_overrides(plans: Vec<Value>, overrides: &[Value]) -> Result<Vec<Value>> {
    for o in overrides {
        if !plans.iter().any(|p| p["id"] == o["columnId"]) {
            let id = o["columnId"].as_str().unwrap_or("");
            return Err(EngineError::not_found(
                format!("There is no column {id} in this import."),
                "Refresh the preview and choose a listed column.",
            ));
        }
    }
    let user = |v: &Value| user_value(v.clone(), "Set by the user.");
    let mut out = Vec::with_capacity(plans.len());
    for mut plan in plans {
        let id = plan["id"].clone();
        for o in overrides.iter().filter(|o| o["columnId"] == id) {
            if let Some(name) = o.get("name") {
                let name = js_trim(name.as_str().unwrap_or(""));
                if name.is_empty() {
                    return Err(EngineError::invalid(
                        format!(
                            "The new name for column {} is empty.",
                            plan["id"].as_str().unwrap_or("")
                        ),
                        "Type a column name.",
                    ));
                }
                plan["name"] = json!(name);
            }
            if let Some(t) = o.get("type") {
                plan["type"] = user(t);
            }
            if let Some(unit) = o.get("unit") {
                if unit.is_null() {
                    plan["unit"] = user(&Value::Null);
                    plan["quantity"] = Value::Null;
                } else {
                    let code = unit.as_str().unwrap_or("");
                    let Some(u) = get_unit(code) else {
                        return Err(EngineError::new(
                            "UNIT_UNKNOWN",
                            format!("The unit \"{code}\" is not in the unit registry."),
                            "Choose a unit from the list, or leave the column without a unit.",
                        ));
                    };
                    plan["unit"] = user(&json!(u.code));
                    plan["quantity"] = json!(u.quantity);
                }
            }
            for key in ["role", "nullMarkers", "dateFormat", "timezone"] {
                if let Some(v) = o.get(key) {
                    plan[key] = user(v);
                }
            }
        }
        out.push(plan);
    }
    Ok(out)
}

/// The plan column each template column applies to, in template order, or None when one is missing.
fn template_pairs<'a>(
    template: &'a Value,
    plans: &'a [Value],
) -> Option<Vec<(&'a Value, &'a Value)>> {
    let mut used: Vec<&Value> = Vec::new();
    let mut out = Vec::new();
    for t in template["columns"].as_array()? {
        let plan = plans
            .iter()
            .find(|p| !used.contains(&&p["id"]) && p["sourceHeader"] == t["sourceHeader"])?;
        used.push(&plan["id"]);
        out.push((t, plan));
    }
    Some(out)
}

/// The template that fits a file's columns (matchTemplate): the one covering the most columns,
/// then the most recently saved, then the first by name.
pub fn match_template<'a>(templates: &'a [Value], plans: &[Value]) -> Option<&'a Value> {
    let mut fitting: Vec<&Value> = templates
        .iter()
        .filter(|t| template_pairs(t, plans).is_some())
        .collect();
    let columns = |t: &Value| t["columns"].as_array().map_or(0, Vec::len);
    let text = |t: &Value, k: &str| {
        t[k].as_str()
            .unwrap_or("")
            .encode_utf16()
            .collect::<Vec<u16>>()
    };
    fitting.sort_by(|a, b| {
        columns(b)
            .cmp(&columns(a))
            .then_with(|| text(b, "savedAt").cmp(&text(a, "savedAt")))
            .then_with(|| text(a, "name").cmp(&text(b, "name")))
    });
    fitting.first().copied()
}

/// The overrides that make the plan read each column as the template says (applyTemplate).
pub fn apply_template(template: &Value, plans: &[Value]) -> Option<Value> {
    let matched = template_pairs(template, plans)?;
    let mut overrides = Vec::new();
    for (t, plan) in matched {
        let mut o = Map::new();
        o.insert("columnId".into(), plan["id"].clone());
        if t["name"] != plan["name"] {
            o.insert("name".into(), t["name"].clone());
        }
        for key in ["type", "unit", "role", "nullMarkers"] {
            if t.get(key).unwrap_or(&Value::Null) != &plan[key]["value"] {
                o.insert(key.into(), t.get(key).cloned().unwrap_or(Value::Null));
            }
        }
        for key in ["dateFormat", "timezone"] {
            if let Some(v) = t.get(key)
                && plan.get(key).map(|d| &d["value"]) != Some(v)
            {
                o.insert(key.into(), v.clone());
            }
        }
        if o.len() > 1 {
            overrides.push(Value::Object(o));
        }
    }
    Some(json!({ "id": template["id"], "name": template["name"], "overrides": overrides }))
}

/// Says in each overridden detection that the template set it (creditTemplate).
pub fn credit_template(plans: Vec<Value>, applied: &Value) -> Vec<Value> {
    let evidence = format!(
        "From the mapping template \"{}\".",
        applied["name"].as_str().unwrap_or("")
    );
    let overrides = applied["overrides"].as_array().cloned().unwrap_or_default();
    plans
        .into_iter()
        .map(|mut plan| {
            if let Some(o) = overrides.iter().find(|o| o["columnId"] == plan["id"]) {
                for key in [
                    "type",
                    "unit",
                    "role",
                    "nullMarkers",
                    "dateFormat",
                    "timezone",
                ] {
                    if o.get(key).is_some() && plan.get(key).is_some_and(Value::is_object) {
                        plan[key]["method"] = json!("mapping-template");
                        plan[key]["evidence"] = json!(evidence);
                    }
                }
            }
            plan
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// The preview (preview.ts)

fn estimate_rows(src: &Source, s: &Sniffed) -> Option<u64> {
    let n = s.rows.len();
    if src.size <= PREVIEW_MAX_BYTES as u64 && n < SAMPLE_MAX_ROWS {
        return Some(n as u64);
    }
    if s.format == "parquet" {
        // The footer states the row count exactly.
        return s.detection("rowCount").and_then(|d| d["value"].as_u64());
    }
    if s.format == "json" {
        return None;
    }
    if s.format == "xlsx" {
        // The used range of the chosen sheet ends on its last row.
        let sheet = s.options["xlsx"]["sheet"].as_str();
        let dimension = s
            .sheets
            .iter()
            .flatten()
            .find(|i| i["name"].as_str() == sheet)
            .and_then(|i| i["dimension"].as_str())
            .unwrap_or("");
        let digits: String = dimension
            .chars()
            .rev()
            .take_while(char::is_ascii_digit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let last: u64 = digits.parse().ok()?;
        let start = s.options["xlsx"]["dataStartRow"].as_i64().unwrap_or(0);
        return Some((last as i64 - start).max(0) as u64);
    }
    if n == 0 {
        return None;
    }
    let sum: usize = s
        .rows
        .iter()
        .map(|(_, fields)| {
            1 + fields
                .iter()
                .filter(|f| **f != Raw::Null)
                .map(|f| utf16_len(&f.text()) + 1)
                .sum::<usize>()
        })
        .sum();
    let avg = sum as f64 / n as f64;
    (avg > 0.0).then(|| js_round(src.size as f64 / avg) as u64)
}

/// The import preview of a sniffed file with these column overrides (previewSource).
pub fn preview(src: &Source, s: &Sniffed, overrides: &[Value], budget: u64) -> Result<Value> {
    let o = DetectOptions {
        decimal: s.decimal,
        thousands: s.thousands.clone(),
    };
    let fields: Vec<Vec<Raw>> = s.rows.iter().map(|(_, f)| f.clone()).collect();
    let planned = detect_columns(&s.header, &fields, &o);
    let columns = apply_overrides(planned, overrides)?;
    let crs = s
        .detection("crs")
        .filter(|d| !d["value"].is_null())
        .cloned()
        .or_else(|| detect_lat_lon_crs(&columns));
    let parsers = columns
        .iter()
        .map(|c| column_parser(c, s.decimal, &s.thousands))
        .collect::<Result<Vec<_>>>()?;
    let rows: Vec<Value> = s
        .rows
        .iter()
        .take(PREVIEW_ROWS)
        .map(|(_, f)| {
            let cells: Vec<Value> = columns
                .iter()
                .zip(&parsers)
                .map(|(c, parser)| {
                    let index = c["sourceIndex"].as_u64().unwrap_or(0) as usize;
                    match parser.parse_raw(f.get(index).unwrap_or(&Raw::Null)) {
                        Parsed::Value(cell, _) => crate::engine::cell_json(&cell),
                        Parsed::Failed(_) => Value::Null,
                    }
                })
                .collect();
            Value::from(cells)
        })
        .collect();
    let mut extra: Vec<(&str, &Value)> =
        s.detections.iter().map(|(k, v)| (k.as_str(), v)).collect();
    if let Some(c) = &crs {
        extra.push(("crs", c));
    }
    let assumptions = collect_assumptions("preview", &columns, &extra);
    let estimated = estimate_rows(src, s);
    let exceeds =
        estimated.is_some_and(|n| n as f64 * columns.len() as f64 * BYTES_PER_CELL > budget as f64);
    Ok(json!({
        "previewId": format!("pv_{}_{}", src.size, columns.len()),
        "fileName": src.name,
        "size": src.size,
        "sniff": s.to_json(),
        "columns": columns,
        "rows": rows,
        "crs": crs,
        "assumptions": assumptions,
        "estimatedRows": estimated,
        "exceedsBudget": exceeds,
    }))
}

/// The import spec of a file read with these options (previewSource's spec), for an override
/// that changes how the whole file is read.
pub fn plan_spec(conn: &Connection, src: &Source, options: &Value) -> Result<Value> {
    let s = sniff_source(conn, src, options)?;
    let p = preview(src, &s, &[], u64::MAX)?;
    let name = src.name.rsplit(['/', '\\']).next().unwrap_or(src.name);
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
    .trim();
    Ok(json!({
        "fileName": src.name,
        "size": src.size,
        "options": p["sniff"]["options"],
        "columns": p["columns"],
        "detections": p["sniff"]["detections"],
        "crs": p["crs"],
        "datasetName": if stem.is_empty() { "dataset" } else { stem },
    }))
}
