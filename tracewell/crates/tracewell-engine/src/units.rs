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
    /// The reference conditions a gauge pressure or standard volume is stated at.
    pub convention: Option<String>,
    /// Where the factor comes from, cited with every conversion.
    pub source: String,
    pub label: String,
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
    /// Unit codes in registry order.
    order: Vec<String>,
    labels: HashMap<String, String>,
}

fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| {
        let units: Value = serde_json::from_str(REGISTRY_JSON).unwrap_or(Value::Null);
        let mut by_code = HashMap::new();
        let mut by_key = HashMap::new();
        let mut order = Vec::new();
        for u in units["units"].as_array().into_iter().flatten() {
            let unit = Unit {
                code: u["code"].as_str().unwrap_or_default().to_string(),
                quantity: u["quantity"].as_str().unwrap_or_default().to_string(),
                factor: u["toSI"]["factor"].as_f64().unwrap_or(1.0),
                offset: u["toSI"]["offset"].as_f64().unwrap_or(0.0),
                convention: u["convention"].as_str().map(String::from),
                source: u["source"].as_str().unwrap_or_default().to_string(),
                label: u["label"].as_str().unwrap_or_default().to_string(),
            };
            order.push(unit.code.clone());
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
        let mut labels = HashMap::new();
        if let Some(qs) = table["quantities"].as_object() {
            for (q, spec) in qs {
                family.insert(q.clone(), spec["family"].as_str().unwrap_or(q).to_string());
                labels.insert(q.clone(), spec["label"].as_str().unwrap_or(q).to_string());
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
            order,
            labels,
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

/// The unit with exactly this code (getUnit); aliases are not accepted here.
pub fn get_unit(code: &str) -> Option<&'static Unit> {
    registry().by_code.get(code)
}

/// Every unit, in registry order (allUnits).
pub fn all_units() -> impl Iterator<Item = &'static Unit> {
    let r = registry();
    r.order.iter().filter_map(|c| r.by_code.get(c))
}

/// True when values of the two quantities convert into each other (sameFamily).
pub fn same_family(a: &str, b: &str) -> bool {
    let f = &registry().family;
    f.get(a).map_or(a, String::as_str) == f.get(b).map_or(b, String::as_str)
}

/// The plain-language name of a quantity, as messages use it (quantityLabel).
pub fn quantity_label(q: &str) -> String {
    registry()
        .labels
        .get(q)
        .cloned()
        .unwrap_or_else(|| q.to_string())
}

/// The registry's version, as conversions record it.
pub fn registry_version() -> String {
    serde_json::from_str::<Value>(REGISTRY_JSON)
        .ok()
        .and_then(|v| v["version"].as_str().map(String::from))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// The unit a column header names (header.ts parseHeaderUnit, reference.ts referenceNote)

/// What a header says: the column name and, when it names one, the unit as a detection.
pub struct HeaderUnit {
    pub name: String,
    pub unit: Option<Value>,
}

/// A detection as detection() builds it: assumed unless the confidence is high.
fn detected(value: &str, confidence: &str, method: &str, evidence: String) -> Value {
    serde_json::json!({
        "value": value,
        "confidence": confidence,
        "assumed": confidence != "high",
        "source": "detected",
        "method": method,
        "evidence": evidence,
    })
}

const WORDS_NOT_UNITS: [&str; 10] = [
    "min", "in", "hp", "mw", "meter", "meters", "second", "day", "hour", "minute",
];
const OPENING: &str = "([{\u{ff08}\u{ff3b}\u{ff5b}";
const CLOSING: &str = ")]}\u{ff09}\u{ff3d}\u{ff5d}";
const MAX_UNIT_TEXT: usize = 64;

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

fn is_separator(c: char) -> bool {
    is_js_space(c) || "_,;:/|\u{2013}\u{2014}-".contains(c)
}

fn strip_trailing(text: &str) -> &str {
    text.trim_end_matches(is_separator)
}

fn is_letter(c: char) -> bool {
    static LETTER: OnceLock<regex::Regex> = OnceLock::new();
    let re = LETTER.get_or_init(|| regex::Regex::new(r"^\p{L}$").expect("letter pattern"));
    let mut buf = [0u8; 4];
    re.is_match(c.encode_utf8(&mut buf))
}

/// The last `n` characters of a text.
fn last_chars(text: &str, n: usize) -> &str {
    let count = text.chars().count();
    match text.char_indices().nth(count.saturating_sub(n)) {
        Some((i, _)) if count > n => &text[i..],
        _ => text,
    }
}

/// A trailing ' in' left before a unit ('Rate in m3/d') belongs to the unit, except after 'shut'.
fn drop_dangling_in(text: &str) -> String {
    let tail: Vec<char> = last_chars(text, 3).chars().collect();
    let dangling = tail.len() == 3
        && is_js_space(tail[0])
        && tail[1].eq_ignore_ascii_case(&'i')
        && tail[2].eq_ignore_ascii_case(&'n');
    if !dangling {
        return text.to_string();
    }
    let cut: String = {
        let n = text.chars().count();
        text.chars().take(n - 2).collect()
    };
    let before = strip_trailing(&cut).to_string();
    let five: Vec<char> = last_chars(&before, 5).chars().collect();
    let lower: String = five.iter().collect::<String>().to_lowercase();
    let shut = lower.ends_with("shut")
        && (five.len() == 4 || five.len() >= 5 && !is_letter(five[five.len() - 5]));
    if shut { text.to_string() } else { before }
}

fn clean_name(text: &str, before_suffix: bool) -> String {
    let stripped = strip_trailing(text);
    let name = if before_suffix {
        drop_dangling_in(stripped)
    } else {
        stripped.to_string()
    };
    js_trim(&name).to_string()
}

fn is_single_letter(raw: &str) -> bool {
    let n = normalize_unit_text(raw);
    let mut chars = n.chars();
    matches!((chars.next(), chars.next()), (Some(c), None) if is_letter(c))
}

fn is_word_not_unit(raw: &str) -> bool {
    WORDS_NOT_UNITS.contains(&normalize_unit_text(raw).to_lowercase().as_str())
}

fn quoted(raw: &str, unit: &Unit) -> String {
    if raw == unit.code {
        format!("\"{raw}\"")
    } else {
        format!("\"{raw}\" ({})", unit.code)
    }
}

fn pressure_words(word: &str) -> Option<&'static str> {
    Some(match word {
        "absolute" | "abs" => "pressure_abs",
        "gauge" | "gage" => "pressure_gauge",
        "differential" | "difference" | "diff" | "delta" | "δ" | "dp" | "δp" => "pressure_diff",
        _ => return None,
    })
}

fn temperature_words(word: &str) -> Option<&'static str> {
    Some(match word {
        "differential" | "difference" | "diff" | "delta" | "δ" | "dt" | "δt" => {
            "temperature_diff"
        }
        _ => return None,
    })
}

/// The quantities a header states in words, each with the first word that states it.
fn stated_quantities(
    header: &str,
    words: fn(&str) -> Option<&'static str>,
    pressure: bool,
) -> Vec<(&'static str, String)> {
    static SPLIT: OnceLock<regex::Regex> = OnceLock::new();
    static GAUGE: OnceLock<regex::Regex> = OnceLock::new();
    let split = SPLIT.get_or_init(|| regex::Regex::new(r"[^\p{L}\p{N}]+").expect("split pattern"));
    let mut stated: Vec<(&'static str, String)> = Vec::new();
    let text = header.replace('\u{2206}', "\u{394}");
    for word in split.split(&text) {
        if let Some(q) = words(&word.to_lowercase())
            && !stated.iter().any(|(s, _)| *s == q)
        {
            stated.push((q, word.to_string()));
        }
    }
    if pressure {
        let gauge = GAUGE.get_or_init(|| {
            regex::Regex::new(
                r"(?i)[(\[{\x{ff08}\x{ff3b}\x{ff5b}]\s*g\s*[)\]}\x{ff09}\x{ff3d}\x{ff5d}]",
            )
            .expect("gauge pattern")
        });
        if let Some(m) = gauge.find(header)
            && !stated.iter().any(|(s, _)| *s == "pressure_gauge")
        {
            stated.push(("pressure_gauge", m.as_str().to_string()));
        }
    }
    stated
}

fn either(codes: &[String]) -> String {
    match codes.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        _ => codes.first().cloned().unwrap_or_default(),
    }
}

fn suggestion(unit: &Unit, quantity: &str) -> String {
    let candidates: Vec<&Unit> = all_units().filter(|u| u.quantity == quantity).collect();
    let same_scale: Vec<&&Unit> = candidates
        .iter()
        .filter(|u| u.factor == unit.factor)
        .collect();
    let twin = same_scale
        .iter()
        .find(|u| u.code.contains(&unit.code))
        .or(same_scale.first());
    match twin {
        Some(u) => u.code.clone(),
        None => either(
            &candidates
                .iter()
                .map(|u| u.code.clone())
                .collect::<Vec<_>>(),
        ),
    }
}

/// Reads the quantity a word in a header names.
type QuantityWords = fn(&str) -> Option<&'static str>;

/// Whether the header leaves the unit's reference in doubt, and what to add to the evidence.
fn reference_note(header: &str, raw: &str, unit: &Unit) -> (bool, String) {
    let (words, pressure): (Option<QuantityWords>, bool) = match unit.quantity.as_str() {
        "pressure_abs" | "pressure_gauge" | "pressure_diff" => (Some(pressure_words), true),
        "temperature" | "temperature_diff" => (Some(temperature_words), false),
        _ => (None, false),
    };
    let stated = words.map_or_else(Vec::new, |w| stated_quantities(header, w, pressure));
    if let Some((q, word)) = stated.first()
        && !stated.iter().any(|(s, _)| *s == unit.quantity)
    {
        let wanted = quantity_label(q);
        return (
            true,
            format!(
                " The header also says \"{word}\", which points to {wanted}, while {} measures {}. If the values are {wanted}, set the unit to {}.",
                unit.code,
                quantity_label(&unit.quantity),
                suggestion(unit, q)
            ),
        );
    }
    let gauge = if unit.code == "psi" {
        Some("psig")
    } else if unit.code == "bar" && lookup_key(raw) == "bar" {
        Some("barg")
    } else {
        None
    };
    let Some(gauge) = gauge else {
        return (false, String::new());
    };
    if let Some((_, absolute)) = stated.iter().find(|(q, _)| *q == "pressure_abs") {
        return (
            false,
            format!(
                " The header says \"{absolute}\", so \"{raw}\" is read as an absolute pressure."
            ),
        );
    }
    (
        true,
        format!(
            " \"{raw}\" does not say whether the pressure is gauge or absolute, so it is read as absolute. If the readings are gauge, set the unit to {gauge}."
        ),
    )
}

fn found(
    header: &str,
    raw: &str,
    name: String,
    unit: &Unit,
    confidence: &str,
    method: &str,
    evidence: String,
) -> HeaderUnit {
    let (doubt, note) = reference_note(header, raw, unit);
    let confidence = if doubt && confidence == "high" {
        "medium"
    } else {
        confidence
    };
    HeaderUnit {
        name,
        unit: Some(detected(&unit.code, confidence, method, evidence + &note)),
    }
}

fn unit_text(raw: &str) -> Option<&'static Unit> {
    if utf16_len(raw) > MAX_UNIT_TEXT {
        None
    } else {
        find_unit(raw)
    }
}

/// Bracketed groups at the top level, as (start, end, content) in characters.
fn bracket_groups(chars: &[char]) -> Vec<(usize, usize, String)> {
    let mut groups = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    for (i, ch) in chars.iter().enumerate() {
        if OPENING.contains(*ch) {
            open.push(i);
        }
        if !CLOSING.contains(*ch) {
            continue;
        }
        if let Some(start) = open.pop()
            && open.is_empty()
        {
            groups.push((start, i + 1, chars[start + 1..i].iter().collect()));
        }
    }
    groups
}

fn from_brackets(text: &str) -> Option<HeaderUnit> {
    let chars: Vec<char> = text.chars().collect();
    let units: Vec<((usize, usize), String, &Unit)> = bracket_groups(&chars)
        .into_iter()
        .filter_map(|(start, end, content)| {
            let raw = js_trim(&content).to_string();
            unit_text(&raw).map(|u| ((start, end), raw, u))
        })
        .collect();
    let ((start, end), raw, unit) = units.last()?;
    let before: String = chars[..*start].iter().collect();
    let after_text: String = chars[*end..].iter().collect();
    let after = js_trim(&after_text);
    let glue = if after.starts_with([',', ';', ':', '.']) {
        ""
    } else {
        " "
    };
    let name = clean_name(
        &format!("{}{glue}{after}", clean_name(&before, false)),
        false,
    );
    let name = if name.is_empty() {
        text.to_string()
    } else {
        name
    };
    let mut others: Vec<String> = Vec::new();
    for (_, _, u) in &units {
        if u.code != unit.code && !others.contains(&u.code) {
            others.push(u.code.clone());
        }
    }
    let evidence = format!(
        "The header \"{text}\" gives the unit {} in brackets.",
        quoted(raw, unit)
    );
    if others.is_empty() {
        return Some(found(
            text,
            raw,
            name,
            unit,
            "high",
            "header-brackets",
            evidence,
        ));
    }
    let conflict = format!(
        " Another bracket also names {}, so the last one is taken as a guess.",
        others.join(", ")
    );
    Some(found(
        text,
        raw,
        name,
        unit,
        "medium",
        "header-brackets",
        evidence + &conflict,
    ))
}

fn suffix_unit(raw: &str) -> Option<&'static Unit> {
    if is_word_not_unit(raw) {
        return None;
    }
    find_unit(raw).or_else(|| {
        raw.contains('_')
            .then(|| find_unit(&raw.replace('_', "/")))
            .flatten()
    })
}

/// Runs of characters that are not white space or one of `stops`, as (start byte, text).
fn tokens<'a>(text: &'a str, stops: &str) -> Vec<(usize, &'a str)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        let stop = is_js_space(c) || stops.contains(c);
        match (stop, start) {
            (true, Some(s)) => {
                out.push((s, &text[s..i]));
                start = None;
            }
            (false, None) => start = Some(i),
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, &text[s..]));
    }
    out
}

fn from_suffix(text: &str) -> Option<HeaderUnit> {
    let toks = tokens(text, "_,;");
    for i in 1..toks.len() {
        let start = toks[i].0;
        if utf16_len(&text[start..]) > MAX_UNIT_TEXT {
            continue;
        }
        let raw = js_trim(&text[start..]);
        let Some(unit) = suffix_unit(raw) else {
            continue;
        };
        let name = clean_name(&text[..start], true);
        if name.is_empty() {
            continue;
        }
        let single = is_single_letter(raw);
        let guess = if single {
            " A single letter is often not a unit, so this is a guess."
        } else {
            ""
        };
        if toks[i - 1].1 == "/" {
            let evidence = format!(
                "The header \"{text}\" gives the unit {} after \" / \", as a units row does.{guess}",
                quoted(raw, unit)
            );
            return Some(found(
                text,
                raw,
                name,
                unit,
                if single { "medium" } else { "high" },
                "header-unit-row",
                evidence,
            ));
        }
        let evidence = format!(
            "The header \"{text}\" ends with {}, read as its unit.{guess}",
            quoted(raw, unit)
        );
        return Some(if single {
            found(
                text,
                raw,
                text.to_string(),
                unit,
                "low",
                "header-suffix",
                evidence,
            )
        } else {
            found(text, raw, name, unit, "medium", "header-suffix", evidence)
        });
    }
    None
}

fn from_word(text: &str) -> Option<HeaderUnit> {
    let stops = "_,;()[]{}\u{ff08}\u{ff09}\u{ff3b}\u{ff3d}\u{ff5b}\u{ff5d}";
    for (_, word) in tokens(text, stops).into_iter().rev() {
        if utf16_len(word) > MAX_UNIT_TEXT || is_single_letter(word) || is_word_not_unit(word) {
            continue;
        }
        let Some(unit) = find_unit(word) else {
            continue;
        };
        let evidence = format!(
            "The header \"{text}\" contains the word {}, which may be its unit.",
            quoted(word, unit)
        );
        return Some(found(
            text,
            word,
            text.to_string(),
            unit,
            "low",
            "header-word",
            evidence,
        ));
    }
    None
}

/// The column name and unit a header gives (parseHeaderUnit): a unit in brackets, then a unit
/// suffix, then a unit word anywhere, each with its evidence.
pub fn parse_header_unit(header: &str) -> HeaderUnit {
    let text = js_trim(header);
    from_brackets(text)
        .or_else(|| from_suffix(text))
        .or_else(|| from_word(text))
        .unwrap_or(HeaderUnit {
            name: text.to_string(),
            unit: None,
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
