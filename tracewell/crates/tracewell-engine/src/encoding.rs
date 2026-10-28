//! Text encodings the planner can choose (SAD section 7.3), decoded exactly as the WHATWG
//! TextDecoder the TypeScript engine uses: windows-1252 with its C1 mappings, and UTF-16 with
//! replacement characters for unpaired surrogates. The file is transcoded to UTF-8 once, streaming.

use crate::error::{EngineError, Result};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};

/// WHATWG windows-1252 for bytes 0x80..0x9F; every other byte is the Latin-1 code point.
const C1: [u32; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008D, 0x017D, 0x008F, 0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

fn windows_1252(b: u8) -> char {
    let cp = if (0x80..0xA0).contains(&b) {
        C1[(b - 0x80) as usize]
    } else {
        b as u32
    };
    char::from_u32(cp).unwrap_or('\u{fffd}')
}

/// The path to read as UTF-8: the file itself, or a transcoded copy in `workdir`.
pub fn as_utf8(
    path: &Path,
    encoding: &str,
    bom_length: u64,
    workdir: &Path,
    name: &str,
) -> Result<PathBuf> {
    if encoding == "utf-8" {
        return Ok(path.to_path_buf());
    }
    if !matches!(encoding, "windows-1252" | "utf-16le" | "utf-16be") {
        return Err(EngineError::unsupported(format!(
            "the {encoding} text encoding"
        )));
    }
    let out_path = workdir.join(format!("{name}.utf8"));
    let mut input = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(path)?);
    let mut skip = vec![0u8; bom_length as usize];
    input.read_exact(&mut skip)?;
    let mut out = BufWriter::with_capacity(1 << 20, std::fs::File::create(&out_path)?);
    let mut buf = vec![0u8; 1 << 20];
    let mut text = String::with_capacity(4 << 20);
    let mut carry: Option<u8> = None;
    let mut pending_high: Option<u16> = None;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        text.clear();
        if encoding == "windows-1252" {
            text.extend(buf[..n].iter().map(|b| windows_1252(*b)));
        } else {
            let mut bytes: Vec<u8> = carry.take().into_iter().collect();
            bytes.extend_from_slice(&buf[..n]);
            if bytes.len() % 2 == 1 {
                carry = bytes.pop();
            }
            for pair in bytes.chunks_exact(2) {
                let unit = if encoding == "utf-16le" {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                };
                match (pending_high.take(), unit) {
                    (Some(hi), 0xDC00..=0xDFFF) => {
                        let cp =
                            0x10000 + (((hi as u32) - 0xD800) << 10) + ((unit as u32) - 0xDC00);
                        text.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                    }
                    (prev, 0xD800..=0xDBFF) => {
                        if prev.is_some() {
                            text.push('\u{fffd}');
                        }
                        pending_high = Some(unit);
                    }
                    (prev, _) => {
                        if prev.is_some() {
                            text.push('\u{fffd}');
                        }
                        text.push(if (0xDC00..=0xDFFF).contains(&unit) {
                            '\u{fffd}'
                        } else {
                            char::from_u32(unit as u32).unwrap_or('\u{fffd}')
                        });
                    }
                }
            }
        }
        out.write_all(text.as_bytes())?;
    }
    if pending_high.is_some() || carry.is_some() {
        out.write_all("\u{fffd}".as_bytes())?;
    }
    out.flush()?;
    Ok(out_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_windows_1252_like_textdecoder() {
        assert_eq!(windows_1252(0x80), '€');
        assert_eq!(windows_1252(0x81), '\u{81}');
        assert_eq!(windows_1252(0xF6), 'ö');
        assert_eq!(windows_1252(0xB0), '°');
    }
}
