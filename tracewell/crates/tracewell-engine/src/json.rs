//! JSON import (src/formats/json): an array of objects, one object per line (JSON Lines), or an
//! object whose member holds an array of objects. Each object is a row and its keys, in
//! first-seen order over the file, are the columns; nested objects and arrays are kept as JSON text.
//!
//! Objects keep their keys in the order JavaScript gives them (JSON.parse, then Object.entries):
//! keys that are array indices first, in ascending order, then the others in the order written,
//! a repeated key keeping its first place and its last value. serde_json sorts keys, so the values
//! here are parsed by this module. Records are found by scanning the text a chunk at a time, so
//! memory stays bounded by the largest single record, however large the file.

use crate::csv::format_count;
use crate::error::{EngineError, Result};
use crate::parse::Raw;
use serde_json::{Value, json};

/// A JSON value as JavaScript holds it.
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    /// Members in JavaScript's property order.
    Obj(Vec<(String, J)>),
}

// ---------------------------------------------------------------------------------------------
// Errors (errors.ts)

const BROKEN_JSON_FIX: &str = "Open the file in a text editor, correct the JSON (or export it again from the system that wrote it), then import the new copy.";
const NOT_RECORDS_FIX: &str = "Import an array of objects, one object per line (JSON Lines), or an object whose member holds an array of objects. Each object becomes a row and each of its keys a column.";

pub fn broken_json(message: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The JSON file is not valid JSON: {message}"),
        BROKEN_JSON_FIX,
    )
}

pub fn not_records(message: impl Into<String>) -> EngineError {
    EngineError::new("FORMAT_UNSUPPORTED", message, NOT_RECORDS_FIX)
}

fn kind_of(v: &J) -> &'static str {
    match v {
        J::Null => "null",
        J::Arr(_) => "an array",
        J::Obj(_) => "an object",
        J::Bool(_) => "a boolean",
        J::Num(_) => "a number",
        J::Str(_) => "a string",
    }
}

fn not_an_object(place: &str, v: &J) -> EngineError {
    not_records(format!(
        "{place} is {}, not an object, so it cannot be read as a row.",
        kind_of(v)
    ))
}

// ---------------------------------------------------------------------------------------------
// Values

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// A key that is an array index (a canonical integer below 2^32 - 1), which JavaScript lists first.
fn array_index(key: &str) -> Option<u32> {
    let b = key.as_bytes();
    if b.is_empty() || (b.len() > 1 && b[0] == b'0') || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|n| *n < u32::MAX as u64)
        .map(|n| n as u32)
}

/// Members as a JavaScript object holds them: indices first, in order; a repeated key keeps its
/// first place and takes its last value.
fn js_object(members: Vec<(String, J)>) -> Vec<(String, J)> {
    let mut out: Vec<(String, J)> = Vec::with_capacity(members.len());
    for (k, v) in members {
        match out.iter_mut().find(|(x, _)| *x == k) {
            Some(slot) => slot.1 = v,
            None => out.push((k, v)),
        }
    }
    let (mut indices, rest): (Vec<_>, Vec<_>) =
        out.into_iter().partition(|(k, _)| array_index(k).is_some());
    indices.sort_by_key(|(k, _)| array_index(k));
    indices.extend(rest);
    indices
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn err(&self, what: &str) -> String {
        match self.s.get(self.i) {
            None => {
                let _ = what;
                "Unexpected end of JSON input".to_string()
            }
            Some(c) => format!(
                "Unexpected character {} at position {} ({what})",
                serde_json::to_string(&(*c as char).to_string()).unwrap_or_default(),
                self.i
            ),
        }
    }

    fn ws(&mut self) {
        while self.i < self.s.len() && is_ws(self.s[self.i]) {
            self.i += 1;
        }
    }

    fn value(&mut self, depth: usize) -> std::result::Result<J, String> {
        if depth > 1000 {
            return Err("JSON nested too deeply".into());
        }
        self.ws();
        match self.s.get(self.i) {
            Some(b'{') => {
                self.i += 1;
                let mut members = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(J::Obj(members));
                }
                loop {
                    self.ws();
                    if self.s.get(self.i) != Some(&b'"') {
                        return Err(self.err("a key"));
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.s.get(self.i) != Some(&b':') {
                        return Err(self.err("':'"));
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    members.push((k, v));
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(J::Obj(js_object(members)));
                        }
                        _ => return Err(self.err("',' or '}'")),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(J::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(J::Arr(items));
                        }
                        _ => return Err(self.err("',' or ']'")),
                    }
                }
            }
            Some(b'"') => Ok(J::Str(self.string()?)),
            Some(b't') if self.s[self.i..].starts_with(b"true") => {
                self.i += 4;
                Ok(J::Bool(true))
            }
            Some(b'f') if self.s[self.i..].starts_with(b"false") => {
                self.i += 5;
                Ok(J::Bool(false))
            }
            Some(b'n') if self.s[self.i..].starts_with(b"null") => {
                self.i += 4;
                Ok(J::Null)
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.err("a value")),
        }
    }

    fn number(&mut self) -> std::result::Result<J, String> {
        let start = self.i;
        let digits = |p: &mut Self| {
            let from = p.i;
            while p.i < p.s.len() && p.s[p.i].is_ascii_digit() {
                p.i += 1;
            }
            p.i - from
        };
        if self.s.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return Err(self.err("a digit")),
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            if digits(self) == 0 {
                return Err(self.err("a digit"));
            }
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return Err(self.err("a digit"));
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?;
        text.parse::<f64>().map(J::Num).map_err(|e| e.to_string())
    }

    fn string(&mut self) -> std::result::Result<String, String> {
        // self.s[self.i] is the opening quote.
        self.i += 1;
        let mut out = String::new();
        let mut run = self.i;
        loop {
            let Some(&c) = self.s.get(self.i) else {
                return Err(self.err("the end of a string"));
            };
            match c {
                b'"' => {
                    out.push_str(
                        std::str::from_utf8(&self.s[run..self.i]).map_err(|e| e.to_string())?,
                    );
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    out.push_str(
                        std::str::from_utf8(&self.s[run..self.i]).map_err(|e| e.to_string())?,
                    );
                    self.i += 1;
                    let e = *self.s.get(self.i).ok_or_else(|| self.err("an escape"))?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&unit)
                                && self.s.get(self.i) == Some(&b'\\')
                                && self.s.get(self.i + 1) == Some(&b'u')
                            {
                                let save = self.i;
                                self.i += 2;
                                let low = self.hex4()?;
                                if (0xDC00..0xE000).contains(&low) {
                                    0x10000 + ((unit as u32 - 0xD800) << 10) + (low as u32 - 0xDC00)
                                } else {
                                    self.i = save;
                                    unit as u32
                                }
                            } else {
                                unit as u32
                            };
                            // A lone surrogate has no UTF-8 form; it reads as the replacement character.
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        _ => {
                            self.i -= 1;
                            return Err(self.err("an escape"));
                        }
                    }
                    run = self.i;
                }
                0..=0x1f => return Err(self.err("a string character")),
                _ => self.i += 1,
            }
        }
    }

    fn hex4(&mut self) -> std::result::Result<u16, String> {
        let h = self
            .s
            .get(self.i..self.i + 4)
            .ok_or_else(|| self.err("four hex digits"))?;
        let text = std::str::from_utf8(h).map_err(|e| e.to_string())?;
        let v = u16::from_str_radix(text, 16).map_err(|_| self.err("four hex digits"))?;
        self.i += 4;
        Ok(v)
    }
}

/// Parses a whole JSON text as JSON.parse does, or says why it is not JSON.
pub fn parse(text: &str) -> std::result::Result<J, String> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("the end of the text"));
    }
    Ok(v)
}

/// A value as JSON.stringify writes it.
pub fn stringify(v: &J) -> String {
    let mut out = String::new();
    write_json(v, &mut out);
    out
}

fn write_json(v: &J, out: &mut String) {
    match v {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Num(n) if n.is_finite() => out.push_str(&crate::canonical::canonical_number(*n)),
        J::Num(_) => out.push_str("null"),
        J::Str(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        J::Arr(items) => {
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, out);
            }
            out.push(']');
        }
        J::Obj(members) => {
            out.push('{');
            for (i, (k, x)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_json(x, out);
            }
            out.push('}');
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Columns (columns.ts)

/// The union of keys in first-seen order, and which ever held an object or an array.
#[derive(Default)]
pub struct RecordColumns {
    pub keys: Vec<String>,
    nested: Vec<bool>,
}

impl RecordColumns {
    fn column_of(&mut self, key: &str) -> usize {
        match self.keys.iter().position(|k| k == key) {
            Some(i) => i,
            None => {
                self.keys.push(key.to_string());
                self.nested.push(false);
                self.keys.len() - 1
            }
        }
    }

    /// Keys that held an object or an array in at least one record, in first-seen order.
    pub fn nested_keys(&self) -> Vec<String> {
        self.keys
            .iter()
            .zip(&self.nested)
            .filter(|(_, n)| **n)
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// A record as a row: one field per key seen so far, null where the record lacks the key.
    pub fn row_of(&mut self, record: &[(String, J)]) -> Vec<Raw> {
        let mut fields: Vec<Raw> = Vec::new();
        for (key, value) in record {
            let i = self.column_of(key);
            if fields.len() <= i {
                fields.resize(i + 1, Raw::Null);
            }
            fields[i] = match value {
                J::Str(s) => Raw::Text(s.clone()),
                J::Bool(b) => Raw::Bool(*b),
                J::Num(n) if n.is_finite() => Raw::Number(*n),
                // JSON numbers beyond the double range parse as infinities; their text keeps them visible.
                J::Num(n) => Raw::Text(if *n > 0.0 { "Infinity" } else { "-Infinity" }.into()),
                J::Null => Raw::Null,
                nested => {
                    self.nested[i] = true;
                    Raw::Text(stringify(nested))
                }
            };
        }
        fields.resize(self.keys.len(), Raw::Null);
        fields
    }
}

// ---------------------------------------------------------------------------------------------
// Layout (importer.ts detectLayout)

#[derive(Clone, Debug, PartialEq)]
pub enum Layout {
    Array,
    Member(String),
    Lines,
}

impl Layout {
    pub fn name(&self) -> &'static str {
        match self {
            Layout::Array => "array",
            Layout::Member(_) => "member",
            Layout::Lines => "lines",
        }
    }

    pub fn member(&self) -> &str {
        match self {
            Layout::Member(m) => m,
            _ => "",
        }
    }

    /// The layout an import's options name.
    pub fn of_options(json: &Value) -> Layout {
        match json["layout"].as_str() {
            Some("lines") => Layout::Lines,
            Some("member") => Layout::Member(json["member"].as_str().unwrap_or("").to_string()),
            _ => Layout::Array,
        }
    }
}

pub struct Detected {
    pub layout: Layout,
    pub confidence: &'static str,
    pub evidence: String,
}

/// The first member of the top-level object whose value is an array holding an object
/// (recordsMember), or None; text cut off at the end is read as far as it goes.
fn records_member(body: &str, complete: bool) -> Result<Option<String>> {
    let mut found: Option<String> = None;
    let mut scan = TreeScan::new(None);
    scan.on_member_element = Some(Box::new(move |key: &str, element: &J| {
        if matches!(element, J::Obj(_)) && found.is_none() {
            found = Some(key.to_string());
            return Some(key.to_string());
        }
        None
    }));
    scan.find(body.as_bytes(), complete)
}

/// Decides how records are laid out from the head of the file, decoded and without its BOM.
pub fn detect_layout(text: &str, complete: bool) -> Result<Detected> {
    let body = text.trim_start_matches(crate::units::is_js_space);
    let first = body.chars().next();
    if first == Some('[') {
        return Ok(Detected {
            layout: Layout::Array,
            confidence: "high",
            evidence: "The file starts with \"[\": an array whose objects are the rows.".into(),
        });
    }
    if first != Some('{') {
        return Err(not_records(if first.is_none() {
            "The file is empty: it holds no JSON."
        } else {
            "The file does not start with a JSON array or object, so it holds no records."
        }));
    }
    let mut lines = body.split('\n');
    let first_line = lines
        .next()
        .map(|l| l.trim_matches(crate::units::is_js_space))
        .is_some_and(|l| matches!(parse(l), Ok(J::Obj(_))));
    let next = lines.find(|l| !l.trim_matches(crate::units::is_js_space).is_empty());
    if first_line
        && next.is_some_and(|l| {
            l.trim_start_matches(crate::units::is_js_space)
                .starts_with('{')
        })
    {
        return Ok(Detected {
            layout: Layout::Lines,
            confidence: "high",
            evidence: "Each line holds one JSON object (JSON Lines): each line is a row.".into(),
        });
    }
    if let Some(member) = records_member(body, complete)? {
        return Ok(Detected {
            evidence: format!(
                "The file is one object whose member \"{member}\" holds an array of objects: those are the rows; its other members are not imported."
            ),
            layout: Layout::Member(member),
            confidence: if complete { "high" } else { "medium" },
        });
    }
    if first_line {
        return Ok(Detected {
            layout: Layout::Lines,
            confidence: "medium",
            evidence: "The file holds one JSON object on one line and no array of objects: it is read as a single row.".into(),
        });
    }
    Err(not_records(if complete {
        "The file holds one JSON object with no array of objects in it, so it has no rows to import.".to_string()
    } else {
        format!(
            "The first {} characters hold one JSON object with no array of objects in them.",
            format_count(text.encode_utf16().count() as u64)
        )
    }))
}

// ---------------------------------------------------------------------------------------------
// Records (records.ts)

/// Where a tree scan stands, between whole values.
#[derive(Clone, Debug, PartialEq)]
enum At {
    /// Before the top-level value.
    Root,
    /// In the top-level array (Array layout): before the first element, or after an element.
    RootArray { first: bool },
    /// In the top-level object: before the first key, or after a member.
    RootObject { first: bool },
    /// After a key of the top-level object, before ':' and its value.
    Key(String),
    /// In the array of a top-level member: before the first element, or after an element.
    MemberArray { key: String, first: bool },
    /// After the top-level value: only white space may follow.
    Done,
}

type MemberHook = Box<dyn FnMut(&str, &J) -> Option<String>>;

/// Scans the records of an array or member layout from text that arrives in pieces: each whole
/// element is parsed on its own and handed over, and nothing else is kept.
pub struct TreeScan {
    /// The member whose array holds the records; None for the top-level array, or for the scan
    /// that looks for such a member.
    member: Option<String>,
    at: At,
    /// Text not consumed yet.
    buf: Vec<u8>,
    /// Records handed over so far.
    pub count: u64,
    on_member_element: Option<MemberHook>,
    /// Whether a broken document is reported with the records read before it; the search for
    /// the records member reads none, so its report gives the reason alone, as recordsMember does.
    counted: bool,
}

impl TreeScan {
    fn new(member: Option<String>) -> TreeScan {
        TreeScan {
            member,
            at: At::Root,
            buf: Vec::new(),
            count: 0,
            on_member_element: None,
            counted: true,
        }
    }

    pub fn for_layout(layout: &Layout) -> TreeScan {
        TreeScan::new(match layout {
            Layout::Member(m) => Some(m.clone()),
            _ => None,
        })
    }

    /// Runs over `text` until the hook answers, for recordsMember.
    fn find(&mut self, text: &[u8], complete: bool) -> Result<Option<String>> {
        self.counted = false;
        self.buf.extend_from_slice(text);
        let mut answer = None;
        let mut sink = |_: u64, _: J| -> Result<()> { Ok(()) };
        self.run(complete, &mut sink, &mut answer)?;
        Ok(answer)
    }

    /// Adds text and hands over every record it completes.
    pub fn push(&mut self, text: &[u8], out: &mut dyn FnMut(u64, J) -> Result<()>) -> Result<()> {
        self.buf.extend_from_slice(text);
        let mut answer = None;
        self.run(false, out, &mut answer)
    }

    /// Ends the document: an incomplete one is not valid JSON.
    pub fn finish(&mut self, out: &mut dyn FnMut(u64, J) -> Result<()>) -> Result<()> {
        let mut answer = None;
        self.run(true, out, &mut answer)?;
        match self.at {
            At::Root => Err(not_records("The file is empty: it holds no JSON.")),
            At::Done => Ok(()),
            _ => Err(broken_json(format!(
                "Unexpected end of JSON input (after {} records).",
                format_count(self.count)
            ))),
        }
    }

    fn broken(&self, reason: impl std::fmt::Display) -> EngineError {
        if !self.counted {
            return broken_json(reason);
        }
        broken_json(format!(
            "{reason} (after {} records).",
            format_count(self.count)
        ))
    }

    /// The end of the whole value starting at `i` (after white space), or None when the text
    /// stops inside it and more may come.
    fn extent(&self, i: usize, complete: bool) -> Option<usize> {
        let b = &self.buf;
        let mut j = i;
        match b.get(j)? {
            b'{' | b'[' => {
                let mut depth = 0usize;
                let mut in_string = false;
                while j < b.len() {
                    let c = b[j];
                    if in_string {
                        if c == b'\\' {
                            j += 1;
                        } else if c == b'"' {
                            in_string = false;
                        }
                    } else if c == b'"' {
                        in_string = true;
                    } else if c == b'{' || c == b'[' {
                        depth += 1;
                    } else if c == b'}' || c == b']' {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    j += 1;
                }
                None
            }
            b'"' => {
                j += 1;
                while j < b.len() {
                    match b[j] {
                        b'\\' => j += 2,
                        b'"' => return Some(j + 1),
                        _ => j += 1,
                    }
                }
                None
            }
            _ => {
                while j < b.len() && !matches!(b[j], b',' | b']' | b'}') && !is_ws(b[j]) {
                    j += 1;
                }
                (j < b.len() || complete).then_some(j)
            }
        }
    }

    /// Skips JSON white space from `i`.
    fn skip_ws(&self, mut i: usize) -> usize {
        while i < self.buf.len() && is_ws(self.buf[i]) {
            i += 1;
        }
        i
    }

    /// After a value in a container: the separator ',' and the start of the next item, or None
    /// when the text stops before that item starts. Nothing is consumed until the item is whole.
    fn after_separator(&self, i: usize, first: bool, close: char) -> Result<Option<usize>> {
        if first {
            return Ok(Some(i));
        }
        if self.buf[i] != b',' {
            return Err(self.broken(format!(
                "Expected ',' or '{close}' but found {:?}",
                self.buf[i] as char
            )));
        }
        let j = self.skip_ws(i + 1);
        Ok((j < self.buf.len()).then_some(j))
    }

    fn element(&self, from: usize, to: usize) -> Result<J> {
        // As the TypeScript reader's TextDecoder: a byte that is not UTF-8 reads as U+FFFD. An
        // element starts and ends on ASCII, so no character is cut.
        let text = String::from_utf8_lossy(&self.buf[from..to]);
        parse(&text).map_err(|e| self.broken(e))
    }

    fn run(
        &mut self,
        complete: bool,
        out: &mut dyn FnMut(u64, J) -> Result<()>,
        answer: &mut Option<String>,
    ) -> Result<()> {
        let mut i = 0;
        loop {
            i = self.skip_ws(i);
            if i >= self.buf.len() {
                break;
            }
            let c = self.buf[i];
            match self.at.clone() {
                At::Root => {
                    let object = self.member.is_some() || self.on_member_element.is_some();
                    if c != if object { b'{' } else { b'[' } {
                        return Err(not_records(match &self.member {
                            Some(m) => format!(
                                "The file was read as an object holding records under \"{m}\", but its top level is not an object."
                            ),
                            None => "The file was read as an array of records, but its top level is not an array.".to_string(),
                        }));
                    }
                    i += 1;
                    self.at = if object {
                        At::RootObject { first: true }
                    } else {
                        At::RootArray { first: true }
                    };
                }
                At::RootArray { first } | At::MemberArray { first, .. } if c == b']' => {
                    let _ = first;
                    i += 1;
                    self.at = if matches!(self.at, At::RootArray { .. }) {
                        At::Done
                    } else {
                        At::RootObject { first: false }
                    };
                }
                At::RootArray { first } => {
                    let Some(j) = self.after_separator(i, first, ']')? else {
                        break;
                    };
                    let Some(end) = self.extent(j, complete) else {
                        break;
                    };
                    let v = self.element(j, end)?;
                    if !matches!(v, J::Obj(_)) {
                        return Err(not_an_object(
                            &format!("Record {}", format_count(self.count)),
                            &v,
                        ));
                    }
                    out(self.count, v)?;
                    self.count += 1;
                    i = end;
                    self.at = At::RootArray { first: false };
                }
                At::RootObject { .. } if c == b'}' => {
                    i += 1;
                    self.at = At::Done;
                }
                At::RootObject { first } => {
                    let Some(j) = self.after_separator(i, first, '}')? else {
                        break;
                    };
                    if self.buf[j] != b'"' {
                        return Err(self.broken(format!(
                            "Expected a key but found {:?}",
                            self.buf[j] as char
                        )));
                    }
                    let Some(end) = self.extent(j, complete) else {
                        break;
                    };
                    let J::Str(key) = self.element(j, end)? else {
                        return Err(self.broken("Expected a key"));
                    };
                    i = end;
                    self.at = At::Key(key);
                }
                At::Key(key) => {
                    if c != b':' {
                        return Err(self.broken(format!("Expected ':' but found {:?}", c as char)));
                    }
                    let j = self.skip_ws(i + 1);
                    let Some(&v) = self.buf.get(j) else {
                        break;
                    };
                    let records_here = self.member.as_deref() == Some(key.as_str());
                    if v == b'[' && (records_here || self.on_member_element.is_some()) {
                        i = j + 1;
                        self.at = At::MemberArray { key, first: true };
                        continue;
                    }
                    let Some(end) = self.extent(j, complete) else {
                        break;
                    };
                    let value = self.element(j, end)?;
                    if records_here && matches!(value, J::Obj(_)) {
                        return Err(not_records(format!(
                            "The member \"{key}\" is not an array."
                        )));
                    }
                    i = end;
                    self.at = At::RootObject { first: false };
                }
                At::MemberArray { key, first } => {
                    let Some(j) = self.after_separator(i, first, ']')? else {
                        break;
                    };
                    let Some(end) = self.extent(j, complete) else {
                        break;
                    };
                    let v = self.element(j, end)?;
                    i = end;
                    self.at = At::MemberArray {
                        key: key.clone(),
                        first: false,
                    };
                    if let Some(hook) = self.on_member_element.as_mut() {
                        if let Some(found) = hook(&key, &v) {
                            *answer = Some(found);
                            return Ok(());
                        }
                        continue;
                    }
                    if !matches!(v, J::Obj(_)) {
                        return Err(not_an_object(
                            &format!("Record {}", format_count(self.count)),
                            &v,
                        ));
                    }
                    out(self.count, v)?;
                    self.count += 1;
                }
                At::Done => {
                    return Err(self.broken(format!(
                        "Unexpected text after the JSON value: {:?}",
                        c as char
                    )));
                }
            }
        }
        self.buf.drain(..i.min(self.buf.len()));
        Ok(())
    }
}

/// One record per line (JSON Lines); the record's locator is its 1-based line.
#[derive(Default)]
pub struct LineScan {
    carry: Vec<u8>,
    line: u64,
    pub count: u64,
}

impl LineScan {
    pub fn push(&mut self, text: &[u8], out: &mut dyn FnMut(u64, J) -> Result<()>) -> Result<()> {
        self.carry.extend_from_slice(text);
        while let Some(nl) = self.carry.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.carry.drain(..=nl).collect();
            self.take(&line[..line.len() - 1], out)?;
        }
        Ok(())
    }

    pub fn finish(&mut self, out: &mut dyn FnMut(u64, J) -> Result<()>) -> Result<()> {
        if !self.carry.is_empty() {
            let line = std::mem::take(&mut self.carry);
            self.take(&line, out)?;
        }
        if self.count == 0 {
            return Err(not_records(
                "The file holds no JSON records: every line is blank.",
            ));
        }
        Ok(())
    }

    fn take(&mut self, text: &[u8], out: &mut dyn FnMut(u64, J) -> Result<()>) -> Result<()> {
        self.line += 1;
        let body = text.strip_suffix(b"\r").unwrap_or(text);
        let body = String::from_utf8_lossy(body);
        if body.trim_matches(crate::units::is_js_space).is_empty() {
            return Ok(());
        }
        let v = parse(&body)
            .map_err(|e| broken_json(format!("line {}: {e}", format_count(self.line))))?;
        if !matches!(v, J::Obj(_)) {
            return Err(not_an_object(
                &format!("Line {}", format_count(self.line)),
                &v,
            ));
        }
        out(self.line, v)?;
        self.count += 1;
        Ok(())
    }
}

/// A record scanner for a layout.
pub enum Records {
    Tree(TreeScan),
    Lines(LineScan),
}

impl Records {
    pub fn new(layout: &Layout) -> Records {
        match layout {
            Layout::Lines => Records::Lines(LineScan::default()),
            other => Records::Tree(TreeScan::for_layout(other)),
        }
    }

    pub fn count(&self) -> u64 {
        match self {
            Records::Tree(t) => t.count,
            Records::Lines(l) => l.count,
        }
    }

    pub fn push(&mut self, text: &[u8], out: &mut dyn FnMut(u64, J) -> Result<()>) -> Result<()> {
        match self {
            Records::Tree(t) => t.push(text, out),
            Records::Lines(l) => l.push(text, out),
        }
    }

    pub fn finish(&mut self, out: &mut dyn FnMut(u64, J) -> Result<()>) -> Result<()> {
        match self {
            Records::Tree(t) => t.finish(out),
            Records::Lines(l) => l.finish(out),
        }
    }
}

/// The members of a record, which the scanners only ever hand over as objects.
pub fn members(v: J) -> Vec<(String, J)> {
    match v {
        J::Obj(m) => m,
        _ => Vec::new(),
    }
}

/// The detections of a JSON file's sniff, after its encoding: its layout, its keys and the keys
/// kept as JSON text.
pub fn detections(
    d: &Detected,
    columns: &RecordColumns,
    records: u64,
    complete: bool,
) -> Vec<(String, Value)> {
    let det = crate::detect::det;
    let keys = columns.keys.clone();
    let scope = if complete {
        format!("all {} records in the file", format_count(records))
    } else {
        format!(
            "the {} records in the first part of the file",
            format_count(records)
        )
    };
    let mut out = vec![
        (
            "layout".to_string(),
            det(
                json!({ "layout": d.layout.name(), "member": d.layout.member() }),
                d.confidence,
                "json-layout",
                d.evidence.clone(),
                false,
            ),
        ),
        (
            "recordKeys".to_string(),
            det(
                json!(keys),
                if complete { "high" } else { "medium" },
                "record-key-union",
                format!(
                    "The union of keys in first-seen order over {scope}: {} keys.",
                    keys.len()
                ),
                false,
            ),
        ),
    ];
    let nested = columns.nested_keys();
    if !nested.is_empty() {
        let list: Vec<String> = nested.iter().map(|k| format!("\"{k}\"")).collect();
        out.push((
            "nestedKeys".to_string(),
            det(
                json!(nested),
                "medium",
                "json-text",
                format!(
                    "The keys {} hold objects or arrays; they are kept as JSON text in text columns.",
                    list.join(", ")
                ),
                false,
            ),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_keys_in_javascript_order() {
        let v = parse(r#"{"b":1,"2":2,"a":3,"1":4,"b":5,"01":6}"#).unwrap();
        let keys: Vec<String> = members(v).into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["1", "2", "b", "a", "01"]);
        assert_eq!(
            stringify(&parse(r#"{"z": [1.0, 2.5e0, "xA"], "y": null}"#).unwrap()),
            r#"{"z":[1,2.5,"xA"],"y":null}"#
        );
    }

    #[test]
    fn finds_records_in_pieces_of_any_size() {
        let text = br#"{"meta": {"a": [1]}, "data": [{"k": 1}, {"k": [2, {"x": "]"}]}], "n": 2}"#;
        for piece in [1, 2, 7, text.len()] {
            let mut scan = TreeScan::for_layout(&Layout::Member("data".into()));
            let mut got = Vec::new();
            for chunk in text.chunks(piece) {
                scan.push(chunk, &mut |i, v| {
                    got.push((i, stringify(&v)));
                    Ok(())
                })
                .unwrap();
            }
            scan.finish(&mut |_, _| Ok(())).unwrap();
            assert_eq!(
                got,
                vec![
                    (0, r#"{"k":1}"#.to_string()),
                    (1, r#"{"k":[2,{"x":"]"}]}"#.to_string())
                ],
                "{piece}"
            );
        }
    }

    #[test]
    fn detects_the_layouts() {
        assert_eq!(detect_layout("[{}]", true).unwrap().layout, Layout::Array);
        assert_eq!(
            detect_layout("{\"a\":1}\n{\"a\":2}\n", true)
                .unwrap()
                .layout,
            Layout::Lines
        );
        assert_eq!(
            detect_layout("{\"count\": 2, \"rows\": [{\"a\": 1}]}", true)
                .unwrap()
                .layout,
            Layout::Member("rows".into())
        );
        assert_eq!(
            detect_layout("{\"a\": 1}", true).unwrap().layout,
            Layout::Lines
        );
        assert_eq!(
            detect_layout("{\"a\": [1, 2]}", true).unwrap().layout,
            Layout::Lines
        );
        assert!(detect_layout("{\n\"a\": [1, 2]\n}", true).is_err());
    }
}
