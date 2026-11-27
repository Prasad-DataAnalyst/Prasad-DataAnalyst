//! Project conventions (FR-CNV-01, FR-CNV-02), as model/conventions.ts defines them: the same
//! choices, the same validation and messages, and the same one-line statement an export makes.

use crate::canonical::{canonical_number, stringify};
use crate::units::is_js_space;
use serde_json::{Map, Value, json};

const STANDARD_CONDITIONS: [&str; 3] = [
    "std-60F-14.696psia",
    "std-15C-101.325kPa",
    "std-0C-101.325kPa",
];
const ENERGY_UNITS: [&str; 3] = ["MMBtu", "GJ", "kWh"];
const TONNE_ENERGY_UNITS: [&str; 3] = ["MMBtu/t", "GJ/t", "kWh/t"];
/// The combustion reference temperatures of ISO 6976:2016, °C.
const COMBUSTION_TEMPERATURES: [f64; 5] = [25.0, 20.0, 15.55, 15.0, 0.0];
/// The metering reference temperatures of ISO 6976:2016, °C.
const METERING_TEMPERATURES: [f64; 4] = [20.0, 15.55, 15.0, 0.0];
const KEYS: [&str; 5] = [
    "standardConditions",
    "energyUnit",
    "combustionTemperature",
    "meteringTemperature",
    "tonneToEnergy",
];
const TONNE_KEYS: [&str; 3] = ["factor", "unit", "source"];

/// No convention set (NO_CONVENTIONS).
pub fn none() -> Value {
    json!({
        "standardConditions": null,
        "energyUnit": null,
        "combustionTemperature": null,
        "meteringTemperature": null,
        "tonneToEnergy": null,
    })
}

fn keys_problem(v: &Map<String, Value>, keys: &[&str], what: &str) -> Option<String> {
    let missing: Vec<&str> = keys
        .iter()
        .filter(|k| !v.contains_key(**k))
        .copied()
        .collect();
    let extra: Vec<&str> = v
        .keys()
        .filter(|k| !keys.contains(&k.as_str()))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Some(format!("{what} has no {}", missing.join(", ")));
    }
    if !extra.is_empty() {
        return Some(format!(
            "{what} has the unknown member {}",
            extra.join(", ")
        ));
    }
    None
}

fn one_of_text(value: &Value, choices: &[&str], what: &str) -> Option<String> {
    if value.is_null() || value.as_str().is_some_and(|s| choices.contains(&s)) {
        return None;
    }
    let listed: Vec<String> = choices.iter().map(|c| stringify(&json!(c))).collect();
    Some(format!(
        "{what} {} is not one of {}",
        stringify(value),
        listed.join(", ")
    ))
}

fn one_of_number(value: &Value, choices: &[f64], what: &str) -> Option<String> {
    if value.is_null()
        || value
            .as_f64()
            .is_some_and(|t| value.is_number() && choices.contains(&t))
    {
        return None;
    }
    let listed: Vec<String> = choices.iter().map(|c| canonical_number(*c)).collect();
    Some(format!(
        "{what} {} is not one of {}",
        stringify(value),
        listed.join(", ")
    ))
}

/// Why a value is not a set of conventions (conventionsProblem), or None when it is one.
pub fn problem(v: &Value) -> Option<String> {
    let Some(o) = v.as_object() else {
        return Some("the conventions are not an object".into());
    };
    if let Some(p) = keys_problem(o, &KEYS, "the conventions") {
        return Some(p);
    }
    let found = one_of_text(
        &o["standardConditions"],
        &STANDARD_CONDITIONS,
        "the standard conditions",
    )
    .or_else(|| one_of_text(&o["energyUnit"], &ENERGY_UNITS, "the energy unit"))
    .or_else(|| {
        one_of_number(
            &o["combustionTemperature"],
            &COMBUSTION_TEMPERATURES,
            "the combustion reference temperature",
        )
    })
    .or_else(|| {
        one_of_number(
            &o["meteringTemperature"],
            &METERING_TEMPERATURES,
            "the metering reference temperature",
        )
    });
    if found.is_some() {
        return found;
    }
    let t = &o["tonneToEnergy"];
    if t.is_null() {
        return None;
    }
    let Some(t) = t.as_object() else {
        return Some("the tonne-to-energy factor is not an object".into());
    };
    if let Some(p) = keys_problem(t, &TONNE_KEYS, "the tonne-to-energy factor") {
        return Some(p);
    }
    if !t["factor"]
        .as_f64()
        .is_some_and(|f| f.is_finite() && f > 0.0)
    {
        return Some("the tonne-to-energy factor is not a number greater than 0".into());
    }
    if !t["unit"]
        .as_str()
        .is_some_and(|u| TONNE_ENERGY_UNITS.contains(&u))
    {
        let listed: Vec<String> = TONNE_ENERGY_UNITS
            .iter()
            .map(|c| stringify(&json!(c)))
            .collect();
        return Some(format!(
            "the tonne-to-energy unit {} is not one of {}",
            stringify(&t["unit"]),
            listed.join(", ")
        ));
    }
    let Some(source) = t["source"].as_str() else {
        return Some("the tonne-to-energy factor names no source".into());
    };
    if source.trim_matches(is_js_space).is_empty() {
        return Some("the tonne-to-energy factor names no source".into());
    }
    if source.encode_utf16().count() > 200 {
        return Some(
            "the source of the tonne-to-energy factor is longer than 200 characters".into(),
        );
    }
    None
}

/// The conventions as they are recorded (recordedConventions): their members in one order, the
/// factor's source trimmed. Call it on conventions `problem` accepts.
pub fn recorded(c: &Value) -> Value {
    let t = &c["tonneToEnergy"];
    json!({
        "standardConditions": c["standardConditions"],
        "energyUnit": c["energyUnit"],
        "combustionTemperature": c["combustionTemperature"],
        "meteringTemperature": c["meteringTemperature"],
        "tonneToEnergy": if t.is_null() {
            Value::Null
        } else {
            json!({
                "factor": t["factor"],
                "unit": t["unit"],
                "source": t["source"].as_str().unwrap_or("").trim_matches(is_js_space),
            })
        },
    })
}

fn temperature_text(t: f64) -> String {
    if t == 15.55 {
        "15.55 °C (60 °F)".into()
    } else {
        format!("{} °C", canonical_number(t))
    }
}

/// The conventions in one line (conventionsText), as an export's README states them; None when none is set.
pub fn text(c: &Value) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(s) = c["standardConditions"].as_str() {
        let name = match s {
            "std-60F-14.696psia" => "60 °F and 14.696 psia",
            "std-15C-101.325kPa" => "15 °C and 101.325 kPa",
            _ => "0 °C and 101.325 kPa",
        };
        parts.push(format!("standard conditions {name}"));
    }
    if let Some(u) = c["energyUnit"].as_str() {
        parts.push(format!("energy in {u}"));
    }
    if let Some(t) = c["combustionTemperature"].as_f64() {
        parts.push(format!("combustion at {}", temperature_text(t)));
    }
    if let Some(t) = c["meteringTemperature"].as_f64() {
        parts.push(format!("metering at {}", temperature_text(t)));
    }
    let t = &c["tonneToEnergy"];
    if !t.is_null() {
        parts.push(format!(
            "{} {} ({})",
            canonical_number(t["factor"].as_f64().unwrap_or(0.0)),
            t["unit"].as_str().unwrap_or(""),
            t["source"].as_str().unwrap_or("").trim_matches(is_js_space)
        ));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_states_conventions_as_the_typescript_code_does() {
        let lng = json!({
            "standardConditions": "std-15C-101.325kPa",
            "energyUnit": "MMBtu",
            "combustionTemperature": 15,
            "meteringTemperature": 15.55,
            "tonneToEnergy": { "factor": 51.9, "unit": "MMBtu/t", "source": "  Sales contract, clause 12.3 " },
        });
        assert_eq!(problem(&lng), None);
        assert_eq!(
            text(&recorded(&lng)).unwrap(),
            "standard conditions 15 °C and 101.325 kPa, energy in MMBtu, combustion at 15 °C, metering at 15.55 °C (60 °F), 51.9 MMBtu/t (Sales contract, clause 12.3)"
        );
        assert_eq!(text(&none()), None);
        let with = |key: &str, v: Value| {
            let mut c = lng.clone();
            c[key] = v;
            problem(&c).unwrap()
        };
        assert_eq!(
            with("standardConditions", json!("std-20C-101.325kPa")),
            r#"the standard conditions "std-20C-101.325kPa" is not one of "std-60F-14.696psia", "std-15C-101.325kPa", "std-0C-101.325kPa""#
        );
        assert_eq!(
            with("meteringTemperature", json!(25)),
            "the metering reference temperature 25 is not one of 20, 15.55, 15, 0"
        );
        assert_eq!(
            with(
                "tonneToEnergy",
                json!({ "factor": 0, "unit": "MMBtu/t", "source": "x" })
            ),
            "the tonne-to-energy factor is not a number greater than 0"
        );
        assert_eq!(
            with(
                "tonneToEnergy",
                json!({ "factor": 52, "unit": "MMBtu/t", "source": " " })
            ),
            "the tonne-to-energy factor names no source"
        );
        let mut extra = lng.clone();
        extra["extra"] = json!(1);
        assert_eq!(
            problem(&extra).unwrap(),
            "the conventions has the unknown member extra"
        );
        assert_eq!(
            problem(&json!([])).unwrap(),
            "the conventions are not an object"
        );
    }
}
