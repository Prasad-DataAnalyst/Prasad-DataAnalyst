//! Canonical encodings and digests of SAD section 9.4 (normative): the same bytes as the
//! TypeScript engine and the Python oracle, so audit hashes and column digests agree across engines.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// ECMAScript Number.prototype.toString for a finite double, with -0 written as 0.
pub fn canonical_number(x: f64) -> String {
    let mut out = String::new();
    write_canonical_number(x, &mut out);
    out
}

/// Appends canonical_number(x) to `out`. Between 1e-6 and 1e21 ECMAScript writes fixed notation
/// with the shortest digits that round-trip, which is exactly what Rust's Display writes, so the
/// common case needs no exponent handling and no allocation.
pub fn write_canonical_number(x: f64, out: &mut String) {
    use std::fmt::Write;
    let a = x.abs();
    if x == 0.0 {
        out.push('0');
    } else if (1e-6..1e21).contains(&a) {
        let _ = write!(out, "{x}");
    } else {
        out.push_str(&scientific(x));
    }
}

fn scientific(x: f64) -> String {
    assert!(
        x.is_finite(),
        "a number without a canonical form reached the encoder"
    );
    if x == 0.0 {
        return "0".into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // `{:e}` gives the shortest digits that round-trip, as ECMAScript requires.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').expect("scientific notation");
    let exp: i32 = exp.parse().expect("exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = digits.len() as i32;
    let n = exp + 1; // value = 0.<digits> * 10^n
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let exponent = if e >= 0 {
            format!("+{e}")
        } else {
            format!("-{}", -e)
        };
        if k == 1 {
            format!("{digits}e{exponent}")
        } else {
            format!("{}.{}e{exponent}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// A JSON string literal exactly as JavaScript's JSON.stringify writes it.
pub fn json_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn number_of(n: &serde_json::Number) -> f64 {
    n.as_f64().expect("a JSON number")
}

fn encode(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&canonical_number(number_of(n))),
        Value::String(s) => json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            // Keys in UTF-16 code unit order, as JavaScript's default sort compares them.
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_string(k, out);
                out.push(':');
                encode(&o[k], out);
            }
            out.push('}');
        }
    }
}

/// Keys sorted by UTF-16 code unit, no whitespace, canonical numbers.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    encode(v, &mut out);
    out
}

/// The canonical cell encoding: null, s:text, n:number, b:1/b:0, d:date, t:datetime, g:geometry.
#[cfg_attr(not(test), allow(dead_code))] // Column digests of exports use it next.
pub fn canonical_cell(v: &Value) -> String {
    match v {
        Value::Null => "\u{0}N".into(),
        Value::Bool(b) => {
            if *b {
                "b:1".into()
            } else {
                "b:0".into()
            }
        }
        Value::Number(n) => format!("n:{}", canonical_number(number_of(n))),
        Value::String(s) => format!("s:{s}"),
        Value::Object(o) if o.len() == 1 => {
            if let Some(Value::String(d)) = o.get("date") {
                format!("d:{d}")
            } else if let Some(Value::String(t)) = o.get("datetime") {
                format!("t:{t}")
            } else if let Some(g) = o.get("geometry") {
                format!("g:{}", canonical_json(g))
            } else {
                panic!("not a cell value")
            }
        }
        _ => panic!("not a cell value"),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_fixed_notation_fast_path_agrees_with_the_general_form() {
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut checked = 0;
        while checked < 200_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let x = f64::from_bits(seed);
            if !x.is_finite() || !(1e-6..1e21).contains(&x.abs()) {
                continue;
            }
            assert_eq!(canonical_number(x), scientific(x), "{x:e}");
            checked += 1;
        }
        for x in [
            1e-6,
            9.999999999999999e20,
            0.1 + 0.2,
            123456789012345680.0,
            -42.5,
        ] {
            assert_eq!(canonical_number(x), scientific(x), "{x:e}");
        }
    }

    use super::*;
    use serde_json::json;

    /// The shared golden vectors of SAD section 9.4, the ones the TypeScript and Python encoders pass.
    #[test]
    fn matches_the_shared_canonical_vectors() {
        let text = include_str!("../../../src/model/__fixtures__/canonical-vectors.json");
        let spec: Value = serde_json::from_str(text).unwrap();
        let mut failures = Vec::new();
        let mut unrepresentable = 0;
        for vec in spec["vectors"].as_array().unwrap() {
            let raw = vec["input"].as_str().unwrap();
            // Rust strings cannot hold a lone UTF-16 surrogate; the engine only ever sees UTF-8 text.
            let Ok(input) = serde_json::from_str::<Value>(raw) else {
                assert!(
                    raw.to_lowercase().contains("\\ud8")
                        || raw.to_lowercase().contains("\\udc")
                        || raw.to_lowercase().contains("\\ud"),
                    "{raw}"
                );
                unrepresentable += 1;
                continue;
            };
            let got = match vec["kind"].as_str().unwrap() {
                "number" => canonical_number(input.as_f64().unwrap()),
                "json" => canonical_json(&input),
                _ => canonical_cell(&input),
            };
            if got != vec["expected"].as_str().unwrap() {
                failures.push(format!("{}: {got:?}", vec["name"]));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
        assert!(
            unrepresentable <= 3,
            "only lone-surrogate vectors may be skipped"
        );
    }

    #[test]
    fn writes_numbers_as_javascript_does() {
        for (x, s) in [
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123.0, "123"),
            (-273.15, "-273.15"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(canonical_number(x), s);
        }
        assert_eq!(
            canonical_json(&json!({"b": 1, "a": [true, null]})),
            r#"{"a":[true,null],"b":1}"#
        );
    }
}
