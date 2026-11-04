//! The .xlsx package (workbook.ts, package.ts, shared-strings.ts, styles.ts, numfmt.ts, dates.ts
//! and sheet.ts): the ZIP is read under caps on its entries and on the size it declares it expands
//! to (SAD section 12), the workbook part gives the sheets and the date system, and each sheet is
//! parsed into rows of typed cells when it is asked for. The shared strings and styles are parsed
//! once, when the first sheet is read. Formulas are never evaluated: a formula cell holds the
//! result its producer cached.

use super::xml::{self, Attrs, Handler, decode_xstring, xml_bool};
use super::{
    Cell, CellRange, Row, Sheet, damaged, format_range, not_a_workbook, parse_cell_ref,
    parse_range, sheet_state, used_range,
};
use crate::csv::format_count;
use crate::error::{EngineError, Result};
use crate::parse::Raw;
use crate::time::{MS_PER_DAY, date_text, days_from_civil, iso_from_millis};
use crate::zip::{Entry, read_entries, read_entry};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The cap on the decompressed size of all parts together.
const MAX_INFLATED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;

const SAVE_AS_XLSX_FIX: &str = "Open the file in Excel or LibreOffice and save it as an Excel workbook (.xlsx) without a password, then import the new copy.";
const ZIP_DAMAGED_FIX: &str = "The file was damaged or changed after it was written, or it was not written by a ZIP tool. Use an intact copy of the file, for example the original from its source.";
const ZIP_LIMIT_FIX: &str = "This limit protects against malicious archives (zip bombs). If the file is genuine, split its contents into smaller files and open those.";

fn not_a_zip() -> EngineError {
    not_a_workbook(
        "The file is not an Excel workbook (.xlsx): The file is not a ZIP archive: it has no ZIP end-of-central-directory record.",
        SAVE_AS_XLSX_FIX,
    )
}

/// An archive error as the workbook reader reports it (openZip): bytes that are not a ZIP
/// archive are not a workbook; a damaged archive says what is damaged.
fn zip_error(e: EngineError) -> EngineError {
    if e.code != "PARSE_FAILED" {
        return e;
    }
    let why = e
        .message
        .strip_prefix("The package is not a valid ZIP archive: ")
        .unwrap_or(&e.message);
    if why.starts_with("the end of central directory record is missing") {
        return not_a_zip();
    }
    EngineError::new(
        "PROJECT_INVALID",
        format!("The archive is damaged: {why}"),
        ZIP_DAMAGED_FIX,
    )
}

// ---------------------------------------------------------------------------------------------
// JavaScript's Number() for the attribute values the reader converts

/// Number(text) for decimal, exponent and hexadecimal text; None where JavaScript gives NaN.
fn js_number(text: &str) -> Option<f64> {
    let t = text.trim_matches(crate::units::is_js_space);
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    is_number_text(t).then(|| t.parse::<f64>().ok()).flatten()
}

/// A plain decimal number as SpreadsheetML writes it: [+-]digits[.digits][e[+-]digits].
fn is_number_text(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - s;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == s {
            return false;
        }
    }
    i == b.len()
}

/// nonNegativeInt: a whole number of zero or more, else the fallback.
fn non_negative_int(value: Option<&str>, fallback: i64) -> i64 {
    let Some(v) = value else { return fallback };
    match js_number(v) {
        Some(n) if n.fract() == 0.0 && n >= 0.0 && n <= i64::MAX as f64 => n as i64,
        _ => fallback,
    }
}

// ---------------------------------------------------------------------------------------------
// Number formats (numfmt.ts)

/// Built-in formats; General (0) has no code here because it is reported as None.
fn built_in_format_code(id: i64) -> Option<&'static str> {
    Some(match id {
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "mm-dd-yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    })
}

/// IDs 14 to 22 and 45 to 47 are the built-in date and time formats.
fn is_built_in_date(id: i64) -> bool {
    (14..=22).contains(&id) || (45..=47).contains(&id)
}

/// Whether a date-formatted number shows a calendar date only, or a time of day too.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DateKind {
    Date,
    DateTime,
}

/// The part of a format code that formats a number: quoted text, [bracketed] colours, conditions
/// and locales, escaped characters, the characters after '_' and '*', and the keyword General are
/// removed, as none of them can stand for a date or time part.
fn format_tokens(code: &str) -> String {
    static PARTS: OnceLock<regex::Regex> = OnceLock::new();
    static GENERAL: OnceLock<regex::Regex> = OnceLock::new();
    let parts = PARTS.get_or_init(|| {
        regex::Regex::new(r#"(?s)"[^"]*"?|\[[^\]]*\]?|\\.|[_*]."#).expect("a valid pattern")
    });
    let general =
        GENERAL.get_or_init(|| regex::Regex::new(r"(?i)general").expect("a valid pattern"));
    general
        .replace_all(&parts.replace_all(code, ""), "")
        .into_owned()
}

/// Date when the format shows only a calendar date, DateTime when it shows a time of day, None
/// when it is not a date format.
pub fn date_format_kind(id: i64, code: Option<&str>) -> Option<DateKind> {
    let Some(code) = code.or_else(|| built_in_format_code(id)) else {
        return is_built_in_date(id).then_some(DateKind::Date);
    };
    let tokens = format_tokens(code).to_lowercase();
    let has_date = tokens.contains(['d', 'm', 'y']);
    let has_time =
        tokens.contains(['h', 's']) || tokens.contains("am/pm") || tokens.contains("a/p");
    if has_time {
        return Some(DateKind::DateTime);
    }
    if has_date {
        return Some(DateKind::Date);
    }
    is_built_in_date(id).then_some(DateKind::Date)
}

/// A cell style's number format: its code (None for General) and whether it shows a date.
#[derive(Clone, Debug, Default)]
pub struct CellFormat {
    pub date_kind: Option<DateKind>,
}

/// The format of a style's number format ID, with the workbook's own codes first.
pub fn cell_format(id: i64, custom: &HashMap<i64, String>) -> CellFormat {
    let code = custom
        .get(&id)
        .map(String::as_str)
        .or_else(|| built_in_format_code(id));
    let code = code.filter(|c| !c.eq_ignore_ascii_case("general"));
    CellFormat {
        date_kind: date_format_kind(id, code),
    }
}

// ---------------------------------------------------------------------------------------------
// Dates (dates.ts)

/// Days from each epoch to 1970-01-01.
const DAYS_1899_12_30: f64 = 25_569.0;
const DAYS_1899_12_31: i64 = 25_568;
const DAYS_1904_01_01: f64 = 24_107.0;
/// 9999-12-31T23:59:59.999Z, the last instant a DateTimeCell can hold.
const MAX_UNIX_MS: i64 = 253_402_300_799_999;
/// 0001-01-01T00:00:00.000Z, the first instant a DateTimeCell can hold.
const MIN_UNIX_MS: i64 = -62_135_596_800_000;

/// Milliseconds since 1970 of a serial, or None outside 1899-12-31 .. 9999-12-31. Serial 60 is
/// the phantom 1900-02-29 of the 1900 system, read as 1900-02-28.
fn serial_to_unix_ms(serial: f64, date1904: bool) -> Option<i64> {
    if !serial.is_finite() || serial < 0.0 {
        return None;
    }
    let mut day = serial.floor();
    let mut ms = ((serial - day) * MS_PER_DAY as f64).round();
    if ms == MS_PER_DAY as f64 {
        day += 1.0;
        ms = 0.0;
    }
    let epoch = if date1904 {
        DAYS_1904_01_01
    } else if day < 60.0 {
        DAYS_1899_12_31 as f64
    } else {
        DAYS_1899_12_30
    };
    let unix_ms = (day - epoch) * MS_PER_DAY as f64 + ms;
    (unix_ms <= MAX_UNIX_MS as f64).then_some(unix_ms as i64)
}

fn date_cell_at(unix_ms: i64) -> Raw {
    Raw::Date(date_text(unix_ms.div_euclid(MS_PER_DAY)))
}

fn date_time_cell_at(unix_ms: i64) -> Raw {
    Raw::DateTime(iso_from_millis(unix_ms))
}

/// The value of a date-formatted number: a format that shows a time always gives a DateTime, so
/// a column of timestamps does not turn into dates at midnight. None outside Excel's dates.
pub fn serial_to_date_value(serial: f64, date1904: bool, kind: DateKind) -> Option<Raw> {
    let unix_ms = serial_to_unix_ms(serial, date1904)?;
    Some(if kind == DateKind::Date && serial.fract() == 0.0 {
        date_cell_at(unix_ms)
    } else {
        date_time_cell_at(unix_ms)
    })
}

fn digits(t: &str, n: usize) -> Option<i64> {
    (t.len() == n && t.bytes().all(|b| b.is_ascii_digit()))
        .then(|| t.parse().ok())
        .flatten()
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// Milliseconds into the day of a clock time; None when a part is out of range.
fn parse_clock(h: &str, m: &str, s: Option<&str>, fraction: Option<&str>) -> Option<f64> {
    let (h, m) = (digits(h, 2)?, digits(m, 2)?);
    let s = match s {
        Some(s) => digits(s, 2)?,
        None => 0,
    };
    if h > 23 || m > 59 || s > 59 {
        return None;
    }
    let frac: f64 = format!("0{}", fraction.unwrap_or("")).parse().ok()?;
    let ms = (frac * 1000.0).round();
    Some((((h * 60 + m) * 60 + s) * 1000) as f64 + ms)
}

/// A clock time's hours, minutes, seconds and fraction, and the text after it.
type ClockParts<'a> = (&'a str, &'a str, Option<&'a str>, Option<&'a str>, &'a str);

/// 'HH:mm', 'HH:mm:ss' or 'HH:mm:ss.fff' at the start of `t`: the parts and what follows.
fn clock_parts(t: &str) -> Option<ClockParts<'_>> {
    if t.as_bytes().get(2) != Some(&b':') {
        return None;
    }
    let (h, m) = (t.get(0..2)?, t.get(3..5)?);
    let mut rest = t.get(5..)?;
    let mut s = None;
    let mut frac = None;
    if let Some(after) = rest.strip_prefix(':') {
        s = Some(after.get(..2)?);
        rest = after.get(2..)?;
        if let Some(digits_after) = rest.strip_prefix('.') {
            let n = digits_after.bytes().take_while(u8::is_ascii_digit).count();
            if n == 0 {
                return None;
            }
            frac = Some(&rest[..n + 1]);
            rest = &rest[n + 1..];
        }
    }
    Some((h, m, s, frac, rest))
}

/// Milliseconds east of UTC in a zone designator such as '+02:00'; 0 for 'Z' or none.
fn zone_offset_ms(zone: &str) -> Option<i64> {
    if zone.is_empty() || zone == "Z" {
        return Some(0);
    }
    let sign = match zone.as_bytes()[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let rest = &zone[1..];
    let (hh, mm) = match rest.len() {
        4 => (rest.get(0..2)?, rest.get(2..4)?),
        5 if rest.as_bytes()[2] == b':' => (rest.get(0..2)?, rest.get(3..5)?),
        _ => return None,
    };
    Some(sign * (digits(hh, 2)? * 60 + digits(mm, 2)?) * 60_000)
}

/// An ISO 8601 date, date-time or time of day: its instant and whether it has a time.
fn parse_iso(text: &str) -> Option<(f64, bool)> {
    let time_text = text.strip_prefix('T').unwrap_or(text);
    if let Some((h, m, s, frac, rest)) = clock_parts(time_text)
        && rest.is_empty()
    {
        let clock = parse_clock(h, m, s, frac)?;
        return Some(((-DAYS_1899_12_31 * MS_PER_DAY) as f64 + clock, true));
    }
    let b = text.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, mo, d) = (
        digits(text.get(0..4)?, 4)?,
        digits(text.get(5..7)?, 2)?,
        digits(text.get(8..10)?, 2)?,
    );
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) {
        return None;
    }
    let midnight = (days_from_civil(y, mo, d) * MS_PER_DAY) as f64;
    let rest = &text[10..];
    if rest.is_empty() {
        return Some((midnight, false));
    }
    let sep = rest.as_bytes()[0];
    if sep != b'T' && sep != b' ' {
        return None;
    }
    let (h, m, s, frac, zone) = clock_parts(&rest[1..])?;
    let clock = parse_clock(h, m, s, frac)?;
    let offset = zone_offset_ms(zone)?;
    Some((midnight + clock - offset as f64, true))
}

/// The value of a t="d" cell, whose text is an ISO 8601 date, date-time or time. A time without a
/// zone is read as UTC. None when the text is not such a value or falls outside 0001..9999.
pub fn iso_to_date_value(text: &str, kind: Option<DateKind>) -> Option<Raw> {
    let (ms, has_time) = parse_iso(text.trim_matches(crate::units::is_js_space))?;
    if ms > MAX_UNIX_MS as f64 || ms < MIN_UNIX_MS as f64 {
        return None;
    }
    let unix_ms = ms as i64;
    let midnight = unix_ms % MS_PER_DAY == 0;
    let as_date = match kind {
        Some(DateKind::DateTime) => false,
        _ => !has_time || (kind == Some(DateKind::Date) && midnight),
    };
    Some(if as_date {
        date_cell_at(unix_ms)
    } else {
        date_time_cell_at(unix_ms)
    })
}

// ---------------------------------------------------------------------------------------------
// The package (package.ts)

struct Relationship {
    kind: String,
    /// Package path without a leading slash; external targets are left as written.
    target: String,
    external: bool,
}

impl Relationship {
    /// Transitional and strict relationship types match by their last segment, e.g. 'worksheet'.
    fn is(&self, kind: &str) -> bool {
        self.kind.ends_with(&format!("/{kind}"))
    }
}

/// 'xl/workbook.xml' -> 'xl/_rels/workbook.xml.rels'; '' (the package itself) -> '_rels/.rels'.
fn rels_part_of(part: &str) -> String {
    let slash = part.rfind('/').map_or(0, |i| i + 1);
    format!("{}_rels/{}.rels", &part[..slash], &part[slash..])
}

/// A URI segment with its %XX escapes decoded (decodeURIComponent); a malformed escape, or bytes
/// that are not UTF-8, keep the segment as written.
fn decode_segment(segment: &str) -> String {
    if !segment.contains('%') {
        return segment.to_string();
    }
    let b = segment.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let byte = b
                .get(i + 1..i + 3)
                .filter(|h| h.iter().all(u8::is_ascii_hexdigit))
                .and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
            let Some(byte) = byte else {
                return segment.to_string();
            };
            out.push(byte);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_string())
}

/// Resolves a relationship target against its source part, following '.' and '..' segments.
fn resolve_target(source_part: &str, target: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    if !target.starts_with('/') {
        let mut base: Vec<&str> = source_part.split('/').collect();
        base.pop();
        segments.extend(base);
    }
    segments.extend(target.split('/'));
    let mut out: Vec<String> = Vec::new();
    for s in segments {
        match s {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            _ => out.push(decode_segment(s)),
        }
    }
    out.join("/")
}

/// The sheets of the workbook part with their relationship IDs.
struct SheetEntry {
    name: String,
    state: &'static str,
    rel_id: String,
}

/// An open .xlsx package: its parts, the workbook's sheets and relationships, and the shared
/// strings and styles once a sheet has needed them.
pub struct Package {
    path: PathBuf,
    entries: Vec<Entry>,
    by_name: HashMap<String, usize>,
    by_lower: HashMap<String, usize>,
    sheets: Vec<SheetEntry>,
    /// The workbook part's relationships in document order (a repeated ID keeps its place).
    rels: Vec<(String, Relationship)>,
    shared_strings: Option<Vec<String>>,
    styles: Option<Vec<CellFormat>>,
}

impl Package {
    /// The ZIP entry of a part: by its name, or failing that ignoring case, as OPC part names are.
    fn find(&self, part: &str) -> Option<usize> {
        self.by_name
            .get(part)
            .or_else(|| self.by_lower.get(&part.to_lowercase()))
            .copied()
    }

    fn read(&self, part: &str) -> Result<Vec<u8>> {
        let i = self
            .find(part)
            .ok_or_else(|| damaged(format!("the part {part} is missing.")))?;
        let mut out = Vec::with_capacity(self.entries[i].size as usize);
        read_entry(&self.path, &self.entries[i], &mut |b| {
            out.extend_from_slice(b);
            Ok(())
        })
        .map_err(zip_error)?;
        Ok(out)
    }

    /// The relationships of a part; none when it has no relationships part.
    fn relationships(&self, part: &str) -> Result<Vec<(String, Relationship)>> {
        let rels_part = rels_part_of(part);
        let mut rels: Vec<(String, Relationship)> = Vec::new();
        if self.find(&rels_part).is_none() {
            return Ok(rels);
        }
        struct Rels<'a> {
            part: &'a str,
            out: &'a mut Vec<(String, Relationship)>,
        }
        impl Handler for Rels<'_> {
            fn open(&mut self, name: &str, attrs: &Attrs, _: bool) -> Result<()> {
                if name != "Relationship" {
                    return Ok(());
                }
                let (Some(id), Some(target)) = (attrs.get("Id"), attrs.get("Target")) else {
                    return Ok(());
                };
                let external = attrs.get("TargetMode") == Some("External");
                let rel = Relationship {
                    kind: attrs.get("Type").unwrap_or("").to_string(),
                    target: if external {
                        target.to_string()
                    } else {
                        resolve_target(self.part, target)
                    },
                    external,
                };
                match self.out.iter_mut().find(|(k, _)| k == id) {
                    Some(slot) => slot.1 = rel,
                    None => self.out.push((id.to_string(), rel)),
                }
                Ok(())
            }
        }
        let bytes = self.read(&rels_part)?;
        xml::parse(
            &bytes,
            &rels_part,
            &mut Rels {
                part,
                out: &mut rels,
            },
        )?;
        Ok(rels)
    }

    /// The part of the first internal relationship of a kind, when the package has it.
    fn part_of(&self, kind: &str) -> Option<String> {
        let rel = self.rels.iter().find(|(_, r)| !r.external && r.is(kind))?;
        self.find(&rel.1.target)
            .map(|i| self.entries[i].name.clone())
    }

    fn shared_strings(&mut self) -> Result<&[String]> {
        if self.shared_strings.is_none() {
            let strings = match self.part_of("sharedStrings") {
                Some(part) => parse_shared_strings(&self.read(&part)?, &part)?,
                None => Vec::new(),
            };
            self.shared_strings = Some(strings);
        }
        Ok(self.shared_strings.as_deref().unwrap_or(&[]))
    }

    fn styles(&mut self) -> Result<&[CellFormat]> {
        if self.styles.is_none() {
            let styles = match self.part_of("styles") {
                Some(part) => parse_styles(&self.read(&part)?, &part)?,
                None => Vec::new(),
            };
            self.styles = Some(styles);
        }
        Ok(self.styles.as_deref().unwrap_or(&[]))
    }

    /// Parses one worksheet; a chart or dialog sheet holds no cells.
    pub fn read_sheet(&mut self, name: &str, date1904: bool) -> Result<Sheet> {
        let Some(entry) = self.sheets.iter().find(|s| s.name == name) else {
            return Err(damaged(format!("the sheet \"{name}\" has no part.")));
        };
        let state = entry.state;
        let Some((_, rel)) = self.rels.iter().find(|(k, _)| *k == entry.rel_id) else {
            return Err(damaged(format!("the sheet \"{name}\" has no part.")));
        };
        if rel.external || !rel.is("worksheet") {
            return Ok(Sheet::empty(name, state));
        }
        let target = rel.target.clone();
        let bytes = self.read(&target)?;
        self.shared_strings()?;
        self.styles()?;
        let ctx = SheetCtx {
            name,
            state,
            date1904,
            shared_strings: self.shared_strings.as_deref().unwrap_or(&[]),
            styles: self.styles.as_deref().unwrap_or(&[]),
        };
        parse_sheet(&bytes, &target, &ctx)
    }
}

/// A workbook's sheets in workbook order, each with its state.
pub type SheetList = Vec<(String, &'static str)>;

/// Opens an .xlsx package: its sheets in workbook order and its date system.
pub fn open(path: &Path) -> Result<(Package, SheetList, bool)> {
    if std::fs::metadata(path)?.len() < 22 {
        return Err(not_a_zip());
    }
    let entries = read_entries(path).map_err(zip_error)?;
    if entries.len() > MAX_ENTRIES {
        return Err(EngineError::new(
            "PROJECT_INVALID",
            format!(
                "The archive has {} entries, more than the limit of {}.",
                format_count(entries.len() as u64),
                format_count(MAX_ENTRIES as u64)
            ),
            ZIP_LIMIT_FIX,
        ));
    }
    let total: u64 = entries.iter().map(|e| e.size).sum();
    if total > MAX_INFLATED_BYTES {
        return Err(EngineError::new(
            "PROJECT_INVALID",
            format!(
                "The archive would expand to {} bytes, more than the limit of {} bytes.",
                format_count(total),
                format_count(MAX_INFLATED_BYTES)
            ),
            ZIP_LIMIT_FIX,
        ));
    }
    let mut by_name = HashMap::new();
    let mut by_lower = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        if by_name.insert(e.name.clone(), i).is_some() {
            return Err(EngineError::new(
                "PROJECT_INVALID",
                format!(
                    "The archive is damaged: the entry \"{}\" appears more than once.",
                    e.name
                ),
                ZIP_DAMAGED_FIX,
            ));
        }
        by_lower.insert(e.name.to_lowercase(), i);
    }
    let mut pkg = Package {
        path: path.to_path_buf(),
        entries,
        by_name,
        by_lower,
        sheets: Vec::new(),
        rels: Vec::new(),
        shared_strings: None,
        styles: None,
    };
    // The workbook part named by the package relationships, or the conventional path.
    let package_rels = pkg.relationships("")?;
    let target = package_rels
        .iter()
        .find(|(_, r)| r.is("officeDocument"))
        .map_or_else(|| "xl/workbook.xml".to_string(), |(_, r)| r.target.clone());
    let Some(found) = pkg.find(&target) else {
        return Err(not_a_workbook(
            "The file is a ZIP archive but not an Excel workbook: it has no workbook part.",
            "Check that the file is an Excel workbook (.xlsx); other ZIP-based files, such as .docx, cannot be imported here.",
        ));
    };
    let part = pkg.entries[found].name.clone();
    let (sheets, date1904) = parse_workbook_part(&pkg.read(&part)?, &part)?;
    pkg.rels = pkg.relationships(&part)?;
    let list = sheets.iter().map(|s| (s.name.clone(), s.state)).collect();
    pkg.sheets = sheets;
    Ok((pkg, list, date1904))
}

fn parse_workbook_part(bytes: &[u8], part: &str) -> Result<(Vec<SheetEntry>, bool)> {
    #[derive(Default)]
    struct Book {
        sheets: Vec<SheetEntry>,
        date1904: bool,
    }
    impl Handler for Book {
        fn open(&mut self, name: &str, attrs: &Attrs, _: bool) -> Result<()> {
            if name == "workbookPr" {
                self.date1904 = xml_bool(attrs.get("date1904")).unwrap_or(false);
            } else if name == "sheet" {
                let (Some(sheet), Some(rel)) = (attrs.get("name"), attrs.get("id")) else {
                    return Err(damaged(
                        "a sheet in the workbook part has no name or no relationship.",
                    ));
                };
                self.sheets.push(SheetEntry {
                    name: sheet.to_string(),
                    state: sheet_state(attrs.get("state")),
                    rel_id: rel.to_string(),
                });
            }
            Ok(())
        }
    }
    let mut book = Book::default();
    xml::parse(bytes, part, &mut book)?;
    Ok((book.sheets, book.date1904))
}

/// The shared string table: each <si> is plain text in one <t>, or rich text in runs whose texts
/// are joined; phonetic guides (<rPh>) are not part of the text.
fn parse_shared_strings(bytes: &[u8], part: &str) -> Result<Vec<String>> {
    #[derive(Default)]
    struct Strings {
        out: Vec<String>,
        in_item: bool,
        in_text: bool,
        phonetic: i64,
        text: String,
    }
    impl Handler for Strings {
        fn open(&mut self, name: &str, _: &Attrs, _: bool) -> Result<()> {
            match name {
                "si" => {
                    self.in_item = true;
                    self.text.clear();
                }
                "rPh" => self.phonetic += 1,
                "t" => self.in_text = self.in_item && self.phonetic == 0,
                _ => {}
            }
            Ok(())
        }
        fn close(&mut self, name: &str) -> Result<()> {
            match name {
                "t" => self.in_text = false,
                "rPh" => self.phonetic -= 1,
                "si" => {
                    self.out.push(decode_xstring(&self.text));
                    self.in_item = false;
                }
                _ => {}
            }
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<()> {
            if self.in_text {
                self.text.push_str(text);
            }
            Ok(())
        }
    }
    let mut s = Strings::default();
    xml::parse(bytes, part, &mut s)?;
    Ok(s.out)
}

/// For each cell style (the index in a cell's s attribute), its number format.
fn parse_styles(bytes: &[u8], part: &str) -> Result<Vec<CellFormat>> {
    #[derive(Default)]
    struct Styles {
        custom: HashMap<i64, String>,
        xf_ids: Vec<i64>,
        in_cell_xfs: bool,
    }
    impl Handler for Styles {
        fn open(&mut self, name: &str, attrs: &Attrs, _: bool) -> Result<()> {
            let int_attr = |v: Option<&str>| non_negative_int(Some(v.unwrap_or("0")), 0);
            match name {
                "numFmt" => {
                    if let Some(code) = attrs.get("formatCode") {
                        self.custom
                            .insert(int_attr(attrs.get("numFmtId")), code.to_string());
                    }
                }
                "cellXfs" => self.in_cell_xfs = true,
                "xf" if self.in_cell_xfs => self.xf_ids.push(int_attr(attrs.get("numFmtId"))),
                _ => {}
            }
            Ok(())
        }
        fn close(&mut self, name: &str) -> Result<()> {
            if name == "cellXfs" {
                self.in_cell_xfs = false;
            }
            Ok(())
        }
    }
    let mut s = Styles::default();
    xml::parse(bytes, part, &mut s)?;
    // numFmts come before cellXfs in the schema, but a lenient producer may reverse them.
    Ok(s.xf_ids
        .iter()
        .map(|&id| cell_format(id, &s.custom))
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Worksheets (sheet.ts)

struct SheetCtx<'a> {
    name: &'a str,
    state: &'static str,
    date1904: bool,
    shared_strings: &'a [String],
    styles: &'a [CellFormat],
}

#[derive(Clone, Copy, PartialEq)]
enum CellType {
    N,
    S,
    B,
    E,
    Str,
    InlineStr,
    D,
}

impl CellType {
    fn name(self) -> &'static str {
        match self {
            CellType::N => "n",
            CellType::S => "s",
            CellType::B => "b",
            CellType::E => "e",
            CellType::Str => "str",
            CellType::InlineStr => "inlineStr",
            CellType::D => "d",
        }
    }
}

fn cell_type(t: &str) -> CellType {
    match t {
        "n" => CellType::N,
        "s" => CellType::S,
        "b" => CellType::B,
        "e" => CellType::E,
        "inlineStr" => CellType::InlineStr,
        "d" => CellType::D,
        _ => CellType::Str,
    }
}

/// What one <c> element held, collected while it is parsed.
struct PendingCell {
    col: u32,
    t: CellType,
    style: i64,
    value: String,
    has_value: bool,
    inline: String,
    has_inline: bool,
    formula: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Value,
    Inline,
}

struct SheetParser<'a> {
    ctx: &'a SheetCtx<'a>,
    rows: Vec<Row>,
    merges: Vec<CellRange>,
    row: Option<(i64, Vec<Cell>)>,
    /// True when the current row's number comes from its r attribute rather than its position.
    row_numbered: bool,
    next_row: i64,
    next_col: i64,
    cell: Option<PendingCell>,
    in_inline: bool,
    phonetic: i64,
    target: Option<Target>,
    /// Elements open around the one being parsed; the worksheet element is at depth 0.
    depth: i64,
    sheet_views: u32,
    frozen: Option<(u32, u32)>,
    auto_filter: Option<CellRange>,
}

fn to_u32(n: i64) -> u32 {
    n.clamp(0, u32::MAX as i64) as u32
}

impl SheetParser<'_> {
    fn open_row(&mut self, attrs: &Attrs) {
        let r = non_negative_int(attrs.get("r"), 0) - 1;
        self.row = Some((if r >= 0 { r } else { self.next_row }, Vec::new()));
        self.row_numbered = r >= 0;
        self.next_col = 0;
    }

    fn open_cell(&mut self, attrs: &Attrs) -> Result<()> {
        let reference = attrs.get("r");
        let at = reference.and_then(parse_cell_ref);
        if let (Some(text), None) = (reference, at) {
            return Err(damaged(format!(
                "a cell in sheet \"{}\" has the invalid reference \"{text}\".",
                self.ctx.name
            )));
        }
        // A cell outside any <row>, or in a row without a number, still says where it belongs.
        match &mut self.row {
            None => {
                self.row = Some((at.map_or(self.next_row, |(r, _)| r as i64), Vec::new()));
                self.row_numbered = at.is_some();
            }
            Some((r, cells)) => {
                if !self.row_numbered
                    && let Some((ar, _)) = at
                    && cells.is_empty()
                {
                    *r = ar as i64;
                    self.row_numbered = true;
                }
            }
        }
        self.cell = Some(PendingCell {
            col: at.map_or(to_u32(self.next_col), |(_, c)| c),
            t: cell_type(attrs.get("t").unwrap_or("n")),
            style: non_negative_int(attrs.get("s"), 0),
            value: String::new(),
            has_value: false,
            inline: String::new(),
            has_inline: false,
            formula: false,
        });
        Ok(())
    }

    fn open_in_cell(&mut self, name: &str) {
        let Some(cell) = self.cell.as_mut() else {
            return;
        };
        match name {
            "v" => {
                cell.has_value = true;
                self.target = Some(Target::Value);
            }
            "f" => cell.formula = true,
            "is" => {
                cell.has_inline = true;
                self.in_inline = true;
            }
            "rPh" => self.phonetic += 1,
            "t" if self.in_inline && self.phonetic == 0 => self.target = Some(Target::Inline),
            _ => {}
        }
    }

    fn close_in_cell(&mut self, name: &str) -> Result<()> {
        match name {
            "v" | "t" => self.target = None,
            "is" => self.in_inline = false,
            "rPh" => self.phonetic -= 1,
            "c" => self.finish_cell()?,
            _ => {}
        }
        Ok(())
    }

    fn finish_cell(&mut self) -> Result<()> {
        let Some(pending) = self.cell.take() else {
            return Ok(());
        };
        self.target = None;
        self.in_inline = false;
        self.phonetic = 0;
        self.next_col = pending.col as i64 + 1;
        let r = self.row.as_ref().map_or(0, |(r, _)| *r);
        let v = self.value_of(&pending, r)?;
        if (!matches!(v, Raw::Null) || pending.formula)
            && let Some((_, cells)) = self.row.as_mut()
        {
            cells.push(Cell {
                c: pending.col,
                is_date: matches!(v, Raw::Date(_) | Raw::DateTime(_)),
                v,
                formula: pending.formula,
                t: pending.t.name(),
            });
        }
        Ok(())
    }

    /// The frozen pane of the first sheet view: the rows and columns above and left of it.
    fn read_pane(&mut self, attrs: &Attrs) {
        if !matches!(attrs.get("state"), Some("frozen" | "frozenSplit")) {
            return;
        }
        let split = |name: &str| {
            js_number(attrs.get(name).unwrap_or("0"))
                .filter(|n| n.is_finite())
                .map_or(0, |n| n.trunc().clamp(0.0, u32::MAX as f64) as u32)
        };
        let (rows, cols) = (split("ySplit"), split("xSplit"));
        if rows > 0 || cols > 0 {
            self.frozen = Some((rows, cols));
        }
    }

    fn value_of(&self, p: &PendingCell, r: i64) -> Result<Raw> {
        let trim = |s: &str| s.trim_matches(crate::units::is_js_space).to_string();
        let date_kind = self
            .ctx
            .styles
            .get(p.style as usize)
            .and_then(|f| f.date_kind);
        Ok(match p.t {
            CellType::N => {
                let text = trim(&p.value);
                if !p.has_value || text.is_empty() {
                    Raw::Null
                } else if !is_number_text(&text) {
                    Raw::Text(text)
                } else {
                    let n: f64 = text.parse().unwrap_or(f64::NAN);
                    date_kind
                        .and_then(|k| serial_to_date_value(n, self.ctx.date1904, k))
                        .unwrap_or(Raw::Number(n))
                }
            }
            CellType::D => {
                if !p.has_value || trim(&p.value).is_empty() {
                    Raw::Null
                } else {
                    iso_to_date_value(&p.value, date_kind).unwrap_or(Raw::Text(p.value.clone()))
                }
            }
            CellType::S => {
                if p.has_value {
                    self.shared_string(&p.value, r, p.col)?
                } else {
                    Raw::Null
                }
            }
            CellType::B => {
                if !p.has_value {
                    Raw::Null
                } else {
                    match trim(&p.value).as_str() {
                        "1" | "true" => Raw::Bool(true),
                        "0" | "false" => Raw::Bool(false),
                        t => Raw::Text(t.to_string()),
                    }
                }
            }
            CellType::E => {
                let t = trim(&p.value);
                if t.is_empty() {
                    Raw::Null
                } else {
                    Raw::Error(t)
                }
            }
            CellType::InlineStr => {
                if p.has_inline {
                    Raw::Text(decode_xstring(&p.inline))
                } else if p.has_value {
                    Raw::Text(decode_xstring(&p.value))
                } else {
                    Raw::Null
                }
            }
            CellType::Str => {
                if p.has_value {
                    Raw::Text(decode_xstring(&p.value))
                } else {
                    Raw::Null
                }
            }
        })
    }

    fn shared_string(&self, text: &str, r: i64, c: u32) -> Result<Raw> {
        let index = js_number(text).filter(|n| n.fract() == 0.0 && *n >= 0.0);
        if let Some(s) = index.and_then(|i| self.ctx.shared_strings.get(i as usize)) {
            return Ok(Raw::Text(s.clone()));
        }
        let at = to_u32(r);
        Err(damaged(format!(
            "cell {} of sheet \"{}\" refers to shared string \"{text}\", which the workbook does not have.",
            format_range(&CellRange {
                sr: at,
                sc: c,
                er: at,
                ec: c
            }),
            self.ctx.name
        )))
    }
}

impl Handler for SheetParser<'_> {
    fn open(&mut self, name: &str, attrs: &Attrs, _: bool) -> Result<()> {
        let depth = self.depth;
        self.depth += 1;
        if self.cell.is_some() {
            self.open_in_cell(name);
            return Ok(());
        }
        match name {
            "row" => self.open_row(attrs),
            "c" => self.open_cell(attrs)?,
            "sheetView" => self.sheet_views += 1,
            "pane" if self.sheet_views == 1 => self.read_pane(attrs),
            // Custom sheet views carry their own autofilters; only the sheet's own one counts.
            "autoFilter" if depth == 1 => {
                self.auto_filter = parse_range(attrs.get("ref").unwrap_or(""));
            }
            "mergeCell" => {
                let range = attrs.get("ref").and_then(parse_range);
                if let Some(m) = range
                    && (m.sr != m.er || m.sc != m.ec)
                {
                    self.merges.push(m);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn close(&mut self, name: &str) -> Result<()> {
        self.depth -= 1;
        if self.cell.is_some() {
            return self.close_in_cell(name);
        }
        if name == "row"
            && let Some((r, cells)) = self.row.take()
        {
            self.next_row = r + 1;
            if !cells.is_empty() {
                self.rows.push(Row {
                    r: to_u32(r),
                    cells,
                });
            }
        }
        Ok(())
    }

    fn text(&mut self, text: &str) -> Result<()> {
        if let (Some(cell), Some(target)) = (self.cell.as_mut(), self.target) {
            match target {
                Target::Value => cell.value.push_str(text),
                Target::Inline => cell.inline.push_str(text),
            }
        }
        Ok(())
    }
}

/// Rows and cells in order, one entry per row and per column; producers may write them out of order.
fn normalised(rows: Vec<Row>) -> Vec<Row> {
    let mut by_row: std::collections::BTreeMap<u32, std::collections::BTreeMap<u32, Cell>> =
        std::collections::BTreeMap::new();
    for row in rows {
        let cells = by_row.entry(row.r).or_default();
        for cell in row.cells {
            cells.insert(cell.c, cell);
        }
    }
    by_row
        .into_iter()
        .map(|(r, cells)| Row {
            r,
            cells: cells.into_values().collect(),
        })
        .collect()
}

fn is_ordered(rows: &[Row]) -> bool {
    let mut last_row: i64 = -1;
    for row in rows {
        if row.r as i64 <= last_row {
            return false;
        }
        last_row = row.r as i64;
        let mut last_col: i64 = -1;
        for cell in &row.cells {
            if cell.c as i64 <= last_col {
                return false;
            }
            last_col = cell.c as i64;
        }
    }
    true
}

fn parse_sheet(bytes: &[u8], part: &str, ctx: &SheetCtx) -> Result<Sheet> {
    let mut p = SheetParser {
        ctx,
        rows: Vec::new(),
        merges: Vec::new(),
        row: None,
        row_numbered: false,
        next_row: 0,
        next_col: 0,
        cell: None,
        in_inline: false,
        phonetic: 0,
        target: None,
        depth: 0,
        sheet_views: 0,
        frozen: None,
        auto_filter: None,
    };
    xml::parse(bytes, part, &mut p)?;
    let rows = if is_ordered(&p.rows) {
        p.rows
    } else {
        normalised(p.rows)
    };
    Ok(Sheet {
        name: ctx.name.to_string(),
        state: ctx.state,
        dimension: used_range(&rows),
        merges: p.merges,
        frozen: p.frozen,
        auto_filter: p.auto_filter,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_serial_dates_in_both_systems() {
        let d = |s: f64, b: bool| serial_to_date_value(s, b, DateKind::Date);
        assert_eq!(d(1.0, false), Some(Raw::Date("1900-01-01".into())));
        assert_eq!(d(59.0, false), Some(Raw::Date("1900-02-28".into())));
        assert_eq!(d(60.0, false), Some(Raw::Date("1900-02-28".into())));
        assert_eq!(d(61.0, false), Some(Raw::Date("1900-03-01".into())));
        assert_eq!(d(45000.0, false), Some(Raw::Date("2023-03-15".into())));
        assert_eq!(d(0.0, true), Some(Raw::Date("1904-01-01".into())));
        assert_eq!(
            d(45000.5, false),
            Some(Raw::DateTime("2023-03-15T12:00:00.000Z".into()))
        );
        assert_eq!(d(-1.0, false), None);
        assert_eq!(d(3e6, false), None);
        assert_eq!(
            serial_to_date_value(45000.0, false, DateKind::DateTime),
            Some(Raw::DateTime("2023-03-15T00:00:00.000Z".into()))
        );
    }

    #[test]
    fn reads_iso_cells() {
        let v = |t: &str, k: Option<DateKind>| iso_to_date_value(t, k);
        assert_eq!(v("2024-02-29", None), Some(Raw::Date("2024-02-29".into())));
        assert_eq!(v("2023-02-29", None), None);
        assert_eq!(
            v("2024-01-02T03:04:05.678+02:00", None),
            Some(Raw::DateTime("2024-01-02T01:04:05.678Z".into()))
        );
        assert_eq!(
            v("2024-01-02T00:00:00Z", Some(DateKind::Date)),
            Some(Raw::Date("2024-01-02".into()))
        );
        assert_eq!(
            v("12:30", None),
            Some(Raw::DateTime("1899-12-31T12:30:00.000Z".into()))
        );
        assert_eq!(v("24:00", None), None);
        assert_eq!(v("tomorrow", None), None);
    }

    #[test]
    fn knows_date_formats() {
        assert_eq!(date_format_kind(14, None), Some(DateKind::Date));
        assert_eq!(date_format_kind(22, None), Some(DateKind::DateTime));
        assert_eq!(date_format_kind(0, None), None);
        assert_eq!(date_format_kind(2, None), None);
        assert_eq!(
            date_format_kind(164, Some("yyyy-mm-dd")),
            Some(DateKind::Date)
        );
        assert_eq!(
            date_format_kind(165, Some("dd/mm/yyyy hh:mm")),
            Some(DateKind::DateTime)
        );
        assert_eq!(date_format_kind(166, Some("\"days\" 0.0")), None);
        assert_eq!(date_format_kind(167, Some("[Red]0.00")), None);
        assert_eq!(date_format_kind(168, Some("General")), None);
    }

    #[test]
    fn resolves_relationship_targets() {
        assert_eq!(
            rels_part_of("xl/workbook.xml"),
            "xl/_rels/workbook.xml.rels"
        );
        assert_eq!(rels_part_of(""), "_rels/.rels");
        assert_eq!(
            resolve_target("xl/workbook.xml", "worksheets/sheet1.xml"),
            "xl/worksheets/sheet1.xml"
        );
        assert_eq!(
            resolve_target("xl/workbook.xml", "/xl/styles.xml"),
            "xl/styles.xml"
        );
        assert_eq!(
            resolve_target("xl/worksheets/sheet1.xml", "../my%20sheet.xml"),
            "xl/my sheet.xml"
        );
    }

    #[test]
    fn converts_numbers_as_javascript_does() {
        assert_eq!(js_number(" 12 "), Some(12.0));
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number("0x1F"), Some(31.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number("inf"), None);
        assert_eq!(js_number("12px"), None);
        assert!(is_number_text("-.5e+3"));
        assert!(!is_number_text("1e"));
        assert!(!is_number_text("."));
    }
}
