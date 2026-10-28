//! The engine protocol's process framing (SAD section 4.3, phase A): one line of JSON per message,
//! followed by the raw bytes of every byte array it carries. What JSON cannot say directly is a
//! marker object under the key "\u0000tw": {"b": byte array}, {"u": undefined}, {"o": escaped object}.

use serde_json::{Map, Value};
use std::io::{self, BufRead, Write};

pub const MARK: &str = "\u{0}tw";

/// One message as received: the value, and the byte arrays its byte-array markers refer to.
pub struct Incoming {
    pub value: Value,
    pub frames: Vec<Vec<u8>>,
}

impl Incoming {
    /// The bytes a byte-array marker stands for, if `v` is one.
    pub fn bytes<'a>(&'a self, v: &Value) -> Option<&'a [u8]> {
        let o = v.as_object()?;
        if o.get(MARK)?.as_str()? != "b" {
            return None;
        }
        let i = o.get("i")?.as_u64()? as usize;
        self.frames.get(i).map(|f| f.as_slice())
    }
}

fn collect_marks(v: &Value, into: &mut Vec<(usize, usize)>) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| collect_marks(x, into)),
        Value::Object(o) => match o.get(MARK).and_then(Value::as_str) {
            Some("b") => {
                let i = o.get("i").and_then(Value::as_u64).unwrap_or(0) as usize;
                let n = o.get("n").and_then(Value::as_u64).unwrap_or(0) as usize;
                into.push((i, n));
            }
            // An escaped object's own keys are data; only its values can hold markers.
            Some("o") => {
                if let Some(inner) = o.get("v").and_then(Value::as_object) {
                    inner.values().for_each(|x| collect_marks(x, into));
                }
            }
            Some(_) => {}
            None => o.values().for_each(|x| collect_marks(x, into)),
        },
        _ => {}
    }
}

/// Unwraps escaped objects and turns undefined markers into null; byte-array markers stay.
fn revive(v: Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.into_iter().map(revive).collect()),
        Value::Object(mut o) => match o.get(MARK).and_then(Value::as_str) {
            Some("u") => Value::Null,
            Some("b") => Value::Object(o),
            Some("o") => match o.remove("v") {
                Some(Value::Object(inner)) => {
                    Value::Object(inner.into_iter().map(|(k, x)| (k, revive(x))).collect())
                }
                _ => Value::Null,
            },
            _ => Value::Object(o.into_iter().map(|(k, x)| (k, revive(x))).collect()),
        },
        other => other,
    }
}

/// Reads one message, or None at the end of the stream.
pub fn read_message<R: BufRead>(r: &mut R) -> io::Result<Option<Incoming>> {
    let mut line = Vec::new();
    if r.read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    let value: Value =
        serde_json::from_slice(&line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut marks = Vec::new();
    collect_marks(&value, &mut marks);
    marks.sort_unstable();
    let mut frames = vec![Vec::new(); marks.iter().map(|(i, _)| i + 1).max().unwrap_or(0)];
    for (i, n) in marks {
        let mut buf = vec![0u8; n];
        r.read_exact(&mut buf)?;
        frames[i] = buf;
    }
    Ok(Some(Incoming {
        value: revive(value),
        frames,
    }))
}

/// Wraps any object that happens to use the marker key, so the receiver does not misread data.
fn escape(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(escape).collect()),
        Value::Object(o) => {
            let inner: Map<String, Value> = o.iter().map(|(k, x)| (k.clone(), escape(x))).collect();
            if inner.contains_key(MARK) {
                let mut wrapped = Map::new();
                wrapped.insert(MARK.to_string(), Value::String("o".into()));
                wrapped.insert("v".into(), Value::Object(inner));
                Value::Object(wrapped)
            } else {
                Value::Object(inner)
            }
        }
        other => other.clone(),
    }
}

/// Writes one message and flushes it.
pub fn write_message<W: Write>(w: &mut W, v: &Value) -> io::Result<()> {
    write_with_frames(w, &escape(v), &[])
}

/// A value with byte arrays: the value is escaped first, then each byte array's marker is put in
/// place, so a marker can never be confused with data.
pub fn with_bytes(v: &Value, place: impl FnOnce(&mut Value, Value), bytes: usize) -> Value {
    let mut escaped = escape(v);
    let mut marker = Map::new();
    marker.insert(MARK.to_string(), Value::String("b".into()));
    marker.insert("i".into(), Value::from(0));
    marker.insert("n".into(), Value::from(bytes));
    place(&mut escaped, Value::Object(marker));
    escaped
}

/// Writes an escaped message and the byte arrays its markers stand for, in marker order.
pub fn write_with_frames<W: Write>(w: &mut W, escaped: &Value, frames: &[&[u8]]) -> io::Result<()> {
    let mut bytes =
        serde_json::to_vec(escaped).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    bytes.push(b'\n');
    w.write_all(&bytes)?;
    for f in frames {
        w.write_all(f)?;
    }
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn reads_binary_frames_after_the_line() {
        let mut data = br#"{"params":[{"kind":"bytes","bytes":{"\u0000tw":"b","i":0,"n":3},"name":"a"},{"\u0000tw":"u"}]}"#.to_vec();
        data.push(b'\n');
        data.extend_from_slice(&[1, 10, 255]);
        let msg = read_message(&mut Cursor::new(data)).unwrap().unwrap();
        let file = &msg.value["params"][0];
        assert_eq!(msg.bytes(&file["bytes"]), Some(&[1u8, 10, 255][..]));
        assert_eq!(msg.value["params"][1], Value::Null);
    }

    #[test]
    fn escapes_and_unescapes_the_marker_key() {
        let data = json!({"x": {"\u{0}tw": "b", "i": 0}});
        let mut out = Vec::new();
        write_message(&mut out, &data).unwrap();
        let back = read_message(&mut Cursor::new(out)).unwrap().unwrap();
        assert_eq!(back.value, data);
        assert!(back.frames.is_empty());
    }
}
