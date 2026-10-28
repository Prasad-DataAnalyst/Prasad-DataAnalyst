//! Cell parsing under a column plan: a port of the TypeScript parser (src/detect/parser.ts and
//! the number, null-marker and date rules it uses), so both engines read every field to the same
//! value. A field that does not fit keeps its raw text; nothing is dropped (SAD section 7.2).

use crate::time::{MS_PER_DAY, days_from_civil};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    String,
    Integer,
    Number,
    Boolean,
    Date,
    DateTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateFormat {
    Iso,
    Dmy,
    Mdy,
    YmdSlash,
    ExcelSerial,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Null,
    Text(String),
    Number(f64),
    Bool(bool),
    /// Days since 1970-01-01.
    Date(i64),
    /// Milliseconds since the epoch, UTC.
    DateTime(i64),
}

/// The outcome for one field: a value (null names the marker it matched, if any), or raw text.
#[derive(Clone, Debug, PartialEq)]
pub enum Parsed {
    Value(Cell, Option<String>),
    Failed(String),
}

pub struct ColumnParser {
    pub kind: Kind,
    pub markers: Vec<String>,
    /// The markers that are numbers, with their values, in plan order.
    numeric_markers: Vec<(f64, String)>,
    pub decimal: char,
    pub thousands: String,
    pub format: DateFormat,
}

const TRUE_WORDS: [&str; 5] = ["true", "yes", "y", "t", "1"];
const FALSE_WORDS: [&str; 5] = ["false", "no", "n", "f", "0"];
const MAX_NUMBER_TEXT: usize = 64;
const MAX_DATE_TEXT: usize = 48;
const EXCEL_EPOCH_OFFSET_DAYS: f64 = 25569.0;
const EXCEL_MAX_SERIAL: f64 = 2_958_465.0;

impl ColumnParser {
    pub fn new(
        kind: Kind,
        markers: Vec<String>,
        decimal: char,
        thousands: String,
        format: DateFormat,
    ) -> Self {
        let numeric_markers = markers
            .iter()
            .filter(|m| !m.is_empty())
            .filter_map(|m| parse_number(m, '.', "").map(|v| (v, m.clone())))
            .collect();
        ColumnParser {
            kind,
            markers,
            numeric_markers,
            decimal,
            thousands,
            format,
        }
    }

    pub fn parse(&self, raw: Option<&str>) -> Parsed {
        let Some(raw) = raw else {
            return Parsed::Value(Cell::Null, None);
        };
        let t = raw.trim();
        if t.is_empty() {
            return Parsed::Value(Cell::Null, None);
        }
        if let Some(m) = self.markers.iter().find(|m| m.as_str() == t) {
            return Parsed::Value(Cell::Null, Some(m.clone()));
        }
        // A numeric marker also matches the same number written differently ('-999.250').
        if let Some(v) = parse_number(raw, self.decimal, "") {
            if let Some((_, m)) = self.numeric_markers.iter().find(|(x, _)| *x == v) {
                return Parsed::Value(Cell::Null, Some(m.clone()));
            }
        }
        let value = match self.kind {
            Kind::String => Some(Cell::Text(raw.to_string())),
            Kind::Number => parse_number(raw, self.decimal, &self.thousands).map(Cell::Number),
            Kind::Integer => parse_number(raw, self.decimal, &self.thousands)
                .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
                .map(Cell::Number),
            Kind::Boolean => {
                let w = t.to_lowercase();
                if TRUE_WORDS.contains(&w.as_str()) {
                    Some(Cell::Bool(true))
                } else if FALSE_WORDS.contains(&w.as_str()) {
                    Some(Cell::Bool(false))
                } else {
                    None
                }
            }
            Kind::Date => parse_date(raw, self.format).map(Cell::Date),
            Kind::DateTime => parse_datetime(raw, self.format).map(Cell::DateTime),
        };
        match value {
            Some(v) => Parsed::Value(v, None),
            None => Parsed::Failed(raw.to_string()),
        }
    }
}

fn all_digits(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit())
}

/// The integer digits with grouping removed, or None when the grouping is malformed.
fn strip_thousands(int_part: &str, thousands: &str) -> Option<String> {
    if all_digits(int_part) {
        return Some(int_part.to_string());
    }
    if thousands.is_empty() {
        return None;
    }
    let normalized: String = if thousands == " " {
        int_part
            .chars()
            .map(|c| {
                if matches!(c, ' ' | '\u{a0}' | '\u{202f}') {
                    ' '
                } else {
                    c
                }
            })
            .collect()
    } else {
        int_part.to_string()
    };
    let groups: Vec<&str> = normalized.split(thousands).collect();
    let first = groups[0];
    let ok = groups.len() > 1
        && (1..=3).contains(&first.len())
        && all_digits(first)
        && groups[1..].iter().all(|g| g.len() == 3 && all_digits(g));
    ok.then(|| groups.concat())
}

/// Strict locale-aware number parsing, as the TypeScript parseNumber.
pub fn parse_number(text: &str, decimal: char, thousands: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_NUMBER_TEXT {
        return None;
    }
    let (sign, signless) = match trimmed.chars().next() {
        Some('-') => ("-", &trimmed[1..]),
        Some('\u{2212}') => ("-", &trimmed['\u{2212}'.len_utf8()..]),
        Some('+') => ("", &trimmed[1..]),
        _ => ("", trimmed),
    };
    // An exponent at the end: [eE][+-]?\d{1,4}
    let exponent = {
        let b = signless.as_bytes();
        let mut end_digits = b.len();
        while end_digits > 0 && b[end_digits - 1].is_ascii_digit() {
            end_digits -= 1;
        }
        let n_digits = b.len() - end_digits;
        let mut at = end_digits;
        if (1..=4).contains(&n_digits) && at > 0 && (b[at - 1] == b'+' || b[at - 1] == b'-') {
            at -= 1;
        }
        if (1..=4).contains(&n_digits) && at > 0 && (b[at - 1] == b'e' || b[at - 1] == b'E') {
            &signless[at - 1..]
        } else {
            ""
        }
    };
    let body = &signless[..signless.len() - exponent.len()];
    let parts: Vec<&str> = body.split(decimal).collect();
    if parts.len() > 2 {
        return None;
    }
    let int_digits = strip_thousands(parts[0], thousands)?;
    let fraction = parts.get(1).copied().unwrap_or("");
    if !all_digits(fraction) || (int_digits.is_empty() && fraction.is_empty()) {
        return None;
    }
    let canonical = format!(
        "{sign}{}{}{exponent}",
        if int_digits.is_empty() {
            "0"
        } else {
            &int_digits
        },
        if fraction.is_empty() {
            String::new()
        } else {
            format!(".{fraction}")
        }
    );
    let value: f64 = canonical.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    Some(if value == 0.0 { 0.0 } else { value })
}

struct TimeOfDay {
    ms: i64,
    offset_minutes: i64,
    zoned: bool,
}

struct DateParts {
    family: u8, // 0 iso, 1 ymd-slash, 2 day-month
    year: i64,
    first: i64,
    second: i64,
    time: Option<TimeOfDay>,
}

fn take_digits(s: &str, min: usize, max: usize) -> Option<(i64, &str)> {
    let n = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if n < min || n > max {
        return None;
    }
    Some((s[..n].parse().ok()?, &s[n..]))
}

/// Parses what follows a date: nothing, or a time with an optional zone. Some(None) means no time.
fn time_suffix(rest: &str) -> Option<Option<TimeOfDay>> {
    if rest.trim().is_empty() {
        return Some(None);
    }
    let mut s = if let Some(x) = rest.strip_prefix('T') {
        x
    } else {
        let t = rest.trim_start();
        if t.len() == rest.len() {
            return None;
        }
        t
    };
    let (hour, r) = take_digits(s, 1, 2)?;
    let r = r.strip_prefix(':')?;
    let (minute, mut r) = take_digits(r, 2, 2)?;
    let mut second = 0;
    let mut milli = 0;
    if let Some(x) = r.strip_prefix(':') {
        let (sec, r2) = take_digits(x, 2, 2)?;
        second = sec;
        r = r2;
        if let Some(x) = r.strip_prefix('.').or_else(|| r.strip_prefix(',')) {
            let n = x.bytes().take_while(|b| b.is_ascii_digit()).count();
            if !(1..=9).contains(&n) {
                return None;
            }
            let digits = format!("{:0<3}", &x[..n.min(3)]);
            milli = digits.parse().ok()?;
            r = &x[n..];
        }
    }
    s = r.trim_start();
    let mut hour24 = hour;
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && matches!(bytes[0], b'A' | b'a' | b'P' | b'p')
        && matches!(bytes[1], b'M' | b'm')
    {
        if !(1..=12).contains(&hour) {
            return None;
        }
        hour24 = hour % 12
            + if matches!(bytes[0], b'P' | b'p') {
                12
            } else {
                0
            };
        s = s[2..].trim_start();
    }
    let s = s.trim_end();
    let (zoned, offset_minutes) = if s.is_empty() {
        (false, 0)
    } else if s.eq_ignore_ascii_case("z")
        || s.eq_ignore_ascii_case("utc")
        || s.eq_ignore_ascii_case("gmt")
    {
        (true, 0)
    } else {
        let sign = match s.as_bytes()[0] {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let digits = s[1..].replacen(':', "", 1);
        if !(digits.len() == 2 || digits.len() == 4) || !all_digits(&digits) {
            return None;
        }
        let h: i64 = digits[..2].parse().ok()?;
        let m: i64 = if digits.len() > 2 {
            digits[2..].parse().ok()?
        } else {
            0
        };
        if h > 14 || m > 59 {
            return None;
        }
        (true, sign * (h * 60 + m))
    };
    if hour24 > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(Some(TimeOfDay {
        ms: ((hour24 * 60 + minute) * 60 + second) * 1000 + milli,
        offset_minutes,
        zoned,
    }))
}

fn date_parts(text: &str) -> Option<DateParts> {
    let t = text.trim();
    if t.chars().count() > MAX_DATE_TEXT {
        return None;
    }
    let parts = |family, year, first, second, rest: &str| {
        time_suffix(rest).map(|time| DateParts {
            family,
            year,
            first,
            second,
            time,
        })
    };
    // ISO: YYYY-M-D…
    if let Some((year, r)) = take_digits(t, 4, 4) {
        if let Some(r) = r.strip_prefix('-') {
            let (m, r) = take_digits(r, 1, 2)?;
            let r = r.strip_prefix('-')?;
            let (d, rest) = take_digits(r, 1, 2)?;
            return parts(0, year, m, d, rest);
        }
        let sep = r.chars().next()?;
        if sep == '/' || sep == '.' {
            let (m, r) = take_digits(&r[1..], 1, 2)?;
            let r = r.strip_prefix(sep)?;
            let (d, rest) = take_digits(r, 1, 2)?;
            return parts(1, year, m, d, rest);
        }
        return None;
    }
    let (first, r) = take_digits(t, 1, 2)?;
    let sep = r.chars().next()?;
    if !matches!(sep, '/' | '.' | '-') {
        return None;
    }
    let (second, r) = take_digits(&r[1..], 1, 2)?;
    let r = r.strip_prefix(sep)?;
    let (year, rest) = take_digits(r, 4, 4)?;
    parts(2, year, first, second, rest)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn valid_day(y: i64, m: i64, d: i64) -> bool {
    let dim = match m {
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => return false,
    };
    (1..=9999).contains(&y) && d >= 1 && d <= dim
}

fn month_day(p: &DateParts, f: DateFormat) -> Option<(i64, i64)> {
    let wanted = match f {
        DateFormat::Dmy | DateFormat::Mdy => 2,
        DateFormat::Iso => 0,
        DateFormat::YmdSlash => 1,
        DateFormat::ExcelSerial => return None,
    };
    if p.family != wanted {
        return None;
    }
    let (m, d) = if f == DateFormat::Dmy {
        (p.second, p.first)
    } else {
        (p.first, p.second)
    };
    valid_day(p.year, m, d).then_some((m, d))
}

fn serial(text: &str) -> Option<f64> {
    let t = text.trim();
    let (int, frac) = t.split_once('.').unwrap_or((t, ""));
    if int.is_empty()
        || !all_digits(int)
        || (t.contains('.') && (frac.is_empty() || !all_digits(frac)))
    {
        return None;
    }
    t.parse().ok()
}

fn excel_serial_millis(s: f64) -> Option<i64> {
    if !s.is_finite() || !(1.0..EXCEL_MAX_SERIAL + 1.0).contains(&s) || s.floor() == 60.0 {
        return None;
    }
    let days = if s < 60.0 {
        s - EXCEL_EPOCH_OFFSET_DAYS + 1.0
    } else {
        s - EXCEL_EPOCH_OFFSET_DAYS
    };
    Some((days * MS_PER_DAY as f64).round() as i64)
}

/// A calendar date in format `f`, as days since the epoch; a time is accepted only at midnight.
pub fn parse_date(text: &str, f: DateFormat) -> Option<i64> {
    if f == DateFormat::ExcelSerial {
        let s = serial(text).filter(|s| s.fract() == 0.0)?;
        return Some(excel_serial_millis(s)?.div_euclid(MS_PER_DAY));
    }
    let p = date_parts(text)?;
    let (m, d) = month_day(&p, f)?;
    if let Some(t) = &p.time {
        if t.ms != 0 || t.zoned {
            return None;
        }
    }
    Some(days_from_civil(p.year, m, d))
}

/// An instant in format `f`; an explicit zone is honoured and a naive value is read as UTC.
pub fn parse_datetime(text: &str, f: DateFormat) -> Option<i64> {
    if f == DateFormat::ExcelSerial {
        return excel_serial_millis(serial(text)?);
    }
    let p = date_parts(text)?;
    let (m, d) = month_day(&p, f)?;
    let (ms, offset) = p.time.as_ref().map_or((0, 0), |t| (t.ms, t.offset_minutes));
    let instant = days_from_civil(p.year, m, d) * MS_PER_DAY + ms - offset * 60_000;
    // Years 0001–9999 only, like the TypeScript engine.
    let lo = days_from_civil(1, 1, 1) * MS_PER_DAY;
    let hi = days_from_civil(10000, 1, 1) * MS_PER_DAY;
    (lo..hi).contains(&instant).then_some(instant)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::{date_text, iso_from_millis};

    #[test]
    fn parses_numbers_strictly() {
        assert_eq!(parse_number(" 1 234,5 ", ',', " "), Some(1234.5));
        assert_eq!(parse_number("1,5", '.', ","), None);
        assert_eq!(parse_number("1.2e3", '.', ""), Some(1200.0));
        assert_eq!(parse_number("\u{2212}7", '.', ""), Some(-7.0));
        assert_eq!(parse_number("-0", '.', ""), Some(0.0));
        assert_eq!(parse_number("12a", '.', ""), None);
        assert_eq!(parse_number(".5", '.', ""), Some(0.5));
    }

    #[test]
    fn matches_null_markers_by_text_and_by_value() {
        let p = ColumnParser::new(
            Kind::Number,
            vec!["-999.25".into(), "N/A".into()],
            '.',
            String::new(),
            DateFormat::Iso,
        );
        assert_eq!(
            p.parse(Some("-999.250")),
            Parsed::Value(Cell::Null, Some("-999.25".into()))
        );
        assert_eq!(
            p.parse(Some(" N/A ")),
            Parsed::Value(Cell::Null, Some("N/A".into()))
        );
        assert_eq!(p.parse(Some("   ")), Parsed::Value(Cell::Null, None));
        assert_eq!(p.parse(Some("abc")), Parsed::Failed("abc".into()));
    }

    #[test]
    fn parses_dates_and_times_in_utc() {
        assert_eq!(
            parse_datetime("2025-12-01T06:00:00", DateFormat::Iso)
                .map(iso_from_millis)
                .as_deref(),
            Some("2025-12-01T06:00:00.000Z")
        );
        assert_eq!(
            parse_datetime("2025-12-01 06:00+01:00", DateFormat::Iso)
                .map(iso_from_millis)
                .as_deref(),
            Some("2025-12-01T05:00:00.000Z")
        );
        assert_eq!(
            parse_datetime("01/02/2026 1:30 PM", DateFormat::Dmy)
                .map(iso_from_millis)
                .as_deref(),
            Some("2026-02-01T13:30:00.000Z")
        );
        assert_eq!(parse_date("2026-02-30", DateFormat::Iso), None);
        assert_eq!(
            parse_date("2026-01-05", DateFormat::Iso)
                .map(date_text)
                .as_deref(),
            Some("2026-01-05")
        );
        assert_eq!(
            parse_date("45658", DateFormat::ExcelSerial)
                .map(date_text)
                .as_deref(),
            Some("2025-01-01")
        );
    }
}
