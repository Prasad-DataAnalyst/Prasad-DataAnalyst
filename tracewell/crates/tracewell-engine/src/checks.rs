//! The check primitives (SAD section 8.3) as SQL over the working view, with the semantics of the
//! TypeScript checks (src/rules/checks.ts) one for one: the same rows, messages and details.
//!
//! Each check reads the rows table (typed values) and, where it needs source text, the exceptions
//! table (failed parses and matched null markers). Time series are grouped by the first id column
//! and ordered by time, then file order; numbers are compared as doubles, as JavaScript does.

use crate::csv::Note;
use crate::error::{EngineError, Result};
use crate::import::quote_ident;
use crate::import::quote_text;
use crate::parse::Kind;
use crate::rules::{Draft, Pack, RowSet, Rule, Var, check_packs, render_message};
use crate::stream::each_batch;
use crate::units::{is_js_space, js_trim, physical_bounds, split_value_unit};
use duckdb::Connection;
use duckdb::arrow::array::{Array, AsArray};
use duckdb::arrow::datatypes::Int64Type;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

const WGS84: [&str; 2] = ["OGC:CRS84", "EPSG:4326"];
const MAD_SCALE: f64 = 1.4826;
/// JavaScript white space as a regular-expression class body (RE2 syntax), for SQL filters.
const JS_SPACE_CLASS: &str = r"\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// A column as the checks see it (ColumnSchema).
pub struct Col {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub typ: String,
    pub role: String,
    pub unit: Option<String>,
    pub quantity: Option<String>,
    pub timezone: Option<(String, bool)>,
    pub date_format: Option<(String, bool)>,
}

impl Col {
    pub fn from_schema(c: &Value, kind: Kind) -> Col {
        let detected = |k: &str| -> Option<(String, bool)> {
            let d = &c[k];
            d["value"]
                .as_str()
                .map(|v| (v.to_string(), d["assumed"].as_bool() == Some(true)))
        };
        Col {
            id: c["id"].as_str().unwrap_or_default().to_string(),
            name: c["name"].as_str().unwrap_or_default().to_string(),
            kind,
            typ: c["type"]["value"].as_str().unwrap_or_default().to_string(),
            role: c["role"]["value"].as_str().unwrap_or_default().to_string(),
            unit: c["unit"]["value"].as_str().map(String::from),
            quantity: c["quantity"].as_str().map(String::from),
            timezone: detected("timezone"),
            date_format: detected("dateFormat"),
        }
    }

    fn numeric(&self) -> bool {
        matches!(self.kind, Kind::Number | Kind::Integer)
    }

    fn q(&self) -> String {
        quote_ident(&self.id)
    }
}

/// What a check run sees: the working view, the import's notes and assumptions.
pub struct CheckCtx<'a> {
    pub conn: &'a Connection,
    pub view: String,
    pub exceptions: String,
    pub dataset_id: String,
    pub row_count: u64,
    pub columns: Vec<Col>,
    pub crs: Option<String>,
    pub notes: &'a [Note],
    pub assumptions: &'a [Value],
    pub project_area: Option<[f64; 4]>,
}

struct Series<'c> {
    time: &'c Col,
    id: Option<&'c Col>,
}

impl Series<'_> {
    /// Milliseconds since the epoch, for dates and date-times alike.
    fn ms(&self) -> String {
        match self.time.kind {
            Kind::Date => format!("({}::BIGINT * 86400000)", self.time.q()),
            _ => self.time.q(),
        }
    }

    fn partition(&self) -> String {
        self.id
            .map_or(String::new(), |c| format!("PARTITION BY {}", c.q()))
    }

    fn group(&self) -> String {
        self.id.map_or("NULL".into(), |c| c.q())
    }

    fn columns(&self) -> Vec<&Col> {
        self.id
            .into_iter()
            .chain(std::iter::once(self.time))
            .collect()
    }

    fn detail(&self) -> String {
        self.id
            .map_or(String::new(), |c| format!("for the same {}", c.name))
    }
}

/// `x` as a SQL double literal that reads back as exactly `x`.
fn dbl(x: f64) -> String {
    format!("{x:?}::DOUBLE")
}

/// The first `max` distinct values in order, '(empty)' for '', and ', …' when more exist.
fn examples<'s>(values: impl IntoIterator<Item = &'s str>, max: usize) -> String {
    let mut seen = HashSet::new();
    let unique: Vec<&str> = values.into_iter().filter(|v| seen.insert(*v)).collect();
    let shown: Vec<&str> = unique
        .iter()
        .take(max)
        .map(|v| if v.is_empty() { "(empty)" } else { v })
        .collect();
    if unique.len() > max {
        format!("{}, …", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

/// True for laboratory below-detection-limit text (values.ts isBelowDetectionLimit).
pub fn is_below_detection_limit(text: &str) -> bool {
    let t = js_trim(text);
    if t.is_empty() {
        return false;
    }
    let lower = t.to_lowercase();
    if [
        "nd", "n.d.", "n/d", "bdl", "<lod", "<loq", "<mdl", "<dl", "<rl",
    ]
    .contains(&lower.as_str())
    {
        return true;
    }
    // ^<\s*\d+(?:[.,]\d+)?(?:\s*[^\d\s<>][^<>]{0,15})?$
    let c: Vec<char> = t.chars().collect();
    if c.first() != Some(&'<') {
        return false;
    }
    let mut i = 1;
    while i < c.len() && is_js_space(c[i]) {
        i += 1;
    }
    let digits = |mut i: usize| {
        let s = i;
        while i < c.len() && c[i].is_ascii_digit() {
            i += 1;
        }
        (i, i - s)
    };
    let (after_int, n) = digits(i);
    if n == 0 {
        return false;
    }
    // The optional unit: white space, one character that is not a digit, white space or < >, then
    // at most 15 characters that are not < >. Giving back integer digits or white space cannot
    // help, because the unit's first character can be neither.
    let unit_from = |mut i: usize| {
        if i == c.len() {
            return true;
        }
        while i < c.len() && is_js_space(c[i]) {
            i += 1;
        }
        if i >= c.len() || c[i].is_ascii_digit() || is_js_space(c[i]) || matches!(c[i], '<' | '>') {
            return false;
        }
        let rest = &c[i + 1..];
        rest.len() <= 15 && !rest.iter().any(|ch| matches!(ch, '<' | '>'))
    };
    // With the decimal part first, then without it, as the regular expression backtracks.
    if after_int < c.len() && matches!(c[after_int], '.' | ',') {
        let (after_frac, f) = digits(after_int + 1);
        if f > 0 && unit_from(after_frac) {
            return true;
        }
    }
    unit_from(after_int)
}

/// A sliding window of 2 × half + 1 values for the Hampel identifier, kept sorted as values come
/// and go, so the median is its middle value and the median absolute deviation is found by
/// merging the deviations on either side of it: the same numbers as sorting the window
/// (hampel.ts), without sorting for every row.
struct HampelWindow {
    half: usize,
    order: std::collections::VecDeque<(u64, f64)>,
    sorted: Vec<f64>,
}

impl HampelWindow {
    fn new(half: usize) -> HampelWindow {
        HampelWindow {
            half,
            order: std::collections::VecDeque::with_capacity(2 * half + 1),
            sorted: Vec::with_capacity(2 * half + 1),
        }
    }

    fn clear(&mut self) {
        self.order.clear();
        self.sorted.clear();
    }

    /// Adds a value; once the window is full, returns its centre row and value, the median and
    /// the median absolute deviation, then slides on.
    fn push(&mut self, rid: u64, v: f64) -> Option<(u64, f64, f64, f64)> {
        self.order.push_back((rid, v));
        let at = self.sorted.partition_point(|x| x.total_cmp(&v).is_lt());
        self.sorted.insert(at, v);
        let n = 2 * self.half + 1;
        if self.order.len() < n {
            return None;
        }
        let mid = self.half;
        let med = self.sorted[mid];
        // The deviations in ascending order are 0 (the median itself), then the smaller of the
        // next one below and the next one above the median; the median deviation is the
        // (half)-th of them, counting from 0.
        let (mut lo, mut hi) = (mid as isize - 1, mid + 1);
        let mut mad = 0.0;
        for _ in 0..self.half {
            let below = (lo >= 0).then(|| med - self.sorted[lo as usize]);
            let above = (hi < n).then(|| self.sorted[hi] - med);
            mad = match (below, above) {
                (Some(b), Some(a)) if b <= a => {
                    lo -= 1;
                    b
                }
                (_, Some(a)) => {
                    hi += 1;
                    a
                }
                (Some(b), None) => {
                    lo -= 1;
                    b
                }
                (None, None) => mad,
            };
        }
        let (centre_rid, centre) = self.order[mid];
        let (_, gone) = self.order.pop_front().unwrap_or((0, 0.0));
        let at = self.sorted.partition_point(|x| x.total_cmp(&gone).is_lt());
        self.sorted.remove(at);
        Some((centre_rid, centre, med, mad))
    }
}

/// A cell value for equality tests: group keys and flatline runs (keyOf and sameValue).
#[derive(Clone, Debug, PartialEq)]
enum Key {
    Null,
    Num(f64),
    Int(i64),
    Bool(bool),
    Text(String),
}

fn text_at(a: &duckdb::arrow::array::ArrayRef, i: usize) -> Option<&str> {
    use duckdb::arrow::datatypes::DataType;
    match a.data_type() {
        DataType::Utf8 => Some(a.as_string::<i32>().value(i)),
        DataType::LargeUtf8 => Some(a.as_string::<i64>().value(i)),
        DataType::Utf8View => Some(a.as_string_view().value(i)),
        _ => None,
    }
}

impl Key {
    fn at(a: &duckdb::arrow::array::ArrayRef, i: usize) -> Key {
        use duckdb::arrow::datatypes::{DataType, Float64Type, Int32Type};
        if a.is_null(i) {
            return Key::Null;
        }
        match a.data_type() {
            DataType::Float64 => Key::Num(a.as_primitive::<Float64Type>().value(i)),
            DataType::Int64 => Key::Int(a.as_primitive::<Int64Type>().value(i)),
            DataType::Int32 => Key::Int(a.as_primitive::<Int32Type>().value(i) as i64),
            DataType::Boolean => Key::Bool(a.as_boolean().value(i)),
            _ => text_at(a, i).map_or(Key::Null, |t| Key::Text(t.to_string())),
        }
    }

    /// Whether row `i` of `a` holds this value, without allocating.
    fn same(&self, a: &duckdb::arrow::array::ArrayRef, i: usize) -> bool {
        use duckdb::arrow::datatypes::{Float64Type, Int32Type};
        if a.is_null(i) {
            return *self == Key::Null;
        }
        match self {
            Key::Null => false,
            Key::Num(x) => a
                .as_primitive_opt::<Float64Type>()
                .is_some_and(|p| p.value(i) == *x),
            Key::Int(x) => {
                a.as_primitive_opt::<Int64Type>()
                    .is_some_and(|p| p.value(i) == *x)
                    || a.as_primitive_opt::<Int32Type>()
                        .is_some_and(|p| p.value(i) as i64 == *x)
            }
            Key::Bool(x) => a.as_boolean_opt().is_some_and(|b| b.value(i) == *x),
            Key::Text(t) => text_at(a, i) == Some(t.as_str()),
        }
    }
}

impl CheckCtx<'_> {
    fn rows(&self, sql: &str) -> Result<RowSet> {
        let mut set = RowSet::new(self.row_count);
        each_batch(self.conn, sql, |batch| {
            let ids = batch.column(0).as_primitive::<Int64Type>();
            for i in 0..ids.len() {
                if ids.is_valid(i) {
                    set.insert(ids.value(i) as u64);
                }
            }
            Ok(())
        })?;
        Ok(set)
    }

    /// Streams (row id, text) pairs of a two-column query.
    fn each_text(&self, sql: &str, mut f: impl FnMut(i64, &str)) -> Result<()> {
        each_batch(self.conn, sql, |batch| {
            let ids = batch.column(0).as_primitive::<Int64Type>();
            let texts = batch.column(1);
            for i in 0..batch.num_rows() {
                if let Some(t) = (!texts.is_null(i)).then(|| text_at(texts, i)).flatten() {
                    f(ids.value(i), t);
                }
            }
            Ok(())
        })
    }

    fn strings(&self, sql: &str) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(sql)?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push((r.get::<_, i64>(0)?, r.get::<_, String>(1)?));
        }
        Ok(out)
    }

    fn column(&self, id: &str) -> Option<&Col> {
        self.columns.iter().find(|c| c.id == id)
    }

    fn series(&self) -> Option<Series<'_>> {
        let time = self
            .columns
            .iter()
            .find(|c| c.role == "time" && matches!(c.typ.as_str(), "date" | "datetime"))?;
        Some(Series {
            time,
            id: self.columns.iter().find(|c| c.role == "id"),
        })
    }

    fn lat_lon(&self) -> Option<(&Col, &Col)> {
        let lat = self.columns.iter().find(|c| c.role == "latitude")?;
        let lon = self.columns.iter().find(|c| c.role == "longitude")?;
        Some((lat, lon))
    }

    fn spatial_columns(&self) -> Vec<String> {
        self.lat_lon().map_or(Vec::new(), |(lat, lon)| {
            vec![lat.id.clone(), lon.id.clone()]
        })
    }

    fn is_wgs84(&self) -> bool {
        self.crs.as_deref().is_some_and(|c| WGS84.contains(&c))
    }

    #[allow(clippy::too_many_arguments)]
    fn draft(
        &self,
        rule: &Rule,
        pack: &Pack,
        columns: &[&Col],
        scope: &'static str,
        rows: RowSet,
        vars: Vec<(&str, Var)>,
        detail: Option<Value>,
    ) -> Draft {
        let first = columns.first();
        let mut all = vec![
            (
                "column",
                Var::Text(first.map_or("the dataset".into(), |c| c.name.clone())),
            ),
            ("count", Var::Num(rows.count() as f64)),
            (
                "unit",
                Var::Text(first.and_then(|c| c.unit.clone()).unwrap_or_default()),
            ),
            ("detail", Var::Text(String::new())),
        ];
        all.extend(vars);
        Draft {
            rule_id: rule.id.clone(),
            rule_version: rule.version.clone(),
            pack_id: pack.id.clone(),
            severity: rule.severity.clone(),
            category: rule.category.clone(),
            dataset_id: self.dataset_id.clone(),
            columns: columns.iter().map(|c| c.id.clone()).collect(),
            scope,
            rows,
            message: render_message(&rule.message, &all),
            detail,
        }
    }

    fn column_scope(&self, rule: &Rule, pack: &Pack, c: &Col, detail: String) -> Draft {
        let rows = RowSet::new(self.row_count);
        self.draft(
            rule,
            pack,
            &[c],
            "column",
            rows,
            vec![("detail", Var::Text(detail))],
            None,
        )
    }

    /// Rows whose values repeat on `keys` (SQL expressions), among the rows `filter` keeps. Rows
    /// are first narrowed by a hash of the keys, then grouped on the keys themselves.
    fn repeated(&self, keys: &[String], from: &str, filter: &str) -> Result<RowSet> {
        let k = keys.join(", ");
        self.rows(&format!(
            "WITH src AS (SELECT __rid, {k} FROM {from} WHERE {filter}), \
             dup AS (SELECT hash({k}) AS h FROM src GROUP BY h HAVING count(*) > 1) \
             SELECT __rid FROM (SELECT __rid, count(*) OVER (PARTITION BY {k}) AS n \
               FROM src WHERE hash({k}) IN (SELECT h FROM dup)) WHERE n > 1"
        ))
    }

    // -----------------------------------------------------------------------------------------
    // Completeness, validity, uniqueness

    fn not_null(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Result<Vec<Draft>> {
        let mut out = Vec::new();
        for c in cols.iter().filter(|c| c.typ != "geometry") {
            let rows = self.rows(&format!(
                "SELECT __rid FROM {v} WHERE {c} IS NULL AND __rid NOT IN \
                 (SELECT rid FROM {e} WHERE col = {id} AND raw IS NOT NULL)",
                v = self.view,
                e = self.exceptions,
                c = c.q(),
                id = quote_text(&c.id)
            ))?;
            if rows.count() > 0 {
                out.push(self.draft(rule, pack, &[c], "rows", rows, vec![], None));
            }
        }
        Ok(out)
    }

    /// Streams the source text of every value of `c` that failed to parse, in row order.
    fn failed_texts(&self, c: &Col, f: impl FnMut(i64, &str)) -> Result<()> {
        self.each_text(
            &format!(
                "SELECT rid, raw FROM {e} WHERE col = {id} AND raw IS NOT NULL ORDER BY rid",
                e = self.exceptions,
                id = quote_text(&c.id)
            ),
            f,
        )
    }

    fn type_conformance(
        &self,
        rule: &Rule,
        pack: &Pack,
        cols: &[&Col],
        bdl: bool,
    ) -> Result<Vec<Draft>> {
        let mut out = Vec::new();
        for c in cols {
            let mut rows = RowSet::new(self.row_count);
            // The first distinct texts, enough to list three examples and say whether there are more.
            let mut texts: Vec<String> = Vec::new();
            self.failed_texts(c, |rid, text| {
                if is_below_detection_limit(text) == bdl {
                    rows.insert(rid as u64);
                    if texts.len() < 4 && !texts.iter().any(|t| t == text) {
                        texts.push(text.to_string());
                    }
                }
            })?;
            if rows.count() == 0 {
                continue;
            }
            let shown = examples(texts.iter().map(String::as_str), 3);
            out.push(if bdl {
                self.draft(
                    rule,
                    pack,
                    &[c],
                    "rows",
                    rows,
                    vec![("detail", Var::Text(shown))],
                    None,
                )
            } else {
                let detail = json!({ "examples": shown });
                self.draft(
                    rule,
                    pack,
                    &[c],
                    "rows",
                    rows,
                    vec![("detail", Var::Text(c.typ.clone()))],
                    Some(detail),
                )
            });
        }
        Ok(out)
    }

    fn null_marker(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Result<Vec<Draft>> {
        let mut out = Vec::new();
        for c in cols {
            let filter = format!(
                "col = {} AND marker IS NOT NULL AND marker <> ''",
                quote_text(&c.id)
            );
            let rows = self.rows(&format!(
                "SELECT rid FROM {} WHERE {filter}",
                self.exceptions
            ))?;
            if rows.count() == 0 {
                continue;
            }
            let markers = self.strings(&format!(
                "SELECT min(rid) AS first, marker FROM {} WHERE {filter} GROUP BY marker ORDER BY first LIMIT 4",
                self.exceptions
            ))?;
            let shown = examples(markers.iter().map(|(_, m)| m.as_str()), 3);
            out.push(self.draft(
                rule,
                pack,
                &[c],
                "rows",
                rows,
                vec![("detail", Var::Text(shown))],
                None,
            ));
        }
        Ok(out)
    }

    fn duplicate_rows(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let mut keys: Vec<String> = self
            .columns
            .iter()
            .map(|c| format!("v.{}", c.q()))
            .collect();
        keys.push("s.sig".into());
        let from = format!(
            "{v} v LEFT JOIN (SELECT rid, list({{'c': col, 't': coalesce(raw, marker)}} ORDER BY col) AS sig \
             FROM {e} GROUP BY rid) s ON s.rid = v.__rid",
            v = self.view,
            e = self.exceptions
        );
        let named: Vec<String> = keys
            .iter()
            .enumerate()
            .map(|(i, k)| format!("{k} AS k{i}"))
            .collect();
        let src = format!("(SELECT v.__rid, {} FROM {from})", named.join(", "));
        let key_names: Vec<String> = (0..keys.len()).map(|i| format!("k{i}")).collect();
        let rows = self.repeated(&key_names, &src, "true")?;
        if rows.count() == 0 {
            return Ok(vec![]);
        }
        Ok(vec![self.draft(
            rule,
            pack,
            &[],
            "rows",
            rows,
            vec![],
            None,
        )])
    }

    fn time_key_rows(&self, s: &Series) -> Result<RowSet> {
        let mut keys = vec![s.time.q()];
        if let Some(id) = s.id {
            keys.insert(0, id.q());
        }
        self.repeated(&keys, &self.view, &format!("{} IS NOT NULL", s.time.q()))
    }

    fn duplicate_key(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let Some(s) = self.series() else {
            return Ok(vec![]);
        };
        let Some(id) = s.id else {
            return Ok(vec![]);
        };
        let rows = self.time_key_rows(&s)?;
        if rows.count() == 0 {
            return Ok(vec![]);
        }
        let detail = format!("{} and {}", id.name, s.time.name);
        Ok(vec![self.draft(
            rule,
            pack,
            &[id, s.time],
            "rows",
            rows,
            vec![("detail", Var::Text(detail))],
            None,
        )])
    }

    // -----------------------------------------------------------------------------------------
    // Ranges and units

    fn physical_range(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Result<Vec<Draft>> {
        let mut out = Vec::new();
        for c in cols {
            let (Some(unit), Some(q)) = (&c.unit, &c.quantity) else {
                continue;
            };
            let Some(b) = physical_bounds(q, unit) else {
                continue;
            };
            if (b.min.is_none() && b.max.is_none()) || !c.numeric() {
                continue;
            }
            let mut tests = Vec::new();
            if let Some(min) = b.min {
                tests.push(format!("{} < {}", c.q(), dbl(min)));
            }
            if let Some(max) = b.max {
                tests.push(format!("{} > {}", c.q(), dbl(max)));
            }
            let rows = self.rows(&format!(
                "SELECT __rid FROM {} WHERE {}",
                self.view,
                tests.join(" OR ")
            ))?;
            if rows.count() == 0 {
                continue;
            }
            let limits: Vec<String> = [
                b.min
                    .map(|m| format!("minimum {}", crate::canonical::canonical_number(m))),
                b.max
                    .map(|m| format!("maximum {}", crate::canonical::canonical_number(m))),
            ]
            .into_iter()
            .flatten()
            .collect();
            let mut vars = vec![
                ("unit", Var::Text(unit.clone())),
                ("detail", Var::Text(limits.join(", "))),
            ];
            if let Some(min) = b.min {
                vars.push(("min", Var::Num(min)));
            }
            if let Some(max) = b.max {
                vars.push(("max", Var::Num(max)));
            }
            out.push(self.draft(
                rule,
                pack,
                &[c],
                "rows",
                rows,
                vars,
                Some(json!({ "source": b.source })),
            ));
        }
        Ok(out)
    }

    fn unit_known(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Vec<Draft> {
        cols.iter()
            .filter(|c| c.unit.is_none())
            .map(|c| self.column_scope(rule, pack, c, String::new()))
            .collect()
    }

    fn unit_consistent(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Result<Vec<Draft>> {
        let mut out = Vec::new();
        for c in cols.iter().filter(|c| c.kind == Kind::String) {
            let present: i64 = self.conn.query_row(
                &format!(
                    "SELECT count(*) FROM {v} WHERE regexp_matches({c}, '[^{JS_SPACE_CLASS}]')",
                    v = self.view,
                    c = c.q()
                ),
                [],
                |r| r.get(0),
            )?;
            // Only text that starts with a number can be a value with a unit (splitValueUnit).
            let candidates = format!(
                "SELECT __rid, {c} FROM {v} WHERE regexp_matches({c}, '^[{JS_SPACE_CLASS}]*[-+\\x{{2212}}]?[.,]?[0-9]')",
                v = self.view,
                c = c.q()
            );
            // Two passes, so memory stays with the number of distinct units: count each unit
            // (with the first row it appears on), then flag the rows not in the main one.
            let mut counts: HashMap<String, (usize, i64)> = HashMap::new();
            self.each_text(&candidates, |rid, text| {
                if let Some((_, u)) = split_value_unit(text) {
                    let e = counts.entry(u.code.clone()).or_insert((0, rid));
                    e.0 += 1;
                    e.1 = e.1.min(rid);
                }
            })?;
            let units: usize = counts.values().map(|(n, _)| n).sum();
            if units < 2 || (units as i64) * 2 < present {
                continue;
            }
            // Units in the order they first appear; the main one is the most common, the
            // earliest on a tie.
            let mut order: Vec<(String, usize, i64)> = counts
                .into_iter()
                .map(|(code, (n, first))| (code, n, first))
                .collect();
            order.sort_by_key(|(_, _, first)| *first);
            let mut main = 0;
            for (i, (_, n, _)) in order.iter().enumerate() {
                if *n > order[main].1 {
                    main = i;
                }
            }
            let main = order[main].0.clone();
            let mut rows = RowSet::new(self.row_count);
            self.each_text(&candidates, |rid, text| {
                if let Some((_, u)) = split_value_unit(text)
                    && u.code != main
                {
                    rows.insert(rid as u64);
                }
            })?;
            if rows.count() == 0 {
                continue;
            }
            let others: Vec<&str> = order
                .iter()
                .map(|(c, _, _)| c.as_str())
                .filter(|c| *c != main)
                .collect();
            let detail = format!("mostly {main}; also {}", others.join(", "));
            out.push(self.draft(
                rule,
                pack,
                &[c],
                "rows",
                rows,
                vec![("detail", Var::Text(detail))],
                None,
            ));
        }
        Ok(out)
    }

    // -----------------------------------------------------------------------------------------
    // Time

    fn series_draft(&self, rule: &Rule, pack: &Pack, s: &Series, rows: RowSet) -> Vec<Draft> {
        if rows.count() == 0 {
            return vec![];
        }
        vec![self.draft(
            rule,
            pack,
            &s.columns(),
            "rows",
            rows,
            vec![("detail", Var::Text(s.detail()))],
            None,
        )]
    }

    fn ts_duplicate(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let Some(s) = self.series() else {
            return Ok(vec![]);
        };
        let rows = self.time_key_rows(&s)?;
        Ok(self.series_draft(rule, pack, &s, rows))
    }

    fn ts_order(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let Some(s) = self.series() else {
            return Ok(vec![]);
        };
        let rows = self.rows(&format!(
            "SELECT __rid FROM (SELECT __rid, {t} AS t, lag({t}) OVER ({p} ORDER BY __rid) AS prev \
             FROM {v} WHERE {time} IS NOT NULL) WHERE t < prev",
            t = s.ms(),
            p = s.partition(),
            v = self.view,
            time = s.time.q()
        ))?;
        Ok(self.series_draft(rule, pack, &s, rows))
    }

    fn ts_gap(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let Some(s) = self.series() else {
            return Ok(vec![]);
        };
        let factor = rule.check["factor"].as_f64().unwrap_or(3.0);
        let rows = self.rows(&format!(
            "WITH s AS (SELECT __rid, {g} AS g, {t} - lag({t}) OVER ({p} ORDER BY {t}, __rid) AS d \
               FROM {v} WHERE {time} IS NOT NULL), \
             m AS (SELECT g, median(d::DOUBLE) AS m FROM s WHERE d > 0 GROUP BY g) \
             SELECT s.__rid FROM s JOIN m ON s.g IS NOT DISTINCT FROM m.g WHERE s.d > 0 AND s.d > {f} * m.m",
            g = s.group(),
            t = s.ms(),
            p = s.partition(),
            v = self.view,
            time = s.time.q(),
            f = dbl(factor)
        ))?;
        Ok(self.series_draft(rule, pack, &s, rows))
    }

    fn tz_specified(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Vec<Draft> {
        cols.iter()
            .filter(|c| c.typ == "datetime")
            .filter_map(|c| match &c.timezone {
                Some((value, true)) => Some(self.column_scope(rule, pack, c, value.clone())),
                _ => None,
            })
            .collect()
    }

    fn date_ambiguous(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Vec<Draft> {
        cols.iter()
            .filter_map(|c| match &c.date_format {
                Some((f, true)) if f == "dmy" || f == "mdy" => {
                    let detail = if f == "dmy" { "day/month" } else { "month/day" };
                    Some(self.column_scope(rule, pack, c, detail.into()))
                }
                _ => None,
            })
            .collect()
    }

    /// Streams the series in order (by id, then time, then file order) with the values of `cols`,
    /// calling `row` for each row with whether it starts a new id group.
    fn scan_series(
        &self,
        s: &Series,
        cols: &[&Col],
        mut row: impl FnMut(bool, u64, &[duckdb::arrow::array::ArrayRef], usize),
    ) -> Result<()> {
        let values: Vec<String> = cols.iter().map(|c| c.q()).collect();
        let sql = format!(
            "SELECT __rid, {g} AS g{sep}{values} FROM {v} WHERE {time} IS NOT NULL ORDER BY g, {t}, __rid",
            g = s.group(),
            sep = if values.is_empty() { "" } else { ", " },
            values = values.join(", "),
            v = self.view,
            time = s.time.q(),
            t = s.ms()
        );
        let mut previous: Option<Key> = None;
        each_batch(self.conn, &sql, |batch| {
            let rids = batch.column(0).as_primitive::<Int64Type>().clone();
            let group = batch.column(1).clone();
            let cols: Vec<duckdb::arrow::array::ArrayRef> = batch.columns()[2..].to_vec();
            for i in 0..batch.num_rows() {
                let starts = match &previous {
                    Some(p) => !p.same(&group, i),
                    None => true,
                };
                if starts {
                    previous = Some(Key::at(&group, i));
                }
                row(starts, rids.value(i) as u64, &cols, i);
            }
            Ok(())
        })
    }

    fn flatline(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Result<Vec<Draft>> {
        let Some(s) = self.series() else {
            return Ok(vec![]);
        };
        let min_run = rule.check["minRun"].as_u64().unwrap_or(6) as usize;
        // Per column: the rows flagged, the current run's value and its first rows (until the run
        // is long enough, after which each further row is flagged at once).
        struct Run {
            rows: RowSet,
            value: Option<Key>,
            pending: Vec<u64>,
            len: usize,
        }
        let mut runs: Vec<Run> = cols
            .iter()
            .map(|_| Run {
                rows: RowSet::new(self.row_count),
                value: None,
                pending: Vec::new(),
                len: 0,
            })
            .collect();
        self.scan_series(&s, cols, |starts, rid, arrays, i| {
            for (run, a) in runs.iter_mut().zip(arrays) {
                // A missing value ends a run and is never part of one (sameValue).
                let continues = !starts && run.value.as_ref().is_some_and(|v| v.same(a, i));
                if continues {
                    run.len += 1;
                } else {
                    run.value = (!a.is_null(i)).then(|| Key::at(a, i));
                    run.len = 1;
                    run.pending.clear();
                }
                if run.value.is_none() {
                    continue;
                }
                if run.len < min_run {
                    run.pending.push(rid);
                } else {
                    for r in run.pending.drain(..) {
                        run.rows.insert(r);
                    }
                    run.rows.insert(rid);
                }
            }
        })?;
        Ok(cols
            .iter()
            .zip(runs)
            .filter(|(_, r)| r.rows.count() > 0)
            .map(|(c, r)| self.draft(rule, pack, &[c], "rows", r.rows, vec![], None))
            .collect())
    }

    fn spike(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Result<Vec<Draft>> {
        let Some(s) = self.series() else {
            return Ok(vec![]);
        };
        let half = (rule.check["window"].as_u64().unwrap_or(7) / 2) as usize;
        let k = rule.check["k"].as_f64().unwrap_or(3.0);
        let numeric: Vec<&Col> = cols.iter().copied().filter(|c| c.numeric()).collect();
        // The Hampel identifier (hampel.ts): over each group's present values, every value with a
        // full window of `half` values on each side is tested against the window's median and MAD.
        let mut windows: Vec<(RowSet, HampelWindow)> = numeric
            .iter()
            .map(|_| (RowSet::new(self.row_count), HampelWindow::new(half)))
            .collect();
        self.scan_series(&s, &numeric, |starts, rid, arrays, i| {
            for ((rows, win), a) in windows.iter_mut().zip(arrays) {
                if starts {
                    win.clear();
                }
                let x = a.as_primitive::<duckdb::arrow::datatypes::Float64Type>();
                if x.is_null(i) || !x.value(i).is_finite() {
                    continue;
                }
                if let Some((centre_rid, centre, med, mad)) = win.push(rid, x.value(i)) {
                    if mad > 0.0 && (centre - med).abs() > k * MAD_SCALE * mad {
                        rows.insert(centre_rid);
                    }
                }
            }
        })?;
        Ok(numeric
            .iter()
            .zip(windows)
            .filter(|(_, (rows, _))| rows.count() > 0)
            .map(|(c, (rows, _))| self.draft(rule, pack, &[c], "rows", rows, vec![], None))
            .collect())
    }

    // -----------------------------------------------------------------------------------------
    // Spatial (latitude and longitude columns; the native engine imports no geometry columns yet)

    fn lat_lon_exprs(&self) -> Option<(String, String)> {
        let (lat, lon) = self.lat_lon()?;
        let num = |c: &Col| {
            if c.numeric() {
                c.q()
            } else {
                "NULL::DOUBLE".into()
            }
        };
        Some((num(lat), num(lon)))
    }

    fn contains_sql(area: &[f64; 4], lon: &str, lat: &str) -> String {
        let [west, south, east, north] = *area;
        let lon_in = if west <= east {
            format!("{lon} >= {} AND {lon} <= {}", dbl(west), dbl(east))
        } else {
            format!(
                "(({lon} >= {} AND {lon} <= 180) OR ({lon} >= -180 AND {lon} <= {}))",
                dbl(west),
                dbl(east)
            )
        };
        format!(
            "({lat} >= {} AND {lat} <= {} AND {lon_in})",
            dbl(south),
            dbl(north)
        )
    }

    fn spatial_draft(&self, rule: &Rule, pack: &Pack, rows: RowSet) -> Vec<Draft> {
        if rows.count() == 0 {
            return vec![];
        }
        let cols: Vec<&Col> = self
            .spatial_columns()
            .iter()
            .filter_map(|id| self.column(id))
            .collect();
        vec![self.draft(rule, pack, &cols, "rows", rows, vec![], None)]
    }

    fn coord_range(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let Some((lat, lon)) = self.lat_lon_exprs().filter(|_| self.is_wgs84()) else {
            return Ok(vec![]);
        };
        let rows = self.rows(&format!(
            "SELECT __rid FROM {v} WHERE abs({lat}) > 90 OR abs({lon}) > 180",
            v = self.view
        ))?;
        Ok(self.spatial_draft(rule, pack, rows))
    }

    fn latlon_swapped(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let Some((lat, lon)) = self.lat_lon_exprs().filter(|_| self.is_wgs84()) else {
            return Ok(vec![]);
        };
        let outside_but_swapped_inside = match &self.project_area {
            Some(a) => format!(
                "(NOT {} AND {})",
                Self::contains_sql(a, &lon, &lat),
                Self::contains_sql(a, &lat, &lon)
            ),
            None => "false".into(),
        };
        let rows = self.rows(&format!(
            "SELECT __rid FROM {v} WHERE {lat} IS NOT NULL AND {lon} IS NOT NULL AND \
             ((abs({lat}) > 90 AND abs({lon}) <= 90 AND abs({lat}) <= 180) OR (abs({lat}) <= 90 AND {outside_but_swapped_inside}))",
            v = self.view
        ))?;
        Ok(self.spatial_draft(rule, pack, rows))
    }

    fn within_area(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let (Some(area), true) = (&self.project_area, self.is_wgs84()) else {
            return Ok(vec![]);
        };
        let Some((lat, lon)) = self.lat_lon_exprs() else {
            return Ok(vec![]);
        };
        let rows = self.rows(&format!(
            "SELECT __rid FROM {v} WHERE {lat} IS NOT NULL AND {lon} IS NOT NULL AND NOT {inside}",
            v = self.view,
            inside = Self::contains_sql(area, &lon, &lat)
        ))?;
        Ok(self.spatial_draft(rule, pack, rows))
    }

    fn crs_wgs84(&self, rule: &Rule, pack: &Pack) -> Vec<Draft> {
        let Some(code) = &self.crs else {
            return vec![];
        };
        if WGS84.contains(&code.as_str()) {
            return vec![];
        }
        let label = if code == "unknown" {
            "an undeclared coordinate system".to_string()
        } else {
            code.clone()
        };
        let cols: Vec<&Col> = self
            .spatial_columns()
            .iter()
            .filter_map(|id| self.column(id))
            .collect();
        let rows = RowSet::new(self.row_count);
        vec![self.draft(
            rule,
            pack,
            &cols,
            "dataset",
            rows,
            vec![("detail", Var::Text(label))],
            Some(json!({ "crs": code })),
        )]
    }

    // -----------------------------------------------------------------------------------------
    // Import notes

    fn import_note(&self, rule: &Rule, pack: &Pack) -> Result<Vec<Draft>> {
        let code = rule.check["code"].as_str().unwrap_or("");
        let empty = RowSet::new(self.row_count);
        if code == "TW-IMP-005" {
            if self.assumptions.is_empty() {
                return Ok(vec![]);
            }
            let list: Vec<String> = self
                .assumptions
                .iter()
                .map(|a| {
                    format!(
                        "{}.{}",
                        a["columnId"].as_str().unwrap_or("dataset"),
                        a["property"].as_str().unwrap_or("")
                    )
                })
                .collect();
            return Ok(vec![self.draft(
                rule,
                pack,
                &[],
                "dataset",
                empty,
                vec![("count", Var::Num(self.assumptions.len() as f64))],
                Some(json!({ "assumptions": list })),
            )]);
        }
        let notes: Vec<&Note> = self.notes.iter().filter(|n| n.code == code).collect();
        if notes.is_empty() {
            return Ok(vec![]);
        }
        if code == "TW-IMP-001" {
            let locs: Vec<String> = notes
                .iter()
                .filter_map(|n| n.src_loc.map(|l| l.to_string()))
                .collect();
            let rows = if locs.is_empty() {
                empty
            } else {
                self.rows(&format!(
                    "SELECT __rid FROM {} WHERE __loc IN ({})",
                    self.view,
                    locs.join(", ")
                ))?
            };
            return Ok(vec![self.draft(
                rule,
                pack,
                &[],
                "rows",
                rows,
                vec![],
                None,
            )]);
        }
        let detail = notes
            .iter()
            .map(|n| n.message.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        Ok(vec![self.draft(
            rule,
            pack,
            &[],
            "dataset",
            empty,
            vec![("detail", Var::Text(detail))],
            Some(json!({ "notes": notes.len() })),
        )])
    }

    // -----------------------------------------------------------------------------------------

    /// Columns a rule applies to (select.ts); a dataset rule applies to none.
    fn select(&self, applies_to: &Value) -> Vec<&Col> {
        if applies_to.get("dataset").is_some() {
            return vec![];
        }
        let list = |k: &str| -> Option<Vec<&str>> {
            applies_to[k]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
        };
        let (roles, types, quantities) = (list("roles"), list("types"), list("quantities"));
        let all = applies_to["all"].as_bool() == Some(true);
        self.columns
            .iter()
            .filter(|c| {
                if roles
                    .as_ref()
                    .is_some_and(|r| !r.contains(&c.role.as_str()))
                {
                    return false;
                }
                if types.as_ref().is_some_and(|t| !t.contains(&c.typ.as_str())) {
                    return false;
                }
                if let Some(q) = &quantities {
                    if c.quantity.as_deref().is_none_or(|cq| !q.contains(&cq)) {
                        return false;
                    }
                }
                all || roles.is_some() || types.is_some() || quantities.is_some()
            })
            .collect()
    }

    fn run_rule(&self, rule: &Rule, pack: &Pack, cols: &[&Col]) -> Result<Vec<Draft>> {
        Ok(match rule.kind() {
            "not_null" => self.not_null(rule, pack, cols)?,
            "duplicate_rows" => self.duplicate_rows(rule, pack)?,
            "duplicate_key" => self.duplicate_key(rule, pack)?,
            "type_conformance" => self.type_conformance(rule, pack, cols, false)?,
            "below_detection_limit" => self.type_conformance(rule, pack, cols, true)?,
            "physical_range" => self.physical_range(rule, pack, cols)?,
            "null_marker" => self.null_marker(rule, pack, cols)?,
            "unit_known" => self.unit_known(rule, pack, cols),
            "unit_consistent" => self.unit_consistent(rule, pack, cols)?,
            "ts_duplicate" => self.ts_duplicate(rule, pack)?,
            "ts_order" => self.ts_order(rule, pack)?,
            "ts_gap" => self.ts_gap(rule, pack)?,
            "tz_specified" => self.tz_specified(rule, pack, cols),
            "date_ambiguous" => self.date_ambiguous(rule, pack, cols),
            "flatline" => self.flatline(rule, pack, cols)?,
            "spike" => self.spike(rule, pack, cols)?,
            "coord_range" => self.coord_range(rule, pack)?,
            "latlon_swapped" => self.latlon_swapped(rule, pack)?,
            "within_area" => self.within_area(rule, pack)?,
            "crs_wgs84" => self.crs_wgs84(rule, pack),
            "import_note" => self.import_note(rule, pack)?,
            // Geometry columns are not imported by the native engine yet, so no column has them.
            "geometry_valid" | "geometry_present" | "system" => vec![],
            other => {
                return Err(EngineError::unsupported(format!("the check {other}")));
            }
        })
    }

    /// Runs every rule of the check packs (run.ts runRules), reporting progress per rule.
    pub fn run(
        &self,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(usize, usize),
    ) -> Result<Vec<Draft>> {
        let rules: Vec<(&Pack, &Rule)> = check_packs()
            .iter()
            .flat_map(|p| {
                p.rules
                    .iter()
                    .filter(|r| r.kind() != "system")
                    .map(move |r| (p, r))
            })
            .collect();
        let mut out = Vec::new();
        let cancelled = || {
            EngineError::new(
                "CANCELLED",
                "The check run was cancelled.",
                "Run the checks again when you are ready.",
            )
        };
        for (done, (pack, rule)) in rules.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let dataset_rule = rule.applies_to.get("dataset").is_some();
            let cols = self.select(&rule.applies_to);
            if dataset_rule || !cols.is_empty() {
                out.extend(self.run_rule(rule, pack, &cols)?);
            }
            progress(done + 1, rules.len());
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        Ok(out)
    }
}

/// Counts of drafts per severity and per rule, for the CheckSummary.
pub fn summarize(drafts: &[Draft]) -> (Value, Value) {
    let mut by_severity: HashMap<&str, u64> = [("error", 0), ("warning", 0), ("note", 0)].into();
    let mut by_rule = serde_json::Map::new();
    for d in drafts {
        *by_severity.entry(d.severity.as_str()).or_default() += 1;
        let n = by_rule.get(&d.rule_id).and_then(Value::as_u64).unwrap_or(0);
        by_rule.insert(d.rule_id.clone(), json!(n + 1));
    }
    (
        json!({ "error": by_severity["error"], "warning": by_severity["warning"], "note": by_severity["note"] }),
        Value::Object(by_rule),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_below_detection_limit_text() {
        for t in [
            "<0.5", "< 0,5", "<1 ppm", "ND", "n.d.", "BDL", "<LOD", " <2mg/L ", "<1.5 2",
        ] {
            assert!(is_below_detection_limit(t), "{t}");
        }
        for t in [
            "",
            "0.5",
            "<",
            "<a",
            "<1 <2",
            "<1 2",
            "<1 ppm and a very long unit text",
        ] {
            assert!(!is_below_detection_limit(t), "{t}");
        }
    }

    fn sorted_median(values: &mut [f64]) -> f64 {
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    }

    #[test]
    fn the_sliding_window_gives_the_same_median_and_deviation_as_sorting() {
        let mut seed = 7u32;
        let mut next = || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            // Few distinct values, so ties and equal deviations are common.
            ((seed >> 16) % 9) as f64 * 0.5 - 1.0
        };
        let values: Vec<f64> = (0..400).map(|_| next()).collect();
        for half in 1..=4 {
            let mut w = HampelWindow::new(half);
            for (i, v) in values.iter().enumerate() {
                let Some((rid, centre, med, mad)) = w.push(i as u64, *v) else {
                    continue;
                };
                let n = 2 * half + 1;
                let mut win: Vec<f64> = values[i + 1 - n..=i].to_vec();
                let expect_med = sorted_median(&mut win);
                let mut dev: Vec<f64> = win.iter().map(|x| (x - expect_med).abs()).collect();
                assert_eq!((rid, centre), ((i - half) as u64, values[i - half]));
                assert_eq!(med, expect_med);
                assert_eq!(mad, sorted_median(&mut dev), "half {half} at {i}");
            }
        }
    }

    #[test]
    fn lists_examples_as_the_typescript_check() {
        assert_eq!(examples(["a", "b", "a"], 3), "a, b");
        assert_eq!(examples(["", "b", "c", "d"], 3), "(empty), b, c, …");
    }
}
