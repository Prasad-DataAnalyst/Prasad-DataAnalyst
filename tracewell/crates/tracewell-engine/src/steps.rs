//! Steps (SAD section 7.7), as the TypeScript src/steps and src/units/convert.ts: a unit
//! conversion adds a derived column to the working view, which the checks read; filters and column
//! selections shape the output view, which exports write, in step order. Conversions go through SI
//! with the registry's factors and are refused, with the reason and a fix, where the result would
//! depend on something the data does not say. Filters become SQL with the TypeScript semantics:
//! every comparison with null is false, even under `not`.

use crate::canonical::canonical_number;
use crate::error::{EngineError, Result};
use crate::import::{quote_ident, quote_text};
use crate::parse::Kind;
use crate::units::{Unit, all_units, get_unit, quantity_label, registry_version, same_family};
use serde_json::{Value, json};
use std::collections::HashSet;

/// A column at a stage: its schema as the protocol carries it, and how its values are stored.
#[derive(Clone, Debug)]
pub struct StageColumn {
    pub schema: Value,
    pub kind: Kind,
}

impl StageColumn {
    pub fn id(&self) -> &str {
        self.schema["id"].as_str().unwrap_or_default()
    }

    fn name(&self) -> &str {
        self.schema["name"].as_str().unwrap_or_default()
    }

    fn typ(&self) -> &str {
        self.schema["type"]["value"].as_str().unwrap_or_default()
    }

    /// The column it is computed from, when a conversion derived it.
    pub fn derived_from(&self) -> Option<&str> {
        self.schema["derivedFrom"]["column"].as_str()
    }
}

// ---------------------------------------------------------------------------------------------
// Conversions (convert.ts)

/// How one unit converts to another (ConversionMethod).
#[derive(Clone, Debug, PartialEq)]
pub struct Method {
    pub from: String,
    pub to: String,
    pub from_factor: f64,
    pub from_offset: f64,
    pub to_factor: f64,
    pub to_offset: f64,
    pub formula: String,
    pub source: String,
}

fn double(x: f64) -> String {
    format!("CAST('{x:?}' AS DOUBLE)")
}

impl Method {
    pub fn to_json(&self) -> Value {
        json!({
            "from": self.from,
            "to": self.to,
            "fromFactor": self.from_factor,
            "fromOffset": self.from_offset,
            "toFactor": self.to_factor,
            "toOffset": self.to_offset,
            "formula": self.formula,
            "source": self.source,
            "registryVersion": registry_version(),
        })
    }

    fn identity(&self) -> bool {
        self.from_factor == self.to_factor && self.from_offset == self.to_offset
    }

    /// applyConversion over a DOUBLE expression, operation for operation:
    /// y = ((x * fromFactor + fromOffset) - toOffset) / toFactor, or x for identical units.
    pub fn sql(&self, x: &str) -> String {
        if self.identity() {
            return x.to_string();
        }
        format!(
            "((({x} * {}) + {}) - {}) / {}",
            double(self.from_factor),
            double(self.from_offset),
            double(self.to_offset),
            double(self.to_factor)
        )
    }
}

fn convention_text(c: &str) -> &'static str {
    match c {
        "gauge" => "gauge, relative to the local atmospheric pressure",
        "std-60F-14.696psia" => "60 °F and 14.696 psia",
        "std-15C-101.325kPa" => "15 °C and 101.325 kPa",
        "std-0C-101.325kPa" => "0 °C and 101.325 kPa",
        _ => "unstated conditions",
    }
}

fn alternatives(u: &Unit) -> Vec<String> {
    all_units()
        .filter(|v| {
            same_family(&u.quantity, &v.quantity)
                && v.convention == u.convention
                && v.code != u.code
        })
        .map(|v| v.code.clone())
        .collect()
}

fn choose_from(u: &Unit, qualifier: &str) -> String {
    let others = alternatives(u);
    if others.is_empty() {
        format!(
            "No other unit {qualifier} is in the registry, so keep {}",
            u.code
        )
    } else {
        format!("Choose a unit {qualifier}: {}", others.join(", "))
    }
}

fn unknown_unit(code: &str) -> EngineError {
    EngineError::new(
        "UNIT_UNKNOWN",
        format!(
            "\"{code}\" is not a unit code in the Tracewell unit registry {}.",
            registry_version()
        ),
        "Choose a unit from the registry's list, or first set the column's unit to a unit from that list.",
    )
}

fn pressure_kind(u: &Unit) -> &'static str {
    if u.quantity == "pressure_gauge" {
        "gauge"
    } else {
        "absolute"
    }
}

fn with_article(kind: &str) -> &'static str {
    if kind == "gauge" {
        "a gauge"
    } else {
        "an absolute"
    }
}

fn is_pair(a: &Unit, b: &Unit, x: &str, y: &str) -> bool {
    (a.quantity == x && b.quantity == y) || (a.quantity == y && b.quantity == x)
}

fn conditions_of(u: &Unit) -> &'static str {
    u.convention
        .as_deref()
        .map_or("no stated reference conditions", convention_text)
}

fn refusal_for(from: &Unit, to: &Unit) -> Option<EngineError> {
    if is_pair(from, to, "pressure_abs", "pressure_gauge") {
        let (fk, tk) = (pressure_kind(from), pressure_kind(to));
        return Some(EngineError::new(
            "UNIT_GAUGE_ABSOLUTE",
            format!(
                "{} is {} pressure and {} is {} pressure. Converting between them needs the local atmospheric pressure, which Tracewell does not assume.",
                from.code,
                with_article(fk),
                to.code,
                with_article(tk)
            ),
            format!(
                "{}. If the values are really {tk} readings, change the column's unit to {} instead of converting.",
                choose_from(from, &format!("that is also {fk}")),
                to.code
            ),
        ));
    }
    if is_pair(from, to, "volume", "std_volume")
        || is_pair(from, to, "volume_rate", "std_volume_rate")
    {
        let from_actual = from.convention.is_none();
        let (actual, standard) = if from_actual { (from, to) } else { (to, from) };
        let really = if from_actual {
            "already at standard conditions"
        } else {
            "really at the measured conditions"
        };
        return Some(EngineError::new(
            "UNIT_CONVENTION",
            format!(
                "{} measures volume at the conditions where it was measured and {} measures volume at {}. Converting needs the measured pressure and temperature, which Tracewell does not assume.",
                actual.code,
                standard.code,
                conditions_of(standard)
            ),
            format!(
                "{}. If the values are {really}, change the column's unit to {} instead of converting.",
                choose_from(from, "of the same kind"),
                to.code
            ),
        ));
    }
    if !same_family(&from.quantity, &to.quantity) {
        let kinds: HashSet<&str> = [from.quantity.as_str(), to.quantity.as_str()].into();
        let note = if kinds.contains("temperature") && kinds.contains("temperature_diff") {
            " A temperature difference has no zero offset: 10 °C warmer is 10 K warmer, but 10 °C is 283.15 K."
        } else if kinds.contains("pressure_diff")
            && (kinds.contains("pressure_abs") || kinds.contains("pressure_gauge"))
        {
            " A pressure difference is not measured from vacuum or from the atmosphere, so it is not a pressure."
        } else {
            ""
        };
        let from_kind = quantity_label(&from.quantity);
        return Some(EngineError::new(
            "UNIT_DIMENSION",
            format!(
                "{} measures {from_kind} and {} measures {}, so one cannot be converted to the other.{note}",
                from.code,
                to.code,
                quantity_label(&to.quantity)
            ),
            format!("{}.", choose_from(from, &format!("of {from_kind}"))),
        ));
    }
    if from.convention != to.convention {
        return Some(EngineError::new(
            "UNIT_CONVENTION",
            format!(
                "{} is a {} at {} and {} is at {}. Changing the reference conditions needs a correction for the fluid, which Tracewell does not apply silently.",
                from.code,
                quantity_label(&from.quantity),
                conditions_of(from),
                to.code,
                conditions_of(to)
            ),
            format!(
                "{}. Conversions between reference conditions are not supported in this version.",
                choose_from(from, &format!("at {}", conditions_of(from)))
            ),
        ));
    }
    None
}

/// `expr + value`, written `expr - |value|` for a negative value; expr itself when value is 0.
fn plus(expr: &str, value: f64) -> String {
    if value == 0.0 {
        expr.to_string()
    } else if value > 0.0 {
        format!("{expr} + {}", canonical_number(value))
    } else {
        format!("{expr} - {}", canonical_number(-value))
    }
}

fn formula_text(ff: f64, fo: f64, tf: f64, to: f64) -> String {
    if ff == tf && fo == to {
        return "y = x".into();
    }
    let scaled = if ff == 1.0 {
        "x".to_string()
    } else {
        format!("x * {}", canonical_number(ff))
    };
    let shifted = plus(&plus(&scaled, fo), -to);
    if tf == 1.0 {
        return format!("y = {shifted}");
    }
    let dividend = if shifted == scaled {
        shifted
    } else {
        format!("({shifted})")
    };
    format!("y = {dividend} / {}", canonical_number(tf))
}

/// The method that converts `from` to `to` (conversionMethod), or the refusal with its reason.
pub fn conversion_method(from: &str, to: &str) -> Result<Method> {
    let a = get_unit(from).ok_or_else(|| unknown_unit(from))?;
    let b = get_unit(to).ok_or_else(|| unknown_unit(to))?;
    if let Some(refusal) = refusal_for(a, b) {
        return Err(refusal);
    }
    Ok(Method {
        from: a.code.clone(),
        to: b.code.clone(),
        from_factor: a.factor,
        from_offset: a.offset,
        to_factor: b.factor,
        to_offset: b.offset,
        formula: formula_text(a.factor, a.offset, b.factor, b.offset),
        source: if a.source == b.source {
            a.source.clone()
        } else {
            format!("{}: {} | {}: {}", a.code, a.source, b.code, b.source)
        },
    })
}

// ---------------------------------------------------------------------------------------------
// Predicates (predicate.ts), as SQL

fn invalid(message: String, fix: &str) -> EngineError {
    EngineError::invalid(message, fix)
}

fn column_of<'a>(cols: &'a [StageColumn], id: &str) -> Result<&'a StageColumn> {
    cols.iter().find(|c| c.id() == id).ok_or_else(|| {
        invalid(
            format!("The filter refers to column {id}, which is not in the data at this step."),
            "Choose a listed column.",
        )
    })
}

fn sole_string<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    let o = v.as_object()?;
    (o.len() == 1).then(|| o.get(key)?.as_str()).flatten()
}

fn comparable(typ: &str, v: &Value) -> bool {
    match typ {
        "integer" | "number" => v.is_number(),
        "string" => v.is_string(),
        "boolean" => v.is_boolean(),
        "date" => sole_string(v, "date").is_some(),
        "datetime" => sole_string(v, "datetime").is_some(),
        _ => false,
    }
}

fn check_value(c: &StageColumn, v: &Value) -> Result<()> {
    if comparable(c.typ(), v) {
        return Ok(());
    }
    Err(invalid(
        format!(
            "The value {} cannot be compared with {}, which holds {} values.",
            serde_json::to_string(v).unwrap_or_default(),
            c.name(),
            c.typ()
        ),
        &format!("Enter a {} value.", c.typ()),
    ))
}

/// The value of a column as the TypeScript filter compares it: dates and date-times as their
/// canonical text, everything else as stored.
fn key_expr(c: &StageColumn) -> String {
    let q = quote_ident(c.id());
    match c.typ() {
        "date" => format!("CAST(DATE '1970-01-01' + {q} AS VARCHAR)"),
        "datetime" => format!("strftime(make_timestamp({q} * 1000), '%Y-%m-%dT%H:%M:%S.%gZ')"),
        _ => q,
    }
}

fn literal(c: &StageColumn, v: &Value) -> String {
    match c.typ() {
        "integer" | "number" => double(v.as_f64().unwrap_or(f64::NAN)),
        "boolean" => if v.as_bool() == Some(true) {
            "TRUE"
        } else {
            "FALSE"
        }
        .into(),
        "date" => quote_text(sole_string(v, "date").unwrap_or_default()),
        "datetime" => quote_text(sole_string(v, "datetime").unwrap_or_default()),
        _ => quote_text(v.as_str().unwrap_or_default()),
    }
}

/// The predicate as a SQL condition that is never null (compilePredicate), checked against the
/// columns of the step it belongs to.
pub fn predicate_sql(p: &Value, cols: &[StageColumn]) -> Result<String> {
    let all_of = |parts: &[Value], join: &str, empty: &str| -> Result<String> {
        if parts.is_empty() {
            return Ok(empty.into());
        }
        let sql: Vec<String> = parts
            .iter()
            .map(|x| predicate_sql(x, cols))
            .collect::<Result<_>>()?;
        Ok(format!("({})", sql.join(join)))
    };
    if let Some(parts) = p.get("all").and_then(Value::as_array) {
        return all_of(parts, " AND ", "TRUE");
    }
    if let Some(parts) = p.get("any").and_then(Value::as_array) {
        return all_of(parts, " OR ", "FALSE");
    }
    if let Some(inner) = p.get("not") {
        return Ok(format!("(NOT {})", predicate_sql(inner, cols)?));
    }
    if let Some(bbox) = p.get("bbox") {
        let b: Vec<f64> = bbox
            .as_array()
            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
            .unwrap_or_default();
        let at = |i: usize| b.get(i).copied().unwrap_or(f64::NAN);
        if let Some(g) = p.get("geometry") {
            let g = column_of(cols, g.as_str().unwrap_or_default())?;
            return Err(invalid(
                format!("{} does not hold geometries.", g.name()),
                "Choose the geometry column.",
            ));
        }
        let lat = column_of(cols, p["lat"].as_str().unwrap_or_default())?;
        let lon = column_of(cols, p["lon"].as_str().unwrap_or_default())?;
        for c in [lat, lon] {
            if c.typ() != "number" && c.typ() != "integer" {
                return Err(invalid(
                    format!(
                        "{} does not hold numbers, so it cannot be used as a coordinate.",
                        c.name()
                    ),
                    "Choose the latitude and longitude columns.",
                ));
            }
        }
        let (y, x) = (quote_ident(lat.id()), quote_ident(lon.id()));
        let (w, s, e, n) = (at(0), at(1), at(2), at(3));
        let lon_test = if w <= e {
            format!("{x} >= {} AND {x} <= {}", double(w), double(e))
        } else {
            format!(
                "(({x} >= {} AND {x} <= 180) OR ({x} >= -180 AND {x} <= {}))",
                double(w),
                double(e)
            )
        };
        return Ok(format!(
            "coalesce((isfinite({x}) AND isfinite({y}) AND {y} >= {} AND {y} <= {} AND {lon_test}), false)",
            double(s),
            double(n)
        ));
    }
    let c = column_of(cols, p["column"].as_str().unwrap_or_default())?;
    let k = key_expr(c);
    let q = quote_ident(c.id());
    let op = p["op"].as_str().unwrap_or_default();
    Ok(match op {
        "is_null" => format!("({q} IS NULL)"),
        "not_null" => format!("({q} IS NOT NULL)"),
        "eq" | "ne" | "lt" | "le" | "gt" | "ge" => {
            check_value(c, &p["value"])?;
            if c.typ() == "boolean" && op != "eq" && op != "ne" {
                return Err(invalid(
                    format!(
                        "{} holds true/false values, which can only be tested for equal or not equal.",
                        c.name()
                    ),
                    "Use = or ≠.",
                ));
            }
            let sql_op = match op {
                "eq" => "=",
                "ne" => "<>",
                "lt" => "<",
                "le" => "<=",
                "gt" => ">",
                _ => ">=",
            };
            format!(
                "coalesce(({k} {sql_op} {}), false)",
                literal(c, &p["value"])
            )
        }
        "between" => {
            check_value(c, &p["low"])?;
            check_value(c, &p["high"])?;
            format!(
                "coalesce(({k} >= {} AND {k} <= {}), false)",
                literal(c, &p["low"]),
                literal(c, &p["high"])
            )
        }
        "in" => {
            let values = p["values"].as_array().cloned().unwrap_or_default();
            for v in &values {
                check_value(c, v)?;
            }
            if values.is_empty() {
                "FALSE".into()
            } else {
                let list: Vec<String> = values.iter().map(|v| literal(c, v)).collect();
                format!("coalesce(({k} IN ({})), false)", list.join(", "))
            }
        }
        "contains" => {
            if c.typ() != "string" {
                return Err(invalid(
                    format!(
                        "\"Contains\" works on text columns; {} holds {} values.",
                        c.name(),
                        c.typ()
                    ),
                    "Use a comparison instead.",
                ));
            }
            let text = p["text"].as_str().unwrap_or_default();
            if p["caseSensitive"] == true {
                format!("coalesce(contains({q}, {}), false)", quote_text(text))
            } else {
                format!(
                    "coalesce(contains(lower({q}), {}), false)",
                    quote_text(&text.to_lowercase())
                )
            }
        }
        other => {
            return Err(invalid(
                format!("The filter operator {other} does not exist."),
                "Choose one of the listed comparisons.",
            ));
        }
    })
}

/// The plain-language form of a predicate, for step descriptions (describePredicate).
pub fn describe_predicate(p: &Value, cols: &[StageColumn]) -> String {
    let name = |id: &str| -> String {
        cols.iter()
            .find(|c| c.id() == id)
            .map_or(id.to_string(), |c| c.name().to_string())
    };
    let value = |v: &Value| -> String {
        match v {
            Value::Object(o) => o
                .get("date")
                .or_else(|| o.get("datetime"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            Value::String(s) => format!("\"{s}\""),
            Value::Number(_) => canonical_number(v.as_f64().unwrap_or(0.0)),
            other => other.to_string(),
        }
    };
    if let Some(parts) = p.get("all").and_then(Value::as_array) {
        return parts
            .iter()
            .map(|x| describe_predicate(x, cols))
            .collect::<Vec<_>>()
            .join(" and ");
    }
    if let Some(parts) = p.get("any").and_then(Value::as_array) {
        let inner: Vec<String> = parts.iter().map(|x| describe_predicate(x, cols)).collect();
        return format!("({})", inner.join(" or "));
    }
    if let Some(inner) = p.get("not") {
        return format!("not ({})", describe_predicate(inner, cols));
    }
    if let Some(b) = p.get("bbox") {
        let parts: Vec<String> = b
            .as_array()
            .into_iter()
            .flatten()
            .map(|x| canonical_number(x.as_f64().unwrap_or(0.0)))
            .collect();
        return format!("location is within [{}]", parts.join(", "));
    }
    let col = name(p["column"].as_str().unwrap_or_default());
    match p["op"].as_str().unwrap_or_default() {
        "is_null" => format!("{col} is empty"),
        "not_null" => format!("{col} is not empty"),
        "between" => format!(
            "{col} is between {} and {}",
            value(&p["low"]),
            value(&p["high"])
        ),
        "in" => format!(
            "{col} is one of {}",
            p["values"]
                .as_array()
                .into_iter()
                .flatten()
                .map(value)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        "contains" => format!(
            "{col} contains \"{}\"{}",
            p["text"].as_str().unwrap_or_default(),
            if p["caseSensitive"] == true {
                " (case-sensitive)"
            } else {
                ""
            }
        ),
        op => {
            let sign = match op {
                "eq" => "=",
                "ne" => "≠",
                "lt" => "<",
                "le" => "≤",
                "gt" => ">",
                _ => "≥",
            };
            format!("{col} {sign} {}", value(&p["value"]))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Views (views.ts)

/// The ID of the column a conversion derives: `<column>~<unit>` with every character other than
/// a letter, digit or underscore as `_` (one per UTF-16 unit, as the JavaScript pattern replaces).
pub fn derived_id(column: &str, to_unit: &str) -> String {
    let mut out = format!("{column}~");
    for ch in to_unit.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else {
            for _ in 0..ch.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

fn find_column<'a>(cols: &'a [StageColumn], id: &str) -> Result<&'a StageColumn> {
    cols.iter().find(|c| c.id() == id).ok_or_else(|| {
        EngineError::not_found(
            format!("There is no column {id} at this step."),
            "Choose a listed column.",
        )
    })
}

/// The method a conversion step uses on the columns it sees (conversionFor).
pub fn conversion_for(step: &Value, cols: &[StageColumn]) -> Result<Method> {
    let c = find_column(cols, step["columnId"].as_str().unwrap_or_default())?;
    if c.typ() != "number" && c.typ() != "integer" {
        return Err(EngineError::invalid(
            format!(
                "{} holds {} values; only number columns can be converted.",
                c.name(),
                c.typ()
            ),
            "Choose a numeric column, or change the column type first.",
        ));
    }
    let Some(from) = c.schema["unit"]["value"].as_str() else {
        return Err(EngineError::new(
            "UNIT_UNKNOWN",
            format!("{} has no unit, so it cannot be converted.", c.name()),
            "Set the column unit first.",
        ));
    };
    conversion_method(from, step["toUnit"].as_str().unwrap_or_default())
}

/// A conversion's derived column (derivedFor).
pub struct Derived {
    pub id: String,
    pub source: String,
    pub method: Method,
}

/// What the steps make of a dataset's columns.
pub struct Stages {
    /// The working view's columns, in order: replaced sources hidden, derived columns placed.
    pub working: Vec<StageColumn>,
    /// Every column of the working view, hidden ones included.
    pub every: Vec<StageColumn>,
    pub derived: Vec<Derived>,
    /// The output view's columns, in order.
    pub output: Vec<StageColumn>,
    /// The filters' conditions, in step order.
    pub filters: Vec<String>,
}

fn user_detection(value: &str, seq: &Value) -> Value {
    json!({
        "value": value,
        "confidence": "high",
        "assumed": false,
        "source": "user",
        "method": "user-override",
        "evidence": format!("Set by the user in audit entry {}.", seq.as_u64().map_or_else(|| seq.to_string(), |s| s.to_string())),
        "overriddenBy": seq,
    })
}

/// Builds the working and output views' columns from the dataset's columns and its steps (with
/// their IDs and seqs), as buildWorkingView and buildOutputView do. Fails as they do when a step
/// no longer builds.
pub fn build(base: &[StageColumn], steps: &[Value]) -> Result<Stages> {
    let mut every: Vec<StageColumn> = base.to_vec();
    let mut order: Vec<String> = base.iter().map(|c| c.id().to_string()).collect();
    let mut hidden: HashSet<String> = HashSet::new();
    let mut derived = Vec::new();
    let visible = |order: &[String], hidden: &HashSet<String>, every: &[StageColumn]| {
        order
            .iter()
            .filter(|id| !hidden.contains(*id))
            .filter_map(|id| every.iter().find(|c| c.id() == id).cloned())
            .collect::<Vec<_>>()
    };
    let mut working = visible(&order, &hidden, &every);
    for step in steps.iter().filter(|s| s["kind"] == "convert_unit") {
        let column = step["columnId"].as_str().unwrap_or_default().to_string();
        let source = find_column(&working, &column)?.clone();
        let method = conversion_for(step, &working)?;
        let to = step["toUnit"].as_str().unwrap_or_default();
        let id = derived_id(&column, to);
        let replace = step["mode"] == "replace";
        let mut schema = source.schema.clone();
        schema["id"] = json!(id);
        if !replace {
            schema["name"] = json!(format!("{} ({})", source.name(), method.to));
        }
        schema["type"]["value"] = json!("number");
        schema["unit"] = user_detection(&method.to, &step["seq"]);
        if let Some(unit) = get_unit(&method.to) {
            schema["quantity"] = json!(unit.quantity);
        }
        schema["derivedFrom"] = json!({ "column": column, "step": step["id"] });
        every.push(StageColumn {
            schema,
            kind: Kind::Number,
        });
        derived.push(Derived {
            id: id.clone(),
            source: column.clone(),
            method,
        });
        let at = order
            .iter()
            .position(|c| *c == column)
            .unwrap_or(order.len());
        if replace {
            hidden.insert(column.clone());
            if at < order.len() {
                order[at] = id;
            } else {
                order.push(id);
            }
        } else {
            order.insert((at + 1).min(order.len()), id);
        }
        working = visible(&order, &hidden, &every);
    }
    let mut output = working.clone();
    let mut filters = Vec::new();
    for step in steps {
        match step["kind"].as_str() {
            Some("filter") => filters.push(predicate_sql(&step["predicate"], &output)?),
            Some("select_columns") => {
                let ids: Vec<&str> = step["columnIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                for id in &ids {
                    find_column(&output, id)?;
                }
                output = ids
                    .iter()
                    .map(|id| find_column(&working, id).cloned())
                    .collect::<Result<_>>()?;
            }
            _ => {}
        }
    }
    Ok(Stages {
        working,
        every,
        derived,
        output,
        filters,
    })
}

/// Checks a new step against the columns it would see (validateStep): the working view's for a
/// conversion, the output so far for a filter or a selection.
pub fn validate(step: &Value, stages: &Stages) -> Result<()> {
    match step["kind"].as_str() {
        Some("convert_unit") => {
            conversion_for(step, &stages.working)?;
            let id = derived_id(
                step["columnId"].as_str().unwrap_or_default(),
                step["toUnit"].as_str().unwrap_or_default(),
            );
            if stages.working.iter().any(|c| c.id() == id) {
                return Err(EngineError::invalid(
                    format!(
                        "The column is already converted to {}.",
                        step["toUnit"].as_str().unwrap_or_default()
                    ),
                    "Remove the earlier conversion first.",
                ));
            }
        }
        Some("filter") => {
            predicate_sql(&step["predicate"], &stages.output)?;
        }
        Some("select_columns") => {
            let ids: Vec<&Value> = step["columnIds"].as_array().into_iter().flatten().collect();
            if ids.is_empty() {
                return Err(EngineError::invalid(
                    "Select at least one column to keep.",
                    "Tick the columns to keep.",
                ));
            }
            let distinct: HashSet<String> = ids.iter().map(|v| v.to_string()).collect();
            if distinct.len() != ids.len() {
                return Err(EngineError::invalid(
                    "A column is selected twice.",
                    "Select each column once.",
                ));
            }
            for id in ids {
                find_column(&stages.output, id.as_str().unwrap_or_default())?;
            }
        }
        other => {
            return Err(EngineError::invalid(
                format!(
                    "The step kind {} does not exist.",
                    other.unwrap_or("undefined")
                ),
                "Choose a unit conversion, a filter or a column selection.",
            ));
        }
    }
    Ok(())
}

/// A step in plain language (describeStep), against the columns it sees.
pub fn describe(step: &Value, cols: &[StageColumn]) -> String {
    match step["kind"].as_str() {
        Some("convert_unit") => {
            let id = step["columnId"].as_str().unwrap_or_default();
            let name = cols
                .iter()
                .find(|c| c.id() == id)
                .map_or(id.to_string(), |c| c.name().to_string());
            match conversion_for(step, cols) {
                Ok(m) => {
                    let how = if m.from_offset == 0.0 && m.to_offset == 0.0 {
                        format!("×{}", canonical_number(m.from_factor / m.to_factor))
                    } else {
                        m.formula.clone()
                    };
                    let mode = if step["mode"] == "add_column" {
                        ", as a new column"
                    } else {
                        ""
                    };
                    format!(
                        "Convert {name} from {} to {} ({how}, {}){mode}",
                        m.from, m.to, m.source
                    )
                }
                Err(_) => format!(
                    "Convert {name} to {}",
                    step["toUnit"].as_str().unwrap_or_default()
                ),
            }
        }
        Some("filter") => step["label"].as_str().map_or_else(
            || {
                format!(
                    "Keep rows where {}",
                    describe_predicate(&step["predicate"], cols)
                )
            },
            String::from,
        ),
        _ => {
            let names: Vec<String> = step["columnIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|id| {
                    cols.iter()
                        .find(|c| c.id() == id)
                        .map_or(id.to_string(), |c| c.name().to_string())
                })
                .collect();
            format!("Keep columns {}", names.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_follow_the_registry_and_refuse_what_needs_more_data() {
        let m = conversion_method("psia", "kPa").expect("converts");
        assert_eq!(m.from_offset, 0.0);
        assert!(m.formula.starts_with("y = x * "));
        assert_ne!(
            conversion_method("degC", "degF")
                .expect("converts")
                .from_offset,
            0.0
        );
        assert_eq!(
            conversion_method("psia", "psig").err().map(|e| e.code),
            Some("UNIT_GAUGE_ABSOLUTE")
        );
        assert_eq!(
            conversion_method("m", "kg").err().map(|e| e.code),
            Some("UNIT_DIMENSION")
        );
        assert_eq!(
            conversion_method("m", "furlong").err().map(|e| e.code),
            Some("UNIT_UNKNOWN")
        );
    }

    #[test]
    fn derived_ids_replace_each_utf16_unit() {
        assert_eq!(derived_id("c3", "kPa"), "c3~kPa");
        assert_eq!(derived_id("c3", "m3/d"), "c3~m3_d");
        assert_eq!(derived_id("c3", "°F"), "c3~_F");
        assert_eq!(derived_id("c3", "𝑚"), "c3~__");
    }

    #[test]
    fn filters_are_never_null_so_not_inverts_them_as_typescript_does() {
        let cols = vec![StageColumn {
            schema: json!({ "id": "c1", "name": "Pressure", "type": { "value": "number" } }),
            kind: Kind::Number,
        }];
        let sql = predicate_sql(
            &json!({ "not": { "column": "c1", "op": "gt", "value": 5 } }),
            &cols,
        )
        .expect("compiles");
        assert_eq!(
            sql,
            "(NOT coalesce((\"c1\" > CAST('5.0' AS DOUBLE)), false))"
        );
        let err = predicate_sql(
            &json!({ "column": "c1", "op": "contains", "text": "x" }),
            &cols,
        )
        .err();
        assert_eq!(
            err.map(|e| e.message),
            Some("\"Contains\" works on text columns; Pressure holds number values.".to_string())
        );
        assert_eq!(
            describe_predicate(
                &json!({ "all": [{ "column": "c1", "op": "ge", "value": 1200 }, { "column": "c1", "op": "is_null" }] }),
                &cols
            ),
            "Pressure ≥ 1200 and Pressure is empty"
        );
    }
}
