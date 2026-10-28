//! Text encodings the planner can choose (SAD section 7.3), decoded exactly as the WHATWG
//! TextDecoder the TypeScript engine uses: windows-1252 with its C1 mappings, and UTF-16 with
//! replacement characters for unpaired surrogates. Decoding streams: input may be cut anywhere,
//! even inside a UTF-16 code unit or between the two halves of a surrogate pair.
//!
//! UTF-8 passes through as bytes. Invalid sequences are replaced when each field is read
//! (`String::from_utf8_lossy`), which gives the same text as decoding the whole stream, because
//! the delimiter, quote and line-break bytes are ASCII and can never be part of a sequence.

use crate::error::{EngineError, Result};

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

#[derive(Clone, Copy, PartialEq)]
enum Encoding {
    Utf8,
    Windows1252,
    Utf16Le,
    Utf16Be,
}

/// A streaming decoder to UTF-8 bytes.
pub struct TextDecoder {
    encoding: Encoding,
    /// Bytes of the byte-order mark still to skip.
    bom_left: usize,
    /// The first byte of a UTF-16 code unit cut by the end of the last input.
    carry: Option<u8>,
    /// A high surrogate waiting for its low half.
    pending_high: Option<u16>,
}

fn push_char(out: &mut Vec<u8>, c: char) {
    let mut buf = [0u8; 4];
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
}

impl TextDecoder {
    pub fn new(encoding: &str, bom_length: u64) -> Result<TextDecoder> {
        let encoding = match encoding {
            "utf-8" => Encoding::Utf8,
            "windows-1252" => Encoding::Windows1252,
            "utf-16le" => Encoding::Utf16Le,
            "utf-16be" => Encoding::Utf16Be,
            other => {
                return Err(EngineError::unsupported(format!(
                    "the {other} text encoding"
                )));
            }
        };
        Ok(TextDecoder {
            encoding,
            bom_left: bom_length as usize,
            carry: None,
            pending_high: None,
        })
    }

    /// Decodes the next input bytes, appending UTF-8 to `out`.
    pub fn decode(&mut self, input: &[u8], out: &mut Vec<u8>) {
        let skip = self.bom_left.min(input.len());
        self.bom_left -= skip;
        let input = &input[skip..];
        match self.encoding {
            Encoding::Utf8 => out.extend_from_slice(input),
            Encoding::Windows1252 => {
                out.reserve(input.len());
                for &b in input {
                    if b < 0x80 {
                        out.push(b);
                    } else {
                        push_char(out, windows_1252(b));
                    }
                }
            }
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let mut rest = input;
                if let Some(first) = self.carry.take() {
                    match rest.split_first() {
                        Some((&second, tail)) => {
                            self.unit([first, second], out);
                            rest = tail;
                        }
                        None => {
                            self.carry = Some(first);
                            return;
                        }
                    }
                }
                let mut pairs = rest.chunks_exact(2);
                for pair in &mut pairs {
                    self.unit([pair[0], pair[1]], out);
                }
                if let [last] = pairs.remainder() {
                    self.carry = Some(*last);
                }
            }
        }
    }

    /// Ends the input: a cut code unit or a lone high surrogate becomes one replacement character.
    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if self.pending_high.take().is_some() || self.carry.take().is_some() {
            push_char(out, '\u{fffd}');
        }
    }

    fn unit(&mut self, bytes: [u8; 2], out: &mut Vec<u8>) {
        let unit = if self.encoding == Encoding::Utf16Le {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        };
        match (self.pending_high.take(), unit) {
            (Some(hi), 0xDC00..=0xDFFF) => {
                let cp = 0x10000 + (((hi as u32) - 0xD800) << 10) + ((unit as u32) - 0xDC00);
                push_char(out, char::from_u32(cp).unwrap_or('\u{fffd}'));
            }
            (prev, 0xD800..=0xDBFF) => {
                if prev.is_some() {
                    push_char(out, '\u{fffd}');
                }
                self.pending_high = Some(unit);
            }
            (prev, _) => {
                if prev.is_some() {
                    push_char(out, '\u{fffd}');
                }
                if unit < 0x80 {
                    out.push(unit as u8);
                } else {
                    let c = if (0xDC00..=0xDFFF).contains(&unit) {
                        '\u{fffd}'
                    } else {
                        char::from_u32(unit as u32).unwrap_or('\u{fffd}')
                    };
                    push_char(out, c);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_in_pieces(encoding: &str, bom: u64, bytes: &[u8], piece: usize) -> String {
        let mut d = TextDecoder::new(encoding, bom).unwrap();
        let mut out = Vec::new();
        for chunk in bytes.chunks(piece) {
            d.decode(chunk, &mut out);
        }
        d.finish(&mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn maps_windows_1252_like_textdecoder() {
        assert_eq!(windows_1252(0x80), '€');
        assert_eq!(windows_1252(0x81), '\u{81}');
        assert_eq!(windows_1252(0xF6), 'ö');
        assert_eq!(windows_1252(0xB0), '°');
        assert_eq!(
            decode_in_pieces("windows-1252", 0, b"a\x80b\xb0", 1),
            "a€b°"
        );
    }

    #[test]
    fn decodes_utf16_cut_anywhere() {
        // BOM, "a", U+1F600 as a surrogate pair, "b", then a lone high surrogate at the end.
        let le: Vec<u8> = [0xFEFFu16, 0x61, 0xD83D, 0xDE00, 0x62, 0xD800]
            .iter()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        for piece in 1..=5 {
            assert_eq!(
                decode_in_pieces("utf-16le", 2, &le, piece),
                "a\u{1F600}b\u{fffd}"
            );
        }
        let be: Vec<u8> = [0x61u16, 0xDE00, 0x62]
            .iter()
            .flat_map(|u| u.to_be_bytes())
            .collect();
        assert_eq!(decode_in_pieces("utf-16be", 0, &be, 3), "a\u{fffd}b");
        assert_eq!(
            decode_in_pieces("utf-16be", 0, &[0, 0x61, 0], 2),
            "a\u{fffd}"
        );
    }

    #[test]
    fn skips_the_bom_even_when_cut() {
        assert_eq!(decode_in_pieces("utf-8", 3, b"\xef\xbb\xbfab", 1), "ab");
    }
}
