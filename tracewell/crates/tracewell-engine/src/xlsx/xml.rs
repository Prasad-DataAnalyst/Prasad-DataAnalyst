//! XML for the Excel reader (formats/xlsx/xml.ts): a tokenizer over one package part that hands
//! each element and run of text to a handler, element names without their namespace prefix.
//!
//! Only the five predefined entities and character references are expanded, never a DTD, so a
//! workbook cannot pull in external entities (SAD section 12); SpreadsheetML never has a DTD, so a
//! part that declares one is refused outright. Line ends are normalised and attribute values have
//! their white space normalised, as XML requires of every parser.
//!
//! Text in cells is ST_Xstring (ECMA-376 Part 1, 22.9.2.19): characters XML cannot carry are
//! written as _xHHHH_, which `decode_xstring` reverses.

use super::damaged;
use crate::error::Result;

/// The attributes of an element by their qualified names, in document order.
#[derive(Default)]
pub struct Attrs(Vec<(String, String)>);

impl Attrs {
    /// An attribute by its local name: 'r' finds r="A1", and 'id' finds r:id="rId1" whatever the
    /// prefix. An unprefixed attribute of that name wins over a prefixed one.
    pub fn get(&self, local: &str) -> Option<&str> {
        if let Some((_, v)) = self.0.iter().find(|(k, _)| k == local) {
            return Some(v);
        }
        self.0
            .iter()
            .find(|(k, _)| {
                k.len() > local.len()
                    && k.ends_with(local)
                    && k.as_bytes()[k.len() - local.len() - 1] == b':'
            })
            .map(|(_, v)| v.as_str())
    }
}

/// SpreadsheetML booleans are '1'/'0' or 'true'/'false'.
pub fn xml_bool(value: Option<&str>) -> Option<bool> {
    match value {
        Some("1" | "true") => Some(true),
        Some("0" | "false") => Some(false),
        _ => None,
    }
}

/// What a part's elements and text are handed to. A self-closing element is opened, then closed.
pub trait Handler {
    fn open(&mut self, _name: &str, _attrs: &Attrs, _self_closing: bool) -> Result<()> {
        Ok(())
    }
    fn close(&mut self, _name: &str) -> Result<()> {
        Ok(())
    }
    /// Character data, possibly in several pieces; CDATA sections arrive here too.
    fn text(&mut self, _text: &str) -> Result<()> {
        Ok(())
    }
}

fn local_name(name: &str) -> &str {
    name.rfind(':').map_or(name, |i| &name[i + 1..])
}

/// The part's text: UTF-16 after its byte-order mark, otherwise UTF-8 with or without one.
fn decode(bytes: &[u8], part: &str) -> Result<String> {
    let not_text = || damaged(format!("the part {part} is not valid text."));
    let utf16 = |little: bool| -> Result<String> {
        let units = bytes[2..].chunks(2).map(|p| {
            if p.len() < 2 {
                None
            } else if little {
                Some(u16::from_le_bytes([p[0], p[1]]))
            } else {
                Some(u16::from_be_bytes([p[0], p[1]]))
            }
        });
        let units: Option<Vec<u16>> = units.collect();
        let units = units.ok_or_else(not_text)?;
        char::decode_utf16(units)
            .collect::<std::result::Result<String, _>>()
            .map_err(|_| not_text())
    };
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16(true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16(false);
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    std::str::from_utf8(body)
        .map(str::to_string)
        .map_err(|_| not_text())
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

fn ends_name(b: u8) -> bool {
    is_space(b) || matches!(b, b'/' | b'>' | b'=' | b'<' | b'"' | b'\'')
}

/// Expands the predefined entities and character references of `raw`.
fn expand(raw: &str) -> std::result::Result<String, String> {
    if !raw.contains('&') {
        return Ok(raw.to_string());
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let end = after
            .find(';')
            .ok_or_else(|| "an entity is not terminated".to_string())?;
        let name = &after[..end];
        match name {
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "amp" => out.push('&'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ => {
                let code = if let Some(hex) = name.strip_prefix("#x") {
                    u32::from_str_radix(hex, 16).ok()
                } else if let Some(dec) = name.strip_prefix('#') {
                    dec.parse::<u32>().ok()
                } else {
                    return Err(format!("undefined entity {name}"));
                };
                let c = code
                    .filter(|&c| c == 0x9 || c == 0xA || c == 0xD || c >= 0x20)
                    .and_then(char::from_u32)
                    .ok_or_else(|| format!("malformed character reference &{name};"))?;
                out.push(c);
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Parses one package part, handing its elements and text to `handler`. A part that is not
/// well-formed or not valid text is a damaged workbook naming the part; errors from the handler
/// pass through unchanged.
pub fn parse(bytes: &[u8], part: &str, handler: &mut dyn Handler) -> Result<()> {
    let decoded = decode(bytes, part)?;
    // Line ends are normalised before anything else reads the text.
    let text = if decoded.contains('\r') {
        decoded.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        decoded
    };
    let s = text.as_bytes();
    let bad = |why: &str| damaged(format!("the part {part} is not well-formed XML ({why})."));
    let find = |from: usize, what: &str| -> Option<usize> {
        text.get(from..)
            .and_then(|t| t.find(what))
            .map(|k| from + k)
    };
    let mut stack: Vec<&str> = Vec::new();
    let mut had_root = false;
    let mut i = 0;
    while i < s.len() {
        if s[i] != b'<' {
            let end = memchr::memchr(b'<', &s[i..]).map_or(s.len(), |k| i + k);
            let run = &text[i..end];
            if stack.is_empty() {
                if !run.bytes().all(is_space) {
                    return Err(bad("text outside the root element"));
                }
            } else {
                handler.text(&expand(run).map_err(|e| bad(&e))?)?;
            }
            i = end;
            continue;
        }
        let rest = &text[i..];
        if rest.starts_with("<?") {
            let end = find(i + 2, "?>").ok_or_else(|| bad("an unclosed processing instruction"))?;
            i = end + 2;
        } else if rest.starts_with("<!--") {
            let end = find(i + 4, "-->").ok_or_else(|| bad("an unclosed comment"))?;
            i = end + 3;
        } else if rest.starts_with("<![CDATA[") {
            if stack.is_empty() {
                return Err(bad("CDATA outside the root element"));
            }
            let end = find(i + 9, "]]>").ok_or_else(|| bad("an unclosed CDATA section"))?;
            handler.text(&text[i + 9..end])?;
            i = end + 3;
        } else if rest.starts_with("<!DOCTYPE") {
            return Err(damaged(format!(
                "the part {part} declares a document type, which workbook parts never do."
            )));
        } else if rest.starts_with("<!") {
            return Err(bad("an unexpected declaration"));
        } else if rest.starts_with("</") {
            let start = i + 2;
            let mut j = start;
            while j < s.len() && !ends_name(s[j]) {
                j += 1;
            }
            let name = &text[start..j];
            while j < s.len() && is_space(s[j]) {
                j += 1;
            }
            if j >= s.len() || s[j] != b'>' {
                return Err(bad("an unclosed end tag"));
            }
            match stack.pop() {
                Some(open) if open == name => handler.close(local_name(name))?,
                Some(open) => {
                    return Err(bad(&format!("the end tag {name} does not match {open}")));
                }
                None => return Err(bad(&format!("the end tag {name} has no start tag"))),
            }
            i = j + 1;
        } else {
            if stack.is_empty() && had_root {
                return Err(bad("a second root element"));
            }
            let start = i + 1;
            let mut j = start;
            while j < s.len() && !ends_name(s[j]) {
                j += 1;
            }
            if j == start {
                return Err(bad("a tag without a name"));
            }
            let name = &text[start..j];
            let mut attrs: Vec<(String, String)> = Vec::new();
            let self_closing = loop {
                let before = j;
                while j < s.len() && is_space(s[j]) {
                    j += 1;
                }
                if j >= s.len() {
                    return Err(bad(&format!("the tag {name} is not closed")));
                }
                if s[j] == b'>' {
                    j += 1;
                    break false;
                }
                if s[j] == b'/' {
                    if s.get(j + 1) != Some(&b'>') {
                        return Err(bad(&format!("the tag {name} is not closed")));
                    }
                    j += 2;
                    break true;
                }
                if j == before {
                    return Err(bad(&format!("the attributes of {name} are not separated")));
                }
                let a = j;
                while j < s.len() && !ends_name(s[j]) {
                    j += 1;
                }
                let attr = &text[a..j];
                while j < s.len() && is_space(s[j]) {
                    j += 1;
                }
                if attr.is_empty() || s.get(j) != Some(&b'=') {
                    return Err(bad(&format!("an attribute of {name} has no value")));
                }
                j += 1;
                while j < s.len() && is_space(s[j]) {
                    j += 1;
                }
                let quote = match s.get(j) {
                    Some(&q @ (b'"' | b'\'')) => q,
                    _ => return Err(bad(&format!("the attribute {attr} is not quoted"))),
                };
                let close = memchr::memchr(quote, &s[j + 1..])
                    .map(|k| j + 1 + k)
                    .ok_or_else(|| bad(&format!("the attribute {attr} is not closed")))?;
                let raw = &text[j + 1..close];
                if raw.contains('<') {
                    return Err(bad(&format!("the attribute {attr} holds '<'")));
                }
                // White space in a value is normalised before references are expanded, so a
                // character reference keeps a tab or line break as written.
                let value = expand(&raw.replace(['\t', '\n'], " ")).map_err(|e| bad(&e))?;
                if attrs.iter().any(|(k, _)| k == attr) {
                    return Err(bad(&format!("the attribute {attr} appears twice")));
                }
                attrs.push((attr.to_string(), value));
                j = close + 1;
            };
            had_root = true;
            let attrs = Attrs(attrs);
            handler.open(local_name(name), &attrs, self_closing)?;
            if self_closing {
                handler.close(local_name(name))?;
            } else {
                stack.push(name);
            }
            i = j;
        }
    }
    if let Some(open) = stack.last() {
        return Err(bad(&format!("the element {open} is not closed")));
    }
    if !had_root {
        return Err(bad("there is no root element"));
    }
    Ok(())
}

/// Reverses the _xHHHH_ escapes of ST_Xstring. Each escape is one UTF-16 unit, so a pair of
/// escapes may make one character; a unit left unpaired becomes U+FFFD.
pub fn decode_xstring(s: &str) -> String {
    if !s.contains("_x") {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut units: Vec<u16> = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'_'
            && b.get(i + 1) == Some(&b'x')
            && i + 7 <= b.len()
            && b[i + 6] == b'_'
            && b[i + 2..i + 6].iter().all(u8::is_ascii_hexdigit)
        {
            let hex = std::str::from_utf8(&b[i + 2..i + 6]).unwrap_or("0");
            units.push(u16::from_str_radix(hex, 16).unwrap_or(0));
            i += 7;
            continue;
        }
        let c = s[i..].chars().next().unwrap_or('\u{FFFD}');
        let mut buf = [0u16; 2];
        units.extend_from_slice(c.encode_utf16(&mut buf));
        i += c.len_utf8();
    }
    String::from_utf16_lossy(&units)
}
