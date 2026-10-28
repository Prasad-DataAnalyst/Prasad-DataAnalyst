//! Units, read from the same files as the TypeScript engine (src/units): the cited registry
//! (registry-2026.1.json) and the quantity table (quantities-2026.1.json). Lookup and the
//! value-then-unit split are ports of names.ts, registry.ts and header.ts, so a text names the
//! same unit in both engines.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

pub const REGISTRY_JSON: &str = include_str!("../../../src/units/registry-2026.1.json");
pub const QUANTITIES_JSON: &str = include_str!("../../../src/units/quantities-2026.1.json");

#[derive(Clone, Debug)]
pub struct Unit {
    pub code: String,
    pub quantity: String,
    pub factor: f64,
    pub offset: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bounds {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub source: String,
}

struct Registry {
    by_code: HashMap<String, Unit>,
    by_key: HashMap<String, Unit>,
    family: HashMap<String, String>,
    bounds: HashMap<String, Bounds>,
}

fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| {
        let units: Value = serde_json::from_str(REGISTRY_JSON).unwrap_or(Value::Null);
        let mut by_code = HashMap::new();
        let mut by_key = HashMap::new();
        for u in units["units"].as_array().into_iter().flatten() {
            let unit = Unit {
                code: u["code"].as_str().unwrap_or_default().to_string(),
                quantity: u["quantity"].as_str().unwrap_or_default().to_string(),
                factor: u["toSI"]["factor"].as_f64().unwrap_or(1.0),
                offset: u["toSI"]["offset"].as_f64().unwrap_or(0.0),
            };
            let names = std::iter::once(&u["code"])
                .chain(u["aliases"].as_array().into_iter().flatten())
                .filter_map(Value::as_str);
            for name in names {
                by_key.insert(lookup_key(name), unit.clone());
            }
            by_code.insert(unit.code.clone(), unit);
        }
        let table: Value = serde_json::from_str(QUANTITIES_JSON).unwrap_or(Value::Null);
        let mut family = HashMap::new();
        let mut bounds = HashMap::new();
        if let Some(qs) = table["quantities"].as_object() {
            for (q, spec) in qs {
                family.insert(q.clone(), spec["family"].as_str().unwrap_or(q).to_string());
                if let Some(b) = spec["bounds"].as_object() {
                    bounds.insert(
                        q.clone(),
                        Bounds {
                            min: b.get("min").and_then(Value::as_f64),
                            max: b.get("max").and_then(Value::as_f64),
                            source: b
                                .get("source")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        },
                    );
                }
            }
        }
        Registry {
            by_code,
            by_key,
            family,
            bounds,
        }
    })
}

/// JavaScript's white space (`\s` and what `String.prototype.trim` removes).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// Unicode general category Cf (format characters), as of Unicode 16.
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2
        | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F
        | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F
        | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

fn is_word_gap(c: char) -> bool {
    is_js_space(c) || c == '_'
}

/// Replaces each word 'per' (any case, between white space, '_' or the ends) with '/'.
fn per_to_slash(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let starts_word = i == 0 || is_word_gap(chars[i - 1]);
        let is_per = i + 3 <= chars.len()
            && chars[i..i + 3]
                .iter()
                .zip("per".chars())
                .all(|(a, b)| a.to_ascii_lowercase() == b);
        let ends_word = i + 3 == chars.len() || (i + 3 < chars.len() && is_word_gap(chars[i + 3]));
        if starts_word && is_per && ends_word {
            out.push('/');
            i += 3;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Spelled-out time denominators at the end become symbols, so 'bbl/day' and 'bbl/d' share a key.
fn time_denominator(key: String) -> String {
    const RULES: [(&[&str], &str); 4] = [
        (&["/days", "/day"], "/d"),
        (&["/hours", "/hour", "/hrs", "/hr"], "/h"),
        (&["/seconds", "/second", "/secs", "/sec"], "/s"),
        (&["/minutes", "/minute", "/mins"], "/min"),
    ];
    let mut key = key;
    for (words, symbol) in RULES {
        let found = words.iter().find(|w| {
            key.len() >= w.len()
                && key.is_char_boundary(key.len() - w.len())
                && key[key.len() - w.len()..].eq_ignore_ascii_case(w)
        });
        if let Some(w) = found {
            key = format!("{}{symbol}", &key[..key.len() - w.len()]);
        }
    }
    key
}

/// The case-preserving normal form of a unit text (names.ts normalizeUnitText).
pub fn normalize_unit_text(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| !is_format_char(*c))
        .map(|c| match c {
            '\u{BA}' | '\u{2DA}' => '\u{B0}',
            '\u{2206}' => '\u{394}',
            other => other,
        })
        .collect();
    let nfkc: String = cleaned
        .nfkc()
        .map(|c| match c {
            '\u{2215}' | '\u{2044}' => '/',
            other => other,
        })
        .collect();
    let slashed = per_to_slash(&nfkc);
    let key: String = slashed
        .chars()
        .filter(|c| {
            !(is_js_space(*c) || matches!(c, '_' | '.' | '^' | '*' | '\u{B7}' | '\u{22C5}'))
        })
        .collect();
    time_denominator(key)
}

/// The key a unit name is indexed and looked up by (names.ts lookupKey).
pub fn lookup_key(text: &str) -> String {
    let normalized = normalize_unit_text(text);
    let lower = normalized.to_lowercase();
    let mut chars = normalized.chars();
    let milli = chars.next() == Some('m') && chars.next().is_some_and(char::is_uppercase);
    let one_unit = lower.chars().map(char::len_utf16).sum::<usize>() == 1;
    if one_unit || lower == "mm" || lower == "pa" || milli {
        normalized
    } else {
        lower
    }
}

pub fn find_unit(text: &str) -> Option<&'static Unit> {
    let key = lookup_key(text);
    if key.is_empty() {
        None
    } else {
        registry().by_key.get(&key)
    }
}

/// Splits '12.5 psi' into the value text and the unit, as header.ts splitValueUnit (whose regular
/// expression this follows, backtracking included).
pub fn split_value_unit(text: &str) -> Option<(String, &'static Unit)> {
    let t: Vec<char> = js_trim(text).chars().collect();
    let n = t.len();
    let digit = |i: usize| i < n && t[i].is_ascii_digit();
    let mut i = 0;
    if i < n && matches!(t[i], '-' | '+' | '\u{2212}') {
        i += 1;
    }
    if digit(i) {
        i += 1;
    } else if i + 1 < n && matches!(t[i], '.' | ',') && digit(i + 1) {
        i += 2;
    } else {
        return None;
    }
    let base = i;
    let in_class =
        |c: char| c.is_ascii_digit() || matches!(c, '.' | ',' | '\'' | '\u{A0}' | '\u{202F}' | ' ');
    let mut run_end = base;
    while run_end < n && in_class(t[run_end]) {
        run_end += 1;
    }
    let mut ends: Vec<usize> = (base + 1..=run_end)
        .rev()
        .filter(|e| t[e - 1].is_ascii_digit())
        .collect();
    ends.push(base);
    for e in ends {
        let mut options = Vec::new();
        if e < n && matches!(t[e], 'e' | 'E') {
            let mut j = e + 1;
            if j < n && matches!(t[j], '+' | '-') {
                j += 1;
            }
            let mut k = j;
            while digit(k) {
                k += 1;
            }
            options.extend((j + 1..=k).rev());
        }
        options.push(e);
        for v_end in options {
            if v_end >= n || t[v_end].is_ascii_digit() {
                continue;
            }
            let mut w = v_end;
            while w < n && is_js_space(t[w]) {
                w += 1;
            }
            let unit_from = if w < n && !t[w].is_ascii_digit() {
                w
            } else {
                w - 1
            };
            let unit_text: String = t[unit_from..].iter().collect();
            let value: String = t[..v_end].iter().collect();
            return find_unit(&unit_text).map(|u| (value, u));
        }
    }
    None
}

/// `x` rounded to 15 significant digits, as JavaScript's `Number(x.toPrecision(15))`.
fn precision15(x: f64) -> f64 {
    format!("{x:.14e}").parse().unwrap_or(x)
}

/// The physical bounds of quantity `q` in `unit` (quantities.ts physicalBounds).
pub fn physical_bounds(q: &str, unit: &str) -> Option<Bounds> {
    let reg = registry();
    let b = reg.bounds.get(q)?;
    let u = reg.by_code.get(unit)?;
    if reg.family.get(&u.quantity)? != reg.family.get(q)? {
        return None;
    }
    let to_unit = |si: f64| precision15((si - u.offset) / u.factor);
    Some(Bounds {
        min: b.min.map(to_unit),
        max: b.max.map(to_unit),
        source: b.source.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_units_however_they_are_written() {
        for (text, code) in [
            ("psia", "psia"),
            ("PSIA", "psia"),
            ("m³/d", "m3/d"),
            ("m3 per day", "m3/d"),
            ("bbl/day", "bbl/d"),
            ("deg F", "degF"),
            ("°F", "degF"),
        ] {
            assert_eq!(
                find_unit(text).map(|u| u.code.as_str()),
                Some(code),
                "{text}"
            );
        }
        assert!(find_unit("MM").is_none_or(|u| u.code != "mm"));
        assert!(find_unit("").is_none());
    }

    #[test]
    fn splits_a_value_and_its_unit() {
        let split = |t: &str| split_value_unit(t).map(|(v, u)| (v, u.code.clone()));
        assert_eq!(split("12.5 psi"), Some(("12.5".into(), "psi".into())));
        assert_eq!(split(" -3,5bar "), Some(("-3,5".into(), "bar".into())));
        assert_eq!(split("1 200 m3/d"), Some(("1 200".into(), "m3/d".into())));
        assert_eq!(split("2e3 kPa"), Some(("2e3".into(), "kPa".into())));
        assert_eq!(split("psi"), None);
        assert_eq!(split("12"), None);
        assert_eq!(split("12 apples"), None);
    }

    #[test]
    fn bounds_follow_the_quantity_table() {
        let t = physical_bounds("temperature", "degF").unwrap();
        assert_eq!(t.min, Some(-459.67));
        assert_eq!(
            physical_bounds("temperature", "degC").unwrap().min,
            Some(-273.15)
        );
        let f = physical_bounds("fraction", "%").unwrap();
        assert_eq!((f.min, f.max), (Some(0.0), Some(100.0)));
        assert!(physical_bounds("length", "m").is_none());
        assert!(physical_bounds("pressure_abs", "degC").is_none());
    }
}
