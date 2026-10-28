//! CSV reading, ported from the TypeScript reader (src/formats/csv: lines.ts, tokenizer.ts,
//! table.ts and shape.ts), so both engines cut a file into the same rows, with the same physical
//! line locators and the same import notes (TW-IMP-001 ragged rows, TW-IMP-003 multi-row header).
//!
//! It reads UTF-8 bytes. Every byte it acts on (delimiter, quote, CR and LF) is ASCII, so a byte
//! of a multi-byte character can never be taken for one. Field text is written straight into the
//! batch being filled, so a row costs no allocation of its own.

use crate::error::{EngineError, Result};
use memchr::memchr3;
use serde_json::{Value, json};

/// 1 MiB of UTF-16 code units, the unit the TypeScript reader measures fields in.
pub const MAX_FIELD_CHARS: usize = 1_048_576;
/// Ragged rows listed one note each; the rest are counted in one closing note.
pub const MAX_RAGGED_NOTES: u64 = 10_000;
/// Extra fields quoted in one note, and the characters quoted of each.
const NOTE_EXTRA_FIELDS: usize = 20;
const NOTE_EXTRA_CHARS: usize = 200;
/// A batch is handed on at this much field text even before it has its rows.
const BATCH_TEXT_BYTES: usize = 64 << 20;
const MISSING: (u32, u32) = (u32::MAX, u32::MAX);
const LF: u8 = b'\n';
const CR: u8 = b'\r';

/// A note about the file, as the TypeScript ImportNote.
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub code: String,
    pub message: String,
    pub src_loc: Option<u64>,
    pub detail: Value,
}

/// Shaped rows: every row has `width` cells, each a byte span of `text` or missing.
pub struct RowBatch {
    pub width: usize,
    pub text: Vec<u8>,
    pub cells: Vec<(u32, u32)>,
    pub locs: Vec<i64>,
}

impl RowBatch {
    fn new(width: usize, rows: usize) -> RowBatch {
        RowBatch {
            width,
            text: Vec::with_capacity(1 << 20),
            cells: Vec::with_capacity(rows * width.max(1)),
            locs: Vec::with_capacity(rows),
        }
    }

    pub fn rows(&self) -> usize {
        self.locs.len()
    }

    /// The bytes of a cell, or None for a field the row did not have.
    pub fn cell(&self, row: usize, col: usize) -> Option<&[u8]> {
        let (a, b) = self.cells[row * self.width + col];
        if (a, b) == MISSING {
            None
        } else {
            Some(&self.text[a as usize..b as usize])
        }
    }
}

/// 1234567 -> "1,234,567".
pub fn format_count(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// "1 field" / "3 fields".
pub fn plural(n: u64, singular: &str) -> String {
    format!(
        "{} {singular}{}",
        format_count(n),
        if n == 1 { "" } else { "s" }
    )
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The first `n` UTF-16 code units of `s`, never splitting a character.
fn utf16_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    FieldStart,
    Unquoted,
    Quoted,
    /// Just read a quote inside a quoted field: it either escapes a second quote or closes the field.
    QuoteSeen,
}

pub struct TableLayout {
    pub delimiter: u8,
    pub skip_lines: u64,
    pub header_rows: usize,
    pub batch_rows: usize,
}

/// Skips the preamble lines, tokenizes, takes the header rows and shapes the data rows into batches.
pub struct TableReader {
    delimiter: u8,
    header_rows: usize,
    line_offset: u64,
    batch_rows: usize,
    // Line skipping (lines.ts).
    skip_left: u64,
    skip_after_cr: bool,
    // Tokenizing (tokenizer.ts).
    state: State,
    line: u64,
    /// Physical line of the current record's first character; 0 while no record is in progress.
    record_line: u64,
    after_cr: bool,
    field_begin: usize,
    spans: Vec<(u32, u32)>,
    // Assembling (table.ts) and shaping (shape.ts).
    header: Vec<(Vec<String>, u64)>,
    started: bool,
    width: usize,
    required: usize,
    ragged: u64,
    batch: RowBatch,
    full: Vec<RowBatch>,
    pub notes: Vec<Note>,
}

impl TableReader {
    pub fn new(layout: &TableLayout) -> TableReader {
        TableReader {
            delimiter: layout.delimiter,
            header_rows: layout.header_rows,
            line_offset: layout.skip_lines,
            batch_rows: layout.batch_rows.max(1),
            skip_left: layout.skip_lines,
            skip_after_cr: false,
            state: State::FieldStart,
            line: 1,
            record_line: 0,
            after_cr: false,
            field_begin: 0,
            spans: Vec::new(),
            header: Vec::new(),
            started: false,
            width: 0,
            required: 0,
            ragged: 0,
            batch: RowBatch::new(0, 0),
            full: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Batches completed so far.
    pub fn take_batches(&mut self) -> Vec<RowBatch> {
        std::mem::take(&mut self.full)
    }

    /// Reads the next text, cut anywhere.
    pub fn push(&mut self, text: &[u8]) -> Result<()> {
        let mut i = 0;
        if self.skip_after_cr && !text.is_empty() {
            self.skip_after_cr = false;
            if text[0] == LF {
                i = 1;
            }
        }
        while self.skip_left > 0 && i < text.len() {
            let c = text[i];
            i += 1;
            if c == LF {
                self.skip_left -= 1;
            } else if c == CR {
                self.skip_left -= 1;
                if i == text.len() {
                    self.skip_after_cr = true;
                } else if text[i] == LF {
                    i += 1;
                }
            }
        }
        if self.skip_left > 0 {
            return Ok(());
        }
        while i < text.len() {
            i = self.step(text, i)?;
        }
        Ok(())
    }

    /// Ends the input: the last record when the text did not end with a line break, the closing
    /// note on unlisted ragged rows, and the last batch.
    pub fn finish(&mut self) -> Result<()> {
        if self.record_line != 0 {
            self.end_record()?;
        }
        self.after_cr = false;
        if self.started && self.ragged > MAX_RAGGED_NOTES {
            let count = self.ragged - MAX_RAGGED_NOTES;
            self.notes.push(Note {
                code: "TW-IMP-001".into(),
                message: format!(
                    "A further {} {} found but not listed one by one, to keep the list readable.",
                    plural(count, "ragged row"),
                    if count == 1 { "was" } else { "were" }
                ),
                src_loc: None,
                detail: json!({ "unlisted": count }),
            });
        }
        if self.batch.rows() > 0 {
            let width = self.width;
            self.full
                .push(std::mem::replace(&mut self.batch, RowBatch::new(width, 0)));
        }
        Ok(())
    }

    fn step(&mut self, t: &[u8], i: usize) -> Result<usize> {
        let c = t[i];
        if self.after_cr {
            self.after_cr = false;
            if c == LF {
                // Inside quotes the LF of a CRLF is field text; outside, its CR already ended the record.
                if self.state == State::Quoted {
                    self.append(b"\n")?;
                }
                return Ok(i + 1);
            }
        }
        match self.state {
            State::FieldStart => self.field_start(t, i, c),
            State::Unquoted => self.unquoted(t, i),
            State::Quoted => self.quoted(t, i),
            State::QuoteSeen => self.quote_seen(i, c),
        }
    }

    fn field_start(&mut self, t: &[u8], i: usize, c: u8) -> Result<usize> {
        if self.record_line == 0 {
            self.record_line = self.line;
        }
        if c == b'"' {
            self.state = State::Quoted;
            return Ok(i + 1);
        }
        if c == self.delimiter {
            self.end_field()?;
            return Ok(i + 1);
        }
        if c == LF || c == CR {
            self.end_record()?;
            self.line_break(c);
            return Ok(i + 1);
        }
        self.state = State::Unquoted;
        self.unquoted(t, i)
    }

    fn unquoted(&mut self, t: &[u8], i: usize) -> Result<usize> {
        let Some(k) = memchr3(self.delimiter, LF, CR, &t[i..]) else {
            self.append(&t[i..])?;
            return Ok(t.len());
        };
        let j = i + k;
        if j > i {
            self.append(&t[i..j])?;
        }
        let c = t[j];
        if c == self.delimiter {
            self.end_field()?;
        } else {
            self.end_record()?;
            self.line_break(c);
        }
        Ok(j + 1)
    }

    fn quoted(&mut self, t: &[u8], i: usize) -> Result<usize> {
        let Some(k) = memchr3(b'"', LF, CR, &t[i..]) else {
            self.append(&t[i..])?;
            return Ok(t.len());
        };
        let j = i + k;
        if j > i {
            self.append(&t[i..j])?;
        }
        let c = t[j];
        if c == b'"' {
            self.state = State::QuoteSeen;
        } else {
            // A line break inside quotes is field text, but it is still a physical line for locators.
            self.append(if c == CR { b"\r" } else { b"\n" })?;
            self.line_break(c);
        }
        Ok(j + 1)
    }

    fn quote_seen(&mut self, i: usize, c: u8) -> Result<usize> {
        if c == b'"' {
            self.append(b"\"")?;
            self.state = State::Quoted;
            return Ok(i + 1);
        }
        if c == self.delimiter {
            self.end_field()?;
            return Ok(i + 1);
        }
        if c == LF || c == CR {
            self.end_record()?;
            self.line_break(c);
            return Ok(i + 1);
        }
        // Text right after a closing quote: keep the quote rather than drop a character of the
        // file, and read on unquoted so one stray quote cannot swallow the rest of the file.
        self.append(b"\"")?;
        self.state = State::Unquoted;
        Ok(i)
    }

    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.batch.text.extend_from_slice(bytes);
        let len = self.batch.text.len() - self.field_begin;
        if len > MAX_FIELD_CHARS {
            let field = String::from_utf8_lossy(&self.batch.text[self.field_begin..]);
            if utf16_len(&field) > MAX_FIELD_CHARS {
                return Err(self.field_too_long());
            }
        }
        Ok(())
    }

    fn span_end(&self) -> Result<u32> {
        u32::try_from(self.batch.text.len()).map_err(|_| {
            EngineError::new(
                "PARSE_FAILED",
                format!(
                    "The record that starts on line {} is too large to read as CSV.",
                    format_count(self.record_line + self.line_offset)
                ),
                "Check the quotes and the delimiter in the import settings.",
            )
        })
    }

    fn end_field(&mut self) -> Result<()> {
        let end = self.span_end()?;
        self.spans.push((self.field_begin as u32, end));
        self.field_begin = end as usize;
        self.state = State::FieldStart;
        Ok(())
    }

    fn end_record(&mut self) -> Result<()> {
        let end = self.span_end()?;
        self.spans.push((self.field_begin as u32, end));
        self.record()?;
        self.spans.clear();
        self.state = State::FieldStart;
        self.record_line = 0;
        self.field_begin = self.batch.text.len();
        Ok(())
    }

    fn line_break(&mut self, c: u8) {
        self.line += 1;
        self.after_cr = c == CR;
    }

    fn field_too_long(&self) -> EngineError {
        let field = self.spans.len() + 1;
        let line = format_count(self.record_line + self.line_offset);
        EngineError::new(
            "PARSE_FAILED",
            format!(
                "Field {field} of the record that starts on line {line} is longer than {} characters, so the file cannot be read as CSV.",
                format_count(MAX_FIELD_CHARS as u64)
            ),
            format!(
                "This usually means a quote is not closed. Check the quotes on and after line {line}, or choose a different delimiter in the import settings."
            ),
        )
    }

    fn span_text(&self, (a, b): (u32, u32)) -> String {
        String::from_utf8_lossy(&self.batch.text[a as usize..b as usize]).into_owned()
    }

    /// Drops the current record's text from the batch: it was a header row or a blank line.
    fn forget_record(&mut self) {
        let start = self.spans[0].0 as usize;
        self.batch.text.truncate(start);
    }

    fn record(&mut self) -> Result<()> {
        let line = self.record_line + self.line_offset;
        let blank = self.spans.len() == 1 && self.spans[0].0 == self.spans[0].1;
        if self.started {
            return self.shape(line, blank);
        }
        if blank {
            self.forget_record();
            return Ok(());
        }
        if self.header_rows == 0 {
            let width = self.spans.len();
            self.start(width, width);
            return self.shape(line, blank);
        }
        let fields: Vec<String> = self.spans.iter().map(|s| self.span_text(*s)).collect();
        self.forget_record();
        self.header.push((fields, line));
        if self.header.len() == self.header_rows {
            let named = self
                .header
                .iter()
                .map(|(row, _)| row.iter().rposition(|f| !f.is_empty()).map_or(0, |i| i + 1))
                .max()
                .unwrap_or(0);
            let width = self.header[0].0.len().max(named);
            self.start(width, named);
            if self.header.len() > 1 {
                let lines: Vec<u64> = self.header.iter().map(|(_, l)| *l).collect();
                self.notes.push(multi_row_header_note(&lines));
            }
        }
        Ok(())
    }

    fn start(&mut self, width: usize, required: usize) {
        self.started = true;
        self.width = width;
        self.required = required.min(width);
        self.batch.width = width;
    }

    fn shape(&mut self, line: u64, blank: bool) -> Result<()> {
        let width = self.width;
        if width > 1 && blank {
            self.forget_record();
            return Ok(());
        }
        let found = self.spans.len();
        if found < width {
            if found < self.required {
                self.report(line, found, 0);
            }
            self.batch.cells.extend_from_slice(&self.spans);
            self.batch
                .cells
                .extend(std::iter::repeat_n(MISSING, width - found));
        } else {
            if found > width && self.spans[width..].iter().any(|(a, b)| a != b) {
                self.report(line, found, width);
            }
            self.batch.cells.extend_from_slice(&self.spans[..width]);
        }
        self.batch.locs.push(line as i64);
        if self.batch.rows() >= self.batch_rows || self.batch.text.len() >= BATCH_TEXT_BYTES {
            let next = RowBatch::new(width, self.batch_rows);
            self.full.push(std::mem::replace(&mut self.batch, next));
        }
        Ok(())
    }

    /// Counts a ragged row and lists it while fewer than MAX_RAGGED_NOTES are listed. `extra_from`
    /// is where the extra fields start, or 0 for a short row.
    fn report(&mut self, line: u64, found: usize, extra_from: usize) {
        self.ragged += 1;
        if self.ragged > MAX_RAGGED_NOTES {
            return;
        }
        let width = self.width as u64;
        let found_n = found as u64;
        let place = format!(
            "Line {} has {}, but the header has {}",
            format_count(line),
            plural(found_n, "field"),
            format_count(width)
        );
        let note = if found_n < width {
            let missing = width - found_n;
            Note {
                code: "TW-IMP-001".into(),
                message: format!(
                    "{place}; the missing {} {} left empty.",
                    plural(missing, "field"),
                    if missing == 1 { "is" } else { "are" }
                ),
                src_loc: Some(line),
                detail: json!({ "expected": width, "found": found_n }),
            }
        } else {
            let extra_count = found_n - width;
            let extra: Vec<String> = self.spans[extra_from..]
                .iter()
                .take(NOTE_EXTRA_FIELDS)
                .map(|s| {
                    let f = self.span_text(*s);
                    if utf16_len(&f) > NOTE_EXTRA_CHARS {
                        format!("{}...", utf16_prefix(&f, NOTE_EXTRA_CHARS))
                    } else {
                        f
                    }
                })
                .collect();
            Note {
                code: "TW-IMP-001".into(),
                message: format!(
                    "{place}; the {} {} not imported and listed in this note.",
                    plural(extra_count, "extra field"),
                    if extra_count == 1 { "is" } else { "are" }
                ),
                src_loc: Some(line),
                detail: json!({ "expected": width, "found": found_n, "extra": extra }),
            }
        };
        self.notes.push(note);
    }
}

/// "line 4", "lines 4 and 5", "lines 4, 5 and 7".
fn lines_text(lines: &[u64]) -> String {
    let names: Vec<String> = lines.iter().map(|l| format_count(*l)).collect();
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("lines {} and {last}", rest.join(", ")),
        _ => format!("line {}", names.join("")),
    }
}

fn multi_row_header_note(lines: &[u64]) -> Note {
    Note {
        code: "TW-IMP-003".into(),
        message: format!(
            "The header is {}, on {}; they are combined into one name per column.",
            plural(lines.len() as u64, "row"),
            lines_text(lines)
        ),
        src_loc: lines.first().copied(),
        detail: json!({ "headerRows": lines.len(), "lines": lines }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Read {
        rows: Vec<(i64, Vec<Option<String>>)>,
        notes: Vec<Note>,
    }

    fn read(text: &str, delimiter: u8, skip: u64, header: usize, piece: usize) -> Read {
        let mut r = TableReader::new(&TableLayout {
            delimiter,
            skip_lines: skip,
            header_rows: header,
            batch_rows: 2,
        });
        let mut batches = Vec::new();
        for chunk in text.as_bytes().chunks(piece) {
            r.push(chunk).unwrap();
            batches.extend(r.take_batches());
        }
        r.finish().unwrap();
        batches.extend(r.take_batches());
        let mut rows = Vec::new();
        for b in &batches {
            for i in 0..b.rows() {
                let cells = (0..b.width)
                    .map(|j| {
                        b.cell(i, j)
                            .map(|c| String::from_utf8_lossy(c).into_owned())
                    })
                    .collect();
                rows.push((b.locs[i], cells));
            }
        }
        Read {
            rows,
            notes: r.notes,
        }
    }

    fn cells(v: &[Option<&str>]) -> Vec<Option<String>> {
        v.iter().map(|c| c.map(String::from)).collect()
    }

    #[test]
    fn formats_counts_like_the_typescript_reader() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1000), "1,000");
        assert_eq!(format_count(1234567), "1,234,567");
        assert_eq!(plural(1, "field"), "1 field");
        assert_eq!(plural(2, "extra field"), "2 extra fields");
    }

    #[test]
    fn reads_the_same_rows_whatever_the_chunking() {
        let text = "title \"open\r\n\r\na,b,c\r\n1,\"x\r\ny\",3\n\n4,\"q\"\"t\",6\r7,8\"9,\"z\"z";
        for piece in 1..=text.len() {
            let r = read(text, b',', 1, 1, piece);
            assert_eq!(
                r.rows,
                vec![
                    (4, cells(&[Some("1"), Some("x\r\ny"), Some("3")])),
                    (7, cells(&[Some("4"), Some("q\"t"), Some("6")])),
                    (8, cells(&[Some("7"), Some("8\"9"), Some("z\"z")])),
                ],
                "piece {piece}"
            );
            assert!(r.notes.is_empty());
        }
    }

    #[test]
    fn pads_short_rows_and_lists_extra_fields() {
        let r = read("a,b,c\n1,2\n1,2,3,,\n1,2,3,x,y\n1,2,3\n", b',', 0, 1, 7);
        assert_eq!(r.rows[0].1, cells(&[Some("1"), Some("2"), None]));
        assert_eq!(r.rows[1].1, cells(&[Some("1"), Some("2"), Some("3")]));
        assert_eq!(r.rows[2].1, cells(&[Some("1"), Some("2"), Some("3")]));
        assert_eq!(r.notes.len(), 2);
        assert_eq!(
            r.notes[0].message,
            "Line 2 has 2 fields, but the header has 3; the missing 1 field is left empty."
        );
        assert_eq!(r.notes[0].src_loc, Some(2));
        assert_eq!(
            r.notes[1].message,
            "Line 4 has 5 fields, but the header has 3; the 2 extra fields are not imported and listed in this note."
        );
        assert_eq!(
            r.notes[1].detail,
            json!({ "expected": 3, "found": 5, "extra": ["x", "y"] })
        );
    }

    #[test]
    fn a_row_may_stop_after_the_last_named_column() {
        let r = read("a,b,\n1,2\n1\n", b',', 0, 1, 64);
        assert_eq!(r.rows[0].1, cells(&[Some("1"), Some("2"), None]));
        assert_eq!(r.notes.len(), 1);
        assert_eq!(r.notes[0].src_loc, Some(3));
    }

    #[test]
    fn joins_a_multi_row_header_and_says_so() {
        let r = read("\nName,Rate\n,bbl/d\nW1,5\n", b',', 0, 2, 3);
        assert_eq!(r.rows, vec![(4, cells(&[Some("W1"), Some("5")]))]);
        assert_eq!(
            r.notes[0].message,
            "The header is 2 rows, on lines 2 and 3; they are combined into one name per column."
        );
        assert_eq!(r.notes[0].src_loc, Some(2));
    }

    #[test]
    fn keeps_blank_lines_of_a_single_column_file() {
        let r = read("v\n1\n\n2\n", b',', 0, 1, 64);
        assert_eq!(
            r.rows,
            vec![
                (2, cells(&[Some("1")])),
                (3, cells(&[Some("")])),
                (4, cells(&[Some("2")]))
            ]
        );
    }

    #[test]
    fn refuses_a_field_longer_than_the_limit() {
        let text = format!("a\n\"{}", "x".repeat(MAX_FIELD_CHARS + 1));
        let mut r = TableReader::new(&TableLayout {
            delimiter: b',',
            skip_lines: 0,
            header_rows: 1,
            batch_rows: 10,
        });
        let err = r.push(text.as_bytes()).unwrap_err();
        assert_eq!(err.code, "PARSE_FAILED");
        assert!(err.message.contains("line 2"));
    }
}
