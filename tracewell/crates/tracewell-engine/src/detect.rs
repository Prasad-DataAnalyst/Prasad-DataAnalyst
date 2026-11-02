//! Column detection for the import preview, ported from the TypeScript src/detect (columns.ts,
//! types.ts, dates.ts, markers.ts, names.ts, numbers.ts, roles.ts, assumptions.ts): each column's
//! name and unit from the header, its null markers, type, date format, time zone and role from the
//! sample, every one a detection with its confidence and evidence, so both engines plan the same
//! file the same way.

use crate::import::column_parser;
use crate::parse::{DateFormat, Parsed, date_parts, month_day, parse_number};
use crate::units::{get_unit, js_trim, parse_header_unit};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::OnceLock;

/// Rows of the sample that the column detection reads.
pub const SAMPLE_LIMIT: usize = 10_000;

/// A detection (detection()): assumed unless its confidence is high or it is a default.
pub fn det(
    value: Value,
    confidence: &str,
    method: &str,
    evidence: impl Into<String>,
    default: bool,
) -> Value {
    json!({
        "value": value,
        "confidence": confidence,
        "assumed": confidence != "high" || default,
        "source": if default { "default" } else { "detected" },
        "method": method,
        "evidence": evidence.into(),
    })
}

pub struct DetectOptions {
    pub decimal: char,
    pub thousands: String,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a valid pattern"))
}

// ---------------------------------------------------------------------------------------------
// Names (names.ts)

fn placeholder_name(index: usize) -> String {
    format!("Column {}", index + 1)
}

fn column_parts(rows: &[Vec<String>], index: usize) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for row in rows {
        let part = js_trim(row.get(index).map_or("", String::as_str)).to_string();
        if !part.is_empty() && parts.last() != Some(&part) {
            parts.push(part);
        }
    }
    parts
}

/// Names made unique by numbering repeats: 'Rate', 'Rate (2)'.
pub fn unique_names(names: &[String]) -> Vec<String> {
    let mut taken: HashSet<String> = HashSet::new();
    names
        .iter()
        .map(|name| {
            let mut candidate = name.clone();
            let mut n = 2;
            while taken.contains(&candidate) {
                candidate = format!("{name} ({n})");
                n += 1;
            }
            taken.insert(candidate.clone());
            candidate
        })
        .collect()
}

fn header_width(rows: &[Vec<String>]) -> usize {
    rows.iter().map(Vec::len).max().unwrap_or(0)
}

fn flatten_header(rows: &[Vec<String>]) -> Vec<String> {
    let names: Vec<String> = (0..header_width(rows))
        .map(|i| {
            let parts = column_parts(rows, i);
            if parts.is_empty() {
                placeholder_name(i)
            } else {
                parts.join(" / ")
            }
        })
        .collect();
    unique_names(&names)
}

/// A name's words in lower case, camelCase split ('wellName' gives 'well', 'name').
pub fn name_tokens(name: &str) -> Vec<String> {
    static LOWER_UPPER: OnceLock<Regex> = OnceLock::new();
    static UPPER_WORD: OnceLock<Regex> = OnceLock::new();
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let spaced = re(&LOWER_UPPER, r"(\p{Ll})(\p{Lu})").replace_all(name, "$1 $2");
    let spaced = re(&UPPER_WORD, r"(\p{Lu})(\p{Lu}\p{Ll})").replace_all(&spaced, "$1 $2");
    re(&SPLIT, r"[^\p{L}\p{N}]+")
        .split(&spaced.to_lowercase())
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect()
}

fn has_date_hint(tokens: &[String]) -> bool {
    const WORDS: [&str; 8] = [
        "date",
        "datetime",
        "timestamp",
        "time",
        "dt",
        "datum",
        "spud",
        "dated",
    ];
    tokens.iter().any(|t| WORDS.contains(&t.as_str()))
}

fn has_boolean_hint(tokens: &[String]) -> bool {
    const PREFIXES: [&str; 4] = ["is", "has", "was", "can"];
    const WORDS: [&str; 6] = ["flag", "active", "enabled", "valid", "bool", "boolean"];
    tokens
        .first()
        .is_some_and(|t| PREFIXES.contains(&t.as_str()))
        || tokens.iter().any(|t| WORDS.contains(&t.as_str()))
}

// ---------------------------------------------------------------------------------------------
// Numbers (numbers.ts)

fn is_integer_text(text: &str, decimal: char) -> bool {
    let t = js_trim(text);
    !t.contains(decimal) && !t.contains(['e', 'E'])
}

fn has_leading_zero(text: &str, decimal: char) -> bool {
    let t = js_trim(text);
    let t = t.strip_prefix(['+', '-']).unwrap_or(t);
    let int_part = t.split(decimal).next().unwrap_or("");
    let b = int_part.as_bytes();
    b.len() >= 2 && b[0] == b'0' && b[1].is_ascii_digit()
}

fn is_safe_integer(n: f64) -> bool {
    n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

// ---------------------------------------------------------------------------------------------
// Null markers (markers.ts)

/// The default markers that are text rather than numbers.
const TEXT_NULL_MARKERS: [&str; 7] = ["", "NA", "N/A", "#N/A", "NULL", "null", "-"];
const SENTINELS: [f64; 2] = [-999.25, -9999.0];
const SENTINEL_MIN_COUNT: usize = 2;

/// The marker a field matches: its text, or a numeric marker of the same value.
pub fn match_null_marker(raw: Option<&str>, markers: &[String], decimal: char) -> Option<String> {
    let raw = raw?;
    let text = js_trim(raw);
    if markers.iter().any(|m| m == text) {
        return Some(text.to_string());
    }
    let value = parse_number(raw, decimal, "")?;
    markers
        .iter()
        .find(|m| !m.is_empty() && parse_number(m, '.', "") == Some(value))
        .cloned()
}

fn candidate_marker(raw: Option<&str>) -> Option<String> {
    let text = js_trim(raw?);
    if TEXT_NULL_MARKERS.contains(&text) {
        return Some(text.to_string());
    }
    let value = parse_number(text, '.', "").or_else(|| parse_number(text, ',', ""))?;
    SENTINELS
        .contains(&value)
        .then(|| crate::canonical::canonical_number(value))
}

fn is_sentinel(marker: &str) -> bool {
    !marker.is_empty() && marker.parse::<f64>().is_ok_and(|v| SENTINELS.contains(&v))
}

/// The null markers of a column's sample (detectNullMarkers): the text markers found, and the
/// numeric sentinels that repeat.
pub fn detect_null_markers(values: &[Option<&str>]) -> Value {
    let mut tallies: Vec<(String, usize, usize)> = Vec::new();
    for (index, raw) in values.iter().enumerate() {
        let Some(marker) = candidate_marker(*raw) else {
            continue;
        };
        match tallies.iter_mut().find(|t| t.0 == marker) {
            Some(t) => t.1 += 1,
            None => tallies.push((marker, 1, index)),
        }
    }
    tallies.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
    let adopted: Vec<&(String, usize, usize)> = tallies
        .iter()
        .filter(|t| !is_sentinel(&t.0) || t.1 >= SENTINEL_MIN_COUNT)
        .collect();
    let markers: Vec<&String> = adopted.iter().map(|t| &t.0).collect();
    if adopted.is_empty() {
        return det(
            json!(markers),
            "high",
            "marker-list",
            "No null markers found in the sample.",
            false,
        );
    }
    let describe = |t: &(String, usize, usize)| {
        let shown = if t.0.is_empty() {
            "empty text".to_string()
        } else {
            format!("'{}'", t.0)
        };
        format!("{shown} ({}\u{d7})", t.1)
    };
    let found = format!(
        "Found {} in the sample.",
        adopted
            .iter()
            .map(|t| describe(t))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let sentinels: Vec<&str> = adopted
        .iter()
        .filter(|t| is_sentinel(&t.0))
        .map(|t| t.0.as_str())
        .collect();
    if sentinels.is_empty() {
        return det(json!(markers), "high", "marker-list", found, false);
    }
    let assumed = format!(
        "{} repeat and are assumed to mean \"no value\".",
        sentinels.join(" and ")
    );
    det(
        json!(markers),
        "medium",
        "sentinel-frequency",
        format!("{found} {assumed}"),
        false,
    )
}

/// Laboratory below-detection-limit text: '<0.5', 'ND', 'BDL' (isBelowDetectionLimit).
pub fn is_below_detection_limit(text: &str) -> bool {
    static LESS_THAN: OnceLock<Regex> = OnceLock::new();
    let t = js_trim(text);
    if t.is_empty() {
        return false;
    }
    const WORDS: [&str; 9] = [
        "nd", "n.d.", "n/d", "bdl", "<lod", "<loq", "<mdl", "<dl", "<rl",
    ];
    WORDS.contains(&t.to_lowercase().as_str())
        || re(
            &LESS_THAN,
            r"^<[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*[0-9]+(?:[.,][0-9]+)?(?:[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*[^0-9\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}<>][^<>]{0,15})?$",
        )
        .is_match(t)
}

// ---------------------------------------------------------------------------------------------
// Types (types.ts)

const MAJORITY_SHARE: f64 = 0.8;
const EXCEL_MIN_SERIAL: f64 = 3654.0;
const EXCEL_MAX_SERIAL: f64 = 2_958_465.0;

enum Kind {
    Int,
    Num,
    Identifier,
    Bool,
    DateText(crate::parse::DateParts),
    Json,
    Text,
}

fn is_json_text(t: &str) -> bool {
    let object = t.starts_with('{') && t.ends_with('}');
    let array = t.starts_with('[') && t.ends_with(']');
    (object || array) && serde_json::from_str::<Value>(t).is_ok()
}

fn classify(raw: Option<&str>, o: &DetectOptions) -> Option<Kind> {
    let t = js_trim(raw?);
    if TEXT_NULL_MARKERS.contains(&t) || is_below_detection_limit(t) {
        return None;
    }
    if let Some(n) = parse_number(t, o.decimal, &o.thousands) {
        return Some(if has_leading_zero(t, o.decimal) {
            Kind::Identifier
        } else if !is_integer_text(t, o.decimal) {
            Kind::Num
        } else if is_safe_integer(n) {
            Kind::Int
        } else {
            Kind::Identifier
        });
    }
    if ["true", "false", "yes", "no"].contains(&t.to_lowercase().as_str()) {
        return Some(Kind::Bool);
    }
    if let Some(parts) = date_parts(t) {
        return Some(Kind::DateText(parts));
    }
    Some(if is_json_text(t) {
        Kind::Json
    } else {
        Kind::Text
    })
}

pub struct TypeInference {
    pub typ: Value,
    pub date_format: Option<Value>,
    pub timezone: Option<Value>,
}

impl TypeInference {
    fn plain(typ: Value) -> Self {
        TypeInference {
            typ,
            date_format: None,
            timezone: None,
        }
    }
}

fn type_label(t: &str) -> &'static str {
    match t {
        "string" => "text",
        "integer" => "whole numbers",
        "number" => "numbers",
        "boolean" => "booleans",
        "date" => "dates",
        "datetime" => "date-times",
        _ => "geometries",
    }
}

fn type_detection(typ: &str, fits: usize, total: usize) -> Value {
    let all = fits == total;
    let evidence = if all {
        format!(
            "All {total} non-empty sample values read as {}.",
            type_label(typ)
        )
    } else {
        format!(
            "{fits} of {total} non-empty sample values read as {}; the others keep their text.",
            type_label(typ)
        )
    };
    det(
        json!(typ),
        if all { "high" } else { "medium" },
        if all {
            "value-pattern"
        } else {
            "value-majority"
        },
        evidence,
        false,
    )
}

fn format_of(name: &str) -> DateFormat {
    match name {
        "dmy" => DateFormat::Dmy,
        "mdy" => DateFormat::Mdy,
        "ymd-slash" => DateFormat::YmdSlash,
        "excel-serial" => DateFormat::ExcelSerial,
        _ => DateFormat::Iso,
    }
}

struct DateAnalysis {
    valid: usize,
    typ: &'static str,
    date_format: Value,
    timezone: Option<Value>,
}

fn resolve_day_month(parts: &[&crate::parse::DateParts]) -> Value {
    let shown = |p: &crate::parse::DateParts| format!("{}/{}/{}", p.first, p.second, p.year);
    let first_over = parts.iter().find(|p| p.first > 12);
    let second_over = parts.iter().find(|p| p.second > 12);
    match (first_over, second_over) {
        (Some(f), None) => det(
            json!("dmy"),
            "high",
            "day-above-12",
            format!(
                "The first number exceeds 12 ({}), so it is the day.",
                shown(f)
            ),
            false,
        ),
        (None, Some(s)) => det(
            json!("mdy"),
            "high",
            "day-above-12",
            format!(
                "The second number exceeds 12 ({}), so it is the day.",
                shown(s)
            ),
            false,
        ),
        (None, None) => det(
            json!("dmy"),
            "low",
            "day-first-default",
            "No day above 12 in the sample, so day/month order cannot be told; day first is assumed.",
            true,
        ),
        (Some(_), Some(_)) => {
            let under = |f: DateFormat| parts.iter().filter(|p| month_day(p, f).is_some()).count();
            let (dmy, mdy) = (under(DateFormat::Dmy), under(DateFormat::Mdy));
            let format = if mdy > dmy { "mdy" } else { "dmy" };
            det(
                json!(format),
                "medium",
                "day-month-majority",
                format!(
                    "Values exceed 12 in both positions; {format} fits {} of {}.",
                    dmy.max(mdy),
                    parts.len()
                ),
                false,
            )
        }
    }
}

fn analyse_dates(kinds: &[Kind]) -> DateAnalysis {
    let texts: Vec<&crate::parse::DateParts> = kinds
        .iter()
        .filter_map(|k| match k {
            Kind::DateText(p) => Some(p),
            _ => None,
        })
        .collect();
    let tally = |f: u8| texts.iter().filter(|p| p.family == f).count();
    // Ties go to the earlier, less ambiguous family: ISO, year/month/day, then day and month.
    let family = [0u8, 1, 2]
        .into_iter()
        .fold(0u8, |best, f| if tally(f) > tally(best) { f } else { best });
    let in_family: Vec<&crate::parse::DateParts> = texts
        .iter()
        .copied()
        .filter(|p| p.family == family)
        .collect();
    let date_format = match family {
        2 => resolve_day_month(&in_family),
        1 => det(
            json!("ymd-slash"),
            "high",
            "value-pattern",
            "Dates are written year/month/day.",
            false,
        ),
        _ => {
            if in_family.is_empty() {
                det(
                    json!("iso"),
                    "high",
                    "native-cells",
                    "The source stores 0 values as dates.",
                    false,
                )
            } else {
                det(
                    json!("iso"),
                    "high",
                    "value-pattern",
                    "Dates are written in ISO 8601 (year-month-day).",
                    false,
                )
            }
        }
    };
    let f = format_of(date_format["value"].as_str().unwrap_or("iso"));
    let valid: Vec<&&crate::parse::DateParts> = in_family
        .iter()
        .filter(|p| month_day(p, f).is_some())
        .collect();
    let timed: Vec<&&&crate::parse::DateParts> =
        valid.iter().filter(|p| p.time.is_some()).collect();
    let typ = if timed.is_empty() { "date" } else { "datetime" };
    let timezone = (typ == "datetime").then(|| {
        let zones: Vec<&str> = timed
            .iter()
            .map(|p| match &p.time {
                Some(t) if t.utc => "utc",
                Some(t) if t.zoned => "offset",
                _ => "none",
            })
            .collect();
        let naive = zones.iter().filter(|z| **z == "none").count();
        if naive == 0 && zones.iter().all(|z| *z == "utc") {
            det(
                json!("utc"),
                "high",
                "explicit-zone",
                "Every time carries Z (UTC).",
                false,
            )
        } else if naive == 0 {
            det(
                json!("offset"),
                "high",
                "explicit-zone",
                "Every time carries a UTC offset.",
                false,
            )
        } else {
            det(
                json!("naive-assumed-utc"),
                "low",
                "no-zone",
                format!(
                    "{naive} of {} times name no time zone; they are read as UTC.",
                    zones.len()
                ),
                true,
            )
        }
    });
    DateAnalysis {
        valid: valid.len(),
        typ,
        date_format,
        timezone,
    }
}

fn with_dates(typ: Value, dates: DateAnalysis) -> TypeInference {
    TypeInference {
        typ,
        date_format: Some(dates.date_format),
        timezone: dates.timezone,
    }
}

/// The type of a column's values (inferType), with the date format and time zone of dates.
pub fn infer_type(values: &[Option<&str>], o: &DetectOptions) -> TypeInference {
    let kinds: Vec<Kind> = values.iter().filter_map(|v| classify(*v, o)).collect();
    let total = kinds.len();
    let count = |f: fn(&Kind) -> bool| kinds.iter().filter(|k| f(k)).count();
    if total == 0 {
        return TypeInference::plain(det(
            json!("string"),
            "low",
            "empty-sample",
            "The sample has no values; text is assumed.",
            true,
        ));
    }
    if count(|k| matches!(k, Kind::Identifier)) > 0 {
        return TypeInference::plain(det(
            json!("string"),
            "high",
            "identifier-text",
            "Numbers with leading zeros or more than 15 digits are identifiers, kept as text.",
            false,
        ));
    }
    let nums = count(|k| matches!(k, Kind::Num));
    let numeric = count(|k| matches!(k, Kind::Int | Kind::Num));
    let numeric_type = if nums > 0 { "number" } else { "integer" };
    if numeric == total {
        return TypeInference::plain(type_detection(numeric_type, total, total));
    }
    let bools = count(|k| matches!(k, Kind::Bool));
    if bools == total {
        return TypeInference::plain(type_detection("boolean", total, total));
    }
    let dates = analyse_dates(&kinds);
    if dates.valid == total {
        let typ = type_detection(dates.typ, total, total);
        return with_dates(typ, dates);
    }
    // The type most values fit, if at least MAJORITY_SHARE of them fit it.
    let candidates = [
        (numeric_type, numeric),
        ("boolean", bools),
        (dates.typ, dates.valid),
    ];
    let (typ, fits) =
        candidates.iter().skip(1).fold(
            candidates[0],
            |best, c| if c.1 > best.1 { *c } else { best },
        );
    if fits > 0 && fits as f64 / total as f64 >= MAJORITY_SHARE {
        let detection = type_detection(typ, fits, total);
        return if typ == "date" || typ == "datetime" {
            with_dates(detection, dates)
        } else {
            TypeInference::plain(detection)
        };
    }
    if count(|k| matches!(k, Kind::Json)) == total {
        return TypeInference::plain(det(
            json!("string"),
            "medium",
            "json-text",
            "Values are nested JSON, kept as JSON text.",
            false,
        ));
    }
    TypeInference::plain(det(
        json!("string"),
        "high",
        "value-pattern",
        "Values are free text.",
        false,
    ))
}

fn numeric_values(values: &[Option<&str>], o: &DetectOptions) -> Option<Vec<f64>> {
    let mut nums = Vec::new();
    for v in values.iter().flatten() {
        if js_trim(v).is_empty() {
            continue;
        }
        nums.push(parse_number(v, o.decimal, &o.thousands)?);
    }
    (!nums.is_empty()).then_some(nums)
}

/// Numbers under a date-named header as Excel serial dates, when every one is a plausible serial.
fn as_serial_dates(nums: &[f64]) -> Option<TypeInference> {
    if !nums
        .iter()
        .all(|n| (EXCEL_MIN_SERIAL..=EXCEL_MAX_SERIAL).contains(n))
    {
        return None;
    }
    let with_time = nums.iter().any(|n| n.fract() != 0.0);
    Some(TypeInference {
        typ: det(
            json!(if with_time { "datetime" } else { "date" }),
            "medium",
            "excel-serial",
            "Numbers in a date-named column are read as Excel serial dates.",
            false,
        ),
        date_format: Some(det(
            json!("excel-serial"),
            "high",
            "value-pattern",
            "Values are Excel serial day numbers (1900 date system).",
            false,
        )),
        timezone: with_time.then(|| {
            det(
                json!("naive-assumed-utc"),
                "low",
                "no-zone",
                "Excel serial times name no time zone; they are read as UTC.",
                true,
            )
        }),
    })
}

fn refine_by_name(
    inferred: TypeInference,
    tokens: &[String],
    has_unit: bool,
    values: &[Option<&str>],
    o: &DetectOptions,
) -> TypeInference {
    let typ = inferred.typ["value"].as_str().unwrap_or("");
    if typ != "integer" && typ != "number" {
        return inferred;
    }
    let Some(nums) = numeric_values(values, o) else {
        return inferred;
    };
    if !has_unit && has_date_hint(tokens) {
        return as_serial_dates(&nums).unwrap_or(inferred);
    }
    if typ == "integer" && has_boolean_hint(tokens) && nums.iter().all(|n| *n == 0.0 || *n == 1.0) {
        return TypeInference::plain(det(
            json!("boolean"),
            "medium",
            "name-and-values",
            "Only 1 and 0 under a yes/no style header.",
            false,
        ));
    }
    inferred
}

// ---------------------------------------------------------------------------------------------
// Roles (roles.ts)

fn numbers(values: &[Value]) -> Vec<f64> {
    values.iter().filter_map(Value::as_f64).collect()
}

fn within_limit(values: &[Value], limit: f64) -> bool {
    let nums = numbers(values);
    !nums.is_empty() && nums.iter().all(|v| v.abs() <= limit)
}

fn is_numeric(typ: &str) -> bool {
    typ == "integer" || typ == "number"
}

fn axis_role(axis: &str, tokens: &[String], values: &[Value]) -> Option<Value> {
    let (words, abbreviations, limit): (&[&str], &[&str], f64) = if axis == "latitude" {
        (&["latitude"], &["lat"], 90.0)
    } else {
        (&["longitude"], &["lon", "long", "lng"], 180.0)
    };
    let has = |ws: &[&str]| tokens.iter().any(|t| ws.contains(&t.as_str()));
    if has(words) {
        return Some(det(
            json!(axis),
            "high",
            "name",
            format!("The name says {axis}."),
            false,
        ));
    }
    if !has(abbreviations) {
        return None;
    }
    let shown = crate::canonical::canonical_number(limit);
    Some(if within_limit(values, limit) {
        det(
            json!(axis),
            "high",
            "name-and-range",
            format!("The name abbreviates {axis} and every value is within \u{b1}{shown}."),
            false,
        )
    } else {
        det(
            json!(axis),
            "medium",
            "name",
            format!("The name abbreviates {axis}, but some values fall outside \u{b1}{shown}."),
            false,
        )
    })
}

fn cell_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(_) => crate::canonical::canonical_number(v.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn id_role(tokens: &[String], typ: &str, values: &[Value]) -> Option<Value> {
    const ID_WORDS: [&str; 7] = ["id", "uwi", "api", "guid", "uuid", "key", "ids"];
    const ID_LIKE: [&str; 8] = [
        "code",
        "no",
        "num",
        "number",
        "tag",
        "serial",
        "ref",
        "reference",
    ];
    if typ != "string" && typ != "integer" {
        return None;
    }
    if tokens.iter().any(|t| ID_WORDS.contains(&t.as_str())) {
        return Some(det(
            json!("id"),
            "high",
            "name",
            "The name marks an identifier.",
            false,
        ));
    }
    if !tokens.iter().any(|t| ID_LIKE.contains(&t.as_str())) {
        return None;
    }
    let present: Vec<String> = values
        .iter()
        .filter(|v| !v.is_null())
        .map(cell_text)
        .collect();
    let distinct: HashSet<&String> = present.iter().collect();
    let share = if present.is_empty() {
        0.0
    } else {
        distinct.len() as f64 / present.len() as f64
    };
    if present.len() < 5 || share < 0.9 {
        return None;
    }
    Some(det(
        json!("id"),
        "medium",
        "name-and-cardinality",
        format!(
            "The name suggests an identifier and {} % of values are distinct.",
            (share * 100.0).round()
        ),
        false,
    ))
}

fn detect_role(name: &str, typ: &str, values: &[Value], unit: Option<&str>) -> Value {
    if typ == "geometry" {
        return det(
            json!("geometry"),
            "high",
            "type",
            "The column holds geometries.",
            false,
        );
    }
    if typ == "date" || typ == "datetime" {
        return det(
            json!("time"),
            "high",
            "type",
            "The column holds dates or times.",
            false,
        );
    }
    let tokens = name_tokens(name);
    if is_numeric(typ) {
        let spatial = axis_role("latitude", &tokens, values)
            .or_else(|| axis_role("longitude", &tokens, values))
            .or_else(|| {
                if tokens.iter().any(|t| t == "easting" || t == "eastings") {
                    Some(det(
                        json!("easting"),
                        "high",
                        "name",
                        "The name says easting.",
                        false,
                    ))
                } else if tokens.iter().any(|t| t == "northing" || t == "northings") {
                    Some(det(
                        json!("northing"),
                        "high",
                        "name",
                        "The name says northing.",
                        false,
                    ))
                } else {
                    None
                }
            });
        if let Some(role) = spatial {
            return role;
        }
    }
    if typ == "string"
        && tokens
            .iter()
            .any(|t| ["unit", "units", "uom"].contains(&t.as_str()))
    {
        return det(
            json!("unit"),
            "high",
            "name",
            "The name says the column holds units.",
            false,
        );
    }
    if let Some(role) = id_role(&tokens, typ, values) {
        return role;
    }
    if is_numeric(typ) {
        let evidence = match unit {
            None => "Numeric values are measurements.".to_string(),
            Some(u) => format!("Numeric values in {u} are measurements."),
        };
        return det(json!("measure"), "high", "type", evidence, false);
    }
    det(
        json!("text"),
        "high",
        "type",
        "Non-numeric values are descriptive.",
        false,
    )
}

/// WGS84 for latitude and longitude columns, when the file names no coordinate system.
pub fn detect_lat_lon_crs(plans: &[Value]) -> Option<Value> {
    let has = |role: &str| {
        plans.iter().any(|c| {
            c["role"]["value"] == role && is_numeric(c["type"]["value"].as_str().unwrap_or(""))
        })
    };
    (has("latitude") && has("longitude")).then(|| {
        det(
            json!({ "code": "EPSG:4326", "source": "assumed-latlon" }),
            "medium",
            "latlon-columns",
            "Latitude and longitude columns are assumed to be WGS84 (EPSG:4326); the file does not say.",
            false,
        )
    })
}

// ---------------------------------------------------------------------------------------------
// Columns (columns.ts)

fn plan_column(
    name: String,
    source_header: Vec<String>,
    unit: Value,
    index: usize,
    values: &[Option<&str>],
    o: &DetectOptions,
) -> Value {
    let null_markers = detect_null_markers(values);
    let markers: Vec<String> = null_markers["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m.as_str().map(String::from))
        .collect();
    let typed: Vec<Option<&str>> = values
        .iter()
        .copied()
        .filter(|v| match_null_marker(*v, &markers, o.decimal).is_none())
        .collect();
    let unit_code = unit["value"].as_str().map(String::from);
    let inferred = refine_by_name(
        infer_type(&typed, o),
        &name_tokens(&name),
        unit_code.is_some(),
        &typed,
        o,
    );
    let typ = inferred.typ["value"]
        .as_str()
        .unwrap_or("string")
        .to_string();
    let mut plan = json!({
        "id": format!("c{index}"),
        "name": name,
        "sourceHeader": source_header,
        "sourceIndex": index,
        "type": inferred.typ,
        "role": det(json!("text"), "high", "type", "", false),
        "unit": unit,
        "quantity": unit_code.as_deref().and_then(get_unit).map(|u| u.quantity.clone()),
        "nullMarkers": null_markers,
    });
    if let Some(f) = inferred.date_format {
        plan["dateFormat"] = f;
    }
    if let Some(z) = inferred.timezone {
        plan["timezone"] = z;
    }
    if is_numeric(&typ) {
        plan["decimalSeparator"] = det(
            json!(o.decimal.to_string()),
            "high",
            "file-dialect",
            "The decimal separator detected for the file.",
            false,
        );
    }
    // The role reads the values as the plan parses them.
    let parsed: Vec<Value> = match column_parser(&plan, o.decimal, &o.thousands) {
        Ok(parser) => values
            .iter()
            .filter_map(|v| match parser.parse(*v) {
                Parsed::Value(cell, _) => Some(crate::engine::cell_json(&cell)),
                Parsed::Failed(_) => None,
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    plan["role"] = detect_role(
        plan["name"].as_str().unwrap_or(""),
        &typ,
        &parsed,
        unit_code.as_deref(),
    );
    plan
}

/// The column plans of a table (detectColumns): names and units from the header, everything else
/// from the first SAMPLE_LIMIT rows.
pub fn detect_columns(
    header: &[Vec<String>],
    sample: &[Vec<Option<String>>],
    o: &DetectOptions,
) -> Vec<Value> {
    let rows = &sample[..sample.len().min(SAMPLE_LIMIT)];
    let width = match header_width(header) {
        0 => rows.iter().map(Vec::len).max().unwrap_or(0),
        w => w,
    };
    let flat = flatten_header(header);
    let named: Vec<(String, Vec<String>, Value)> = (0..width)
        .map(|i| {
            let text = flat.get(i).cloned().unwrap_or_else(|| placeholder_name(i));
            let parsed = parse_header_unit(&text);
            let unit = parsed.unit.unwrap_or_else(|| {
                det(
                    Value::Null,
                    "high",
                    "header",
                    "The header names no unit.",
                    false,
                )
            });
            let name = if parsed.name.is_empty() {
                placeholder_name(i)
            } else {
                parsed.name
            };
            let source: Vec<String> = header
                .iter()
                .map(|row| row.get(i).cloned().unwrap_or_default())
                .collect();
            (name, source, unit)
        })
        .collect();
    let names = unique_names(&named.iter().map(|c| c.0.clone()).collect::<Vec<_>>());
    named
        .into_iter()
        .enumerate()
        .map(|(i, (name, source, unit))| {
            let values: Vec<Option<&str>> = rows
                .iter()
                .map(|r| r.get(i).and_then(|f| f.as_deref()))
                .collect();
            plan_column(
                names.get(i).cloned().unwrap_or(name),
                source,
                unit,
                i,
                &values,
                o,
            )
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Assumptions (assumptions.ts)

const COLUMN_PROPERTIES: [&str; 7] = [
    "type",
    "role",
    "unit",
    "nullMarkers",
    "dateFormat",
    "timezone",
    "decimalSeparator",
];

/// Every assumed detection: the dataset's, in the given order, then each column's.
pub fn collect_assumptions(
    dataset_id: &str,
    plans: &[Value],
    extra: &[(&str, &Value)],
) -> Vec<Value> {
    let item = |column: Value, property: &str, d: &Value| {
        let mut a = Map::new();
        a.insert("datasetId".into(), json!(dataset_id));
        a.insert("columnId".into(), column);
        a.insert("property".into(), json!(property));
        a.insert("value".into(), d["value"].clone());
        a.insert("confidence".into(), d["confidence"].clone());
        a.insert("evidence".into(), d["evidence"].clone());
        Value::Object(a)
    };
    let mut out: Vec<Value> = extra
        .iter()
        .filter(|(_, d)| d["assumed"] == true)
        .map(|(p, d)| item(Value::Null, p, d))
        .collect();
    for plan in plans {
        for property in COLUMN_PROPERTIES {
            if plan[property]["assumed"] == true {
                out.push(item(plan["id"].clone(), property, &plan[property]));
            }
        }
    }
    out
}
