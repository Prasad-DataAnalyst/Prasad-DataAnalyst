//! The deterministic workbook writer used by export (formats/xlsx/writer.ts). The same book always
//! gives the same bytes: the document properties carry the creation time given by the caller, the
//! ZIP has fixed entry times, and nothing depends on the machine.
//!
//! Cells are typed: numbers t="n", booleans t="b", text as inline strings, dates and times as
//! serial numbers with a date format. The header row is bold, can be frozen (pane at A2) and can
//! carry an autofilter over the data. The writer never writes formulas or merged cells (SAD
//! section 12). Each sheet's rows are written to a file as they come, so a sheet of a million rows
//! is never held in memory; the parts are joined only inside the ZIP.

use super::column_name;
use crate::canonical::canonical_number;
use crate::csv::format_count;
use crate::digest::Cell;
use crate::error::{EngineError, Result};
use crate::parse::Kind;
use crate::time::MS_PER_DAY;
use crate::zip::{Part, ZipWriter};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// The most data rows an Excel sheet holds below its header row.
pub const EXCEL_MAX_DATA_ROWS: u64 = 1_048_575;
/// The most characters (UTF-16 units) an Excel cell holds.
pub const EXCEL_MAX_CELL_CHARS: usize = 32_767;
const MAX_COLS: usize = 16_384;

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_TYPE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Cell style indexes into cellXfs of the styles part.
const STYLE_HEADER: u32 = 1;
const STYLE_INTEGER: u32 = 2;
const STYLE_DATE: u32 = 3;
const STYLE_DATETIME: u32 = 4;

// Column widths in Excel character units.
const MIN_WIDTH: f64 = 8.0;
const MAX_WIDTH: f64 = 60.0;
const WIDTH_PADDING: f64 = 2.0;
/// Room for the autofilter drop-down button in the header cell.
const FILTER_BUTTON: usize = 2;

fn invalid_argument(message: String) -> EngineError {
    EngineError::new(
        "INVALID_INPUT",
        message,
        "Correct the value passed to the function; this is a defect in the calling code, not in the data.",
    )
}

/// A column of a sheet; `width` is in Excel character units, else it follows the longest value.
#[derive(Clone, Debug)]
pub struct Column {
    pub header: String,
    pub kind: Kind,
    pub width: Option<f64>,
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::String => "string",
        Kind::Number => "number",
        Kind::Integer => "integer",
        Kind::Boolean => "boolean",
        Kind::Date => "date",
        Kind::DateTime => "datetime",
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// ---------------------------------------------------------------------------------------------
// XML text (xml.ts)

fn hex4(code: u32) -> String {
    format!("_x{code:04X}_")
}

/// Cell text as XML character data, with ST_Xstring escapes for what XML cannot carry.
fn xml_text(s: &str) -> String {
    let needs = |c: char| {
        let code = c as u32;
        (code < 0x20 && c != '\t' && c != '\n')
            || matches!(c, '&' | '<' | '>' | '_')
            || code == 0xFFFE
            || code == 0xFFFF
    };
    if !s.chars().any(needs) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 16);
    let b = s.as_bytes();
    for (i, c) in s.char_indices() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '_' => {
                // A literal '_x0041_' keeps its underscore, written as _x005F_.
                let escaped = b.get(i + 1) == Some(&b'x')
                    && b.get(i + 2..i + 6)
                        .is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit))
                    && b.get(i + 6) == Some(&b'_');
                out.push_str(if escaped { "_x005F_" } else { "_" });
            }
            '\t' | '\n' => out.push(c),
            c if (c as u32) < 0x20 || c as u32 == 0xFFFE || c as u32 == 0xFFFF => {
                out.push_str(&hex4(c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

/// An attribute value: tabs and line breaks become character references.
fn xml_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("&#9;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            c => out.push(c),
        }
    }
    out
}

/// Metadata text: characters XML cannot carry become U+FFFD.
fn metadata_text(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            let code = c as u32;
            if (code < 0x20 && c != '\t' && c != '\n') || code == 0xFFFE || code == 0xFFFF {
                '\u{FFFD}'
            } else {
                c
            }
        })
        .collect();
    xml_attr(&cleaned)
}

// ---------------------------------------------------------------------------------------------
// Cells

/// Canonical number text with an upper-case exponent, as spreadsheet programs write it.
fn number_text(n: f64) -> String {
    canonical_number(n).replace('e', "E")
}

/// The 1900-system serial of an instant (cellToSerial); Excel stores no date before 1900-01-01.
fn serial(unix_ms: i64, text: impl Fn() -> String) -> Result<f64> {
    let unix_days = unix_ms.div_euclid(MS_PER_DAY);
    let ms_of_day = unix_ms - unix_days * MS_PER_DAY;
    let mut day = unix_days + 25_569;
    if day < 61 {
        day -= 1;
    }
    if day < 0 {
        return Err(EngineError::new(
            "INVALID_INPUT",
            format!(
                "Excel cannot store {}: its dates start on 1900-01-01.",
                text()
            ),
            "Export this data with the CSV profile, which keeps every date, or exclude the rows dated before 1900.",
        ));
    }
    Ok(day as f64 + ms_of_day as f64 / MS_PER_DAY as f64)
}

fn cell_ref(r: u64, c: usize) -> String {
    format!("{}{}", column_name(c as u32), r + 1)
}

fn inline_string(reference: &str, text: &str, style: &str) -> String {
    let trimmed = text.trim_matches(crate::units::is_js_space);
    let preserve = if trimmed.len() != text.len() || text.contains(['\t', '\n', '\r']) {
        " xml:space=\"preserve\""
    } else {
        ""
    };
    format!(
        "<c r=\"{reference}\"{style} t=\"inlineStr\"><is><t{preserve}>{}</t></is></c>",
        xml_text(text)
    )
}

fn serial_cell(reference: &str, serial: f64, style: u32) -> String {
    format!(
        "<c r=\"{reference}\" s=\"{style}\" t=\"n\"><v>{}</v></c>",
        number_text(serial)
    )
}

fn describe(v: &Cell) -> String {
    match v {
        Cell::Text(_) => "text".into(),
        Cell::Num(n) if n.is_finite() => "a number".into(),
        Cell::Num(n) => format!(
            "the non-finite number {}",
            if n.is_nan() {
                "NaN"
            } else if *n > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            }
        ),
        Cell::Bool(_) => "a boolean".into(),
        Cell::Date(_) | Cell::DateText(_) => "a date".into(),
        Cell::DateTime(_) | Cell::DateTimeText(_) => "a date and time".into(),
        Cell::Null => "a value of an unknown type".into(),
    }
}

/// The XML of one cell and the characters it shows; None when the value does not fit the kind.
fn cell_out(v: &Cell, kind: Kind, reference: &str) -> Result<Option<(String, usize)>> {
    Ok(match (kind, v) {
        (Kind::String, Cell::Text(t)) => Some((inline_string(reference, t, ""), utf16_len(t))),
        (Kind::Number | Kind::Integer, Cell::Num(n)) if n.is_finite() => {
            let text = number_text(*n);
            let style = if kind == Kind::Integer {
                format!(" s=\"{STYLE_INTEGER}\"")
            } else {
                String::new()
            };
            let chars = text.len();
            Some((
                format!("<c r=\"{reference}\"{style} t=\"n\"><v>{text}</v></c>"),
                chars,
            ))
        }
        (Kind::Boolean, Cell::Bool(b)) => Some((
            format!("<c r=\"{reference}\" t=\"b\"><v>{}</v></c>", u8::from(*b)),
            5,
        )),
        (Kind::Date, Cell::Date(d)) => {
            let s = serial(d * MS_PER_DAY, || crate::time::date_text(*d))?;
            Some((serial_cell(reference, s, STYLE_DATE), 10))
        }
        (Kind::DateTime, Cell::DateTime(ms)) => {
            let s = serial(*ms, || crate::time::iso_from_millis(*ms))?;
            Some((serial_cell(reference, s, STYLE_DATETIME), 23))
        }
        _ => None,
    })
}

fn check_text(text: &str, sheet: &str, row: u64, column: &str) -> Result<()> {
    let len = utf16_len(text);
    if len <= EXCEL_MAX_CELL_CHARS {
        return Ok(());
    }
    Err(invalid_argument(format!(
        "Row {}, column \"{column}\" of sheet \"{sheet}\" holds {} characters; an Excel cell holds at most {}.",
        format_count(row),
        format_count(len as u64),
        format_count(EXCEL_MAX_CELL_CHARS as u64)
    )))
}

// ---------------------------------------------------------------------------------------------
// Sheets

/// A sheet being written: its rows go to a file as they come.
pub struct SheetWriter {
    name: String,
    columns: Vec<Column>,
    freeze_header: bool,
    auto_filter: bool,
    out: BufWriter<File>,
    body: PathBuf,
    /// Rows written, the header included.
    rows: u64,
    /// The widest text in each column, in characters.
    chars: Vec<usize>,
}

/// A sheet whose rows are all written, ready for the workbook.
pub struct WrittenSheet {
    name: String,
    columns: Vec<Column>,
    freeze_header: bool,
    body: PathBuf,
    rows: u64,
    chars: Vec<usize>,
    /// The autofilter range, for the workbook's _xlnm._FilterDatabase name.
    filter_ref: Option<String>,
}

impl SheetWriter {
    /// Starts a sheet whose rows are written to `body`, with its header row.
    pub fn create(
        body: &Path,
        name: &str,
        columns: Vec<Column>,
        freeze_header: bool,
        auto_filter: bool,
    ) -> Result<SheetWriter> {
        if columns.len() > MAX_COLS {
            return Err(invalid_argument(format!(
                "Sheet \"{name}\" has {} columns; Excel holds at most {}.",
                format_count(columns.len() as u64),
                format_count(MAX_COLS as u64)
            )));
        }
        for col in &columns {
            check_text(&col.header, name, 1, &col.header)?;
            if let Some(w) = col.width
                && !(w.is_finite() && w > 0.0 && w <= 255.0)
            {
                return Err(invalid_argument(format!(
                    "Column \"{}\" of sheet \"{name}\" has the width {}; use more than 0 and at most 255.",
                    col.header,
                    canonical_number(w)
                )));
            }
        }
        let mut out = BufWriter::with_capacity(1 << 20, File::create(body)?);
        let mut row = String::from("<row r=\"1\">");
        for (c, col) in columns.iter().enumerate() {
            row.push_str(&inline_string(
                &cell_ref(0, c),
                &col.header,
                &format!(" s=\"{STYLE_HEADER}\""),
            ));
        }
        row.push_str("</row>");
        out.write_all(row.as_bytes())?;
        let filter = if auto_filter { FILTER_BUTTON } else { 0 };
        let chars = columns
            .iter()
            .map(|c| utf16_len(&c.header) + filter)
            .collect();
        Ok(SheetWriter {
            name: name.to_string(),
            columns,
            freeze_header,
            auto_filter,
            out,
            body: body.to_path_buf(),
            rows: 1,
            chars,
        })
    }

    /// Writes one row of values, one per column; Null leaves the cell empty.
    pub fn row(&mut self, values: &[Cell]) -> Result<()> {
        if self.rows > EXCEL_MAX_DATA_ROWS {
            return Err(invalid_argument(format!(
                "Sheet \"{}\" has more than {} data rows, the most Excel holds under a header row.",
                self.name,
                format_count(EXCEL_MAX_DATA_ROWS)
            )));
        }
        if values.len() != self.columns.len() {
            return Err(invalid_argument(format!(
                "Row {} of sheet \"{}\" has {} values for {} columns.",
                format_count(self.rows + 1),
                self.name,
                values.len(),
                self.columns.len()
            )));
        }
        let r = self.rows;
        let mut xml = format!("<row r=\"{}\">", r + 1);
        for (c, v) in values.iter().enumerate() {
            if matches!(v, Cell::Null) {
                continue;
            }
            let col = &self.columns[c];
            if let Cell::Text(t) = v {
                check_text(t, &self.name, r + 1, &col.header)?;
            }
            let Some((cell, chars)) = cell_out(v, col.kind, &cell_ref(r, c))? else {
                return Err(invalid_argument(format!(
                    "Row {}, column \"{}\" of sheet \"{}\" is a {} column but holds {}.",
                    format_count(r + 1),
                    col.header,
                    self.name,
                    kind_name(col.kind),
                    describe(v)
                )));
            };
            xml.push_str(&cell);
            self.chars[c] = self.chars[c].max(chars);
        }
        xml.push_str("</row>");
        self.out.write_all(xml.as_bytes())?;
        self.rows += 1;
        Ok(())
    }

    pub fn finish(mut self) -> Result<WrittenSheet> {
        self.out.flush()?;
        let filter_ref = if self.auto_filter {
            used_ref(self.columns.len(), self.rows)
        } else {
            None
        };
        Ok(WrittenSheet {
            name: self.name,
            columns: self.columns,
            freeze_header: self.freeze_header,
            body: self.body,
            rows: self.rows,
            chars: self.chars,
            filter_ref,
        })
    }
}

/// The used range: header and data across all columns; None for a sheet without columns.
fn used_ref(columns: usize, rows: u64) -> Option<String> {
    (columns > 0).then(|| format!("A1:{}{rows}", column_name(columns as u32 - 1)))
}

fn width_text(col: &Column, chars: usize) -> String {
    let width = col
        .width
        .unwrap_or_else(|| (chars as f64 + WIDTH_PADDING).clamp(MIN_WIDTH, MAX_WIDTH));
    canonical_number((width * 100.0).round() / 100.0)
}

fn cols_xml(sheet: &WrittenSheet) -> String {
    if sheet.columns.is_empty() {
        return String::new();
    }
    let cols: String = sheet
        .columns
        .iter()
        .enumerate()
        .map(|(c, col)| {
            format!(
                "<col min=\"{n}\" max=\"{n}\" width=\"{}\" customWidth=\"1\"/>",
                width_text(col, sheet.chars.get(c).copied().unwrap_or(0)),
                n = c + 1
            )
        })
        .collect();
    format!("<cols>{cols}</cols>")
}

fn sheet_view_xml(freeze: bool, selected: bool) -> String {
    let tab = if selected { " tabSelected=\"1\"" } else { "" };
    if !freeze {
        return format!("<sheetViews><sheetView{tab} workbookViewId=\"0\"/></sheetViews>");
    }
    format!(
        "<sheetViews><sheetView{tab} workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/><selection pane=\"bottomLeft\" activeCell=\"A2\" sqref=\"A2\"/></sheetView></sheetViews>"
    )
}

// ---------------------------------------------------------------------------------------------
// Package parts

/// The styles part: General, a bold header, whole numbers, and dates ('yyyy-mm-dd') and times
/// ('yyyy-mm-dd hh:mm:ss.000'), formats the reader recognises as dates.
const STYLES_XML: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n",
    "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
    "<numFmts count=\"2\"><numFmt numFmtId=\"164\" formatCode=\"yyyy-mm-dd\"/>",
    "<numFmt numFmtId=\"165\" formatCode=\"yyyy-mm-dd hh:mm:ss.000\"/></numFmts>",
    "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font>",
    "<font><b/><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font></fonts>",
    "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>",
    "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>",
    "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>",
    "<cellXfs count=\"5\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>",
    "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/>",
    "<xf numFmtId=\"1\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>",
    "<xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>",
    "<xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/></cellXfs>",
    "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>",
    "<dxfs count=\"0\"/><tableStyles count=\"0\" defaultTableStyle=\"TableStyleMedium2\" defaultPivotStyle=\"PivotStyleLight16\"/>",
    "</styleSheet>"
);

fn root_rels() -> String {
    format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL_TYPE}/officeDocument\" Target=\"xl/workbook.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"{REL_TYPE}/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>"
    )
}

fn content_types_xml(sheets: usize) -> String {
    let sheet_types: String = (1..=sheets)
        .map(|i| format!("<Override PartName=\"/xl/worksheets/sheet{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"))
        .collect();
    format!(
        "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>{sheet_types}<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/></Types>"
    )
}

/// W3CDTF without milliseconds, the form every spreadsheet program accepts.
fn w3cdtf(iso: &str) -> String {
    format!("{}Z", iso.get(..19).unwrap_or(iso))
}

fn core_xml(created: &str, creator: &str, title: Option<&str>) -> String {
    let when = w3cdtf(created);
    let title = title.map_or_else(String::new, |t| {
        format!("<dc:title>{}</dc:title>", metadata_text(t))
    });
    let creator = metadata_text(creator);
    format!(
        "{XML_DECL}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">{title}<dc:creator>{creator}</dc:creator><cp:lastModifiedBy>{creator}</cp:lastModifiedBy><dcterms:created xsi:type=\"dcterms:W3CDTF\">{when}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{when}</dcterms:modified></cp:coreProperties>"
    )
}

fn app_xml(sheets: &[WrittenSheet]) -> String {
    let names: String = sheets
        .iter()
        .map(|s| format!("<vt:lpstr>{}</vt:lpstr>", xml_attr(&s.name)))
        .collect();
    let n = sheets.len();
    format!(
        "{XML_DECL}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><Application>Tracewell</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size=\"2\" baseType=\"variant\"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>{n}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size=\"{n}\" baseType=\"lpstr\">{names}</vt:vector></TitlesOfParts><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged></Properties>"
    )
}

/// "'Data'!$A$1:$C$10": the absolute reference an autofilter's hidden defined name holds.
fn filter_database_ref(sheet: &str, reference: &str) -> String {
    let mut absolute = String::new();
    let mut in_letters = false;
    let mut in_digits = false;
    for c in reference.chars() {
        if c.is_ascii_uppercase() && !in_letters {
            absolute.push('$');
            in_letters = true;
            in_digits = false;
        } else if c.is_ascii_digit() && !in_digits {
            absolute.push('$');
            in_digits = true;
            in_letters = false;
        } else if !c.is_ascii_alphanumeric() {
            in_letters = false;
            in_digits = false;
        }
        absolute.push(c);
    }
    format!("'{}'!{absolute}", sheet.replace('\'', "''"))
}

fn workbook_xml(sheets: &[WrittenSheet]) -> String {
    let entries: String = sheets
        .iter()
        .enumerate()
        .map(|(i, s)| {
            format!(
                "<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>",
                xml_attr(&s.name),
                n = i + 1
            )
        })
        .collect();
    let names: String = sheets
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            s.filter_ref.as_ref().map(|r| {
                format!(
                    "<definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"{i}\" hidden=\"1\">{}</definedName>",
                    xml_attr(&filter_database_ref(&s.name, r))
                )
            })
        })
        .collect();
    let names = if names.is_empty() {
        String::new()
    } else {
        format!("<definedNames>{names}</definedNames>")
    };
    format!(
        "{XML_DECL}<workbook xmlns=\"{NS_MAIN}\" xmlns:r=\"{NS_REL}\"><workbookPr/><bookViews><workbookView activeTab=\"0\"/></bookViews><sheets>{entries}</sheets>{names}</workbook>"
    )
}

fn workbook_rels_xml(sheets: usize) -> String {
    let mut rels: String = (1..=sheets)
        .map(|i| format!("<Relationship Id=\"rId{i}\" Type=\"{REL_TYPE}/worksheet\" Target=\"worksheets/sheet{i}.xml\"/>"))
        .collect();
    rels.push_str(&format!(
        "<Relationship Id=\"rId{}\" Type=\"{REL_TYPE}/styles\" Target=\"styles.xml\"/>",
        sheets + 1
    ));
    format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{rels}</Relationships>"
    )
}

/// Writes a workbook of written sheets to `out`. The output is byte-identical for identical input.
pub fn write_book(
    out: &Path,
    sheets: &[WrittenSheet],
    created: &str,
    creator: &str,
    title: Option<&str>,
) -> Result<()> {
    if sheets.is_empty() {
        return Err(invalid_argument(
            "A workbook needs at least one sheet.".into(),
        ));
    }
    let valid_time = crate::time::millis_from_iso(created)
        .is_some_and(|ms| crate::time::iso_from_millis(ms) == created);
    if !valid_time {
        return Err(invalid_argument(format!(
            "The creation time \"{created}\" is not an instant written as YYYY-MM-DDTHH:mm:ss.sssZ."
        )));
    }
    let n = sheets.len();
    let mut zip = ZipWriter::create(out)?;
    zip.add_bytes("[Content_Types].xml", content_types_xml(n).as_bytes())?;
    zip.add_bytes("_rels/.rels", root_rels().as_bytes())?;
    zip.add_bytes("docProps/app.xml", app_xml(sheets).as_bytes())?;
    zip.add_bytes(
        "docProps/core.xml",
        core_xml(created, creator, title).as_bytes(),
    )?;
    zip.add_bytes("xl/workbook.xml", workbook_xml(sheets).as_bytes())?;
    zip.add_bytes(
        "xl/_rels/workbook.xml.rels",
        workbook_rels_xml(n).as_bytes(),
    )?;
    zip.add_bytes("xl/styles.xml", STYLES_XML.as_bytes())?;
    for (i, s) in sheets.iter().enumerate() {
        let reference = used_ref(s.columns.len(), s.rows);
        let prefix = format!(
            "{XML_DECL}<worksheet xmlns=\"{NS_MAIN}\" xmlns:r=\"{NS_REL}\"><dimension ref=\"{}\"/>{}<sheetFormatPr defaultRowHeight=\"15\"/>{}<sheetData>",
            reference.as_deref().unwrap_or("A1"),
            sheet_view_xml(s.freeze_header, i == 0),
            cols_xml(s)
        );
        let filter = s
            .filter_ref
            .as_ref()
            .map_or_else(String::new, |r| format!("<autoFilter ref=\"{r}\"/>"));
        let suffix = format!(
            "</sheetData>{filter}<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/></worksheet>"
        );
        zip.add_parts(
            &format!("xl/worksheets/sheet{}.xml", i + 1),
            &[
                Part::Bytes(prefix.as_bytes()),
                Part::File(&s.body),
                Part::Bytes(suffix.as_bytes()),
            ],
        )?;
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_text_as_spreadsheet_ml_requires() {
        assert_eq!(xml_text("plain"), "plain");
        assert_eq!(xml_text("a<b & c>d"), "a&lt;b &amp; c&gt;d");
        assert_eq!(xml_text("x\ry\tz"), "x_x000D_y\tz");
        assert_eq!(xml_text("_x0041_ and _y"), "_x005F_x0041_ and _y");
        assert_eq!(xml_attr("a\"b\tc\n"), "a&quot;b&#9;c&#10;");
        assert_eq!(metadata_text("a\u{1}b"), "a\u{FFFD}b");
        assert_eq!(number_text(1.5e21), "1.5E+21");
        assert_eq!(filter_database_ref("Data", "A1:E13"), "'Data'!$A$1:$E$13");
        assert_eq!(filter_database_ref("It's", "A1:AB7"), "'It''s'!$A$1:$AB$7");
    }

    #[test]
    fn writes_a_workbook_the_reader_reads_back_cell_for_cell() {
        use crate::parse::Raw;
        let dir = std::env::temp_dir().join(format!("tw-xlsx-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let column = |header: &str, kind| Column {
            header: header.into(),
            kind,
            width: None,
        };
        let mut data = SheetWriter::create(
            &dir.join("data.xml"),
            "Data",
            vec![
                column("Well", Kind::String),
                column("Rate [bbl/d]", Kind::Number),
                column("Count", Kind::Integer),
                column("Ok", Kind::Boolean),
                column("Day", Kind::Date),
                column("At", Kind::DateTime),
            ],
            true,
            true,
        )
        .unwrap();
        let day = crate::time::days_from_civil(2026, 3, 1);
        data.row(&[
            Cell::Text(" A_x0041_ <1>\r".into()),
            Cell::Num(1250.5),
            Cell::Num(3.0),
            Cell::Bool(true),
            Cell::Date(day),
            Cell::DateTime(day * MS_PER_DAY + 3_723_004),
        ])
        .unwrap();
        data.row(&[
            Cell::Null,
            Cell::Num(-0.25),
            Cell::Null,
            Cell::Bool(false),
            Cell::Null,
            Cell::Null,
        ])
        .unwrap();
        let mismatch = data.row(&[
            Cell::Num(1.0),
            Cell::Null,
            Cell::Null,
            Cell::Null,
            Cell::Null,
            Cell::Null,
        ]);
        assert!(
            mismatch
                .unwrap_err()
                .message
                .contains("is a string column but holds a number")
        );
        let data = data.finish().unwrap();
        let note = SheetWriter::create(
            &dir.join("note.xml"),
            "Report",
            vec![column("Item", Kind::String)],
            true,
            false,
        )
        .unwrap()
        .finish()
        .unwrap();
        let book = dir.join("book.xlsx");
        write_book(
            &book,
            &[data, note],
            "2026-03-01T09:00:00.000Z",
            "Prasad",
            Some("Wells"),
        )
        .unwrap();

        let mut read = crate::xlsx::open(&book).unwrap();
        assert_eq!(
            read.sheets,
            vec![
                ("Data".to_string(), "visible"),
                ("Report".to_string(), "visible")
            ]
        );
        let sheet = read.read_sheet("Data").unwrap();
        assert_eq!(sheet.frozen, Some((1, 0)));
        assert_eq!(
            sheet.auto_filter.map(|f| crate::xlsx::format_range(&f)),
            Some("A1:F3".into())
        );
        assert_eq!(sheet.dimension, "A1:F3");
        let row = |r: usize| {
            sheet.rows[r]
                .cells
                .iter()
                .map(|c| (c.v.clone(), c.t, c.is_date))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            sheet.rows[0]
                .cells
                .iter()
                .map(|c| c.v.text())
                .collect::<Vec<_>>(),
            ["Well", "Rate [bbl/d]", "Count", "Ok", "Day", "At"]
        );
        assert_eq!(
            row(1),
            vec![
                (Raw::Text(" A_x0041_ <1>\r".into()), "inlineStr", false),
                (Raw::Number(1250.5), "n", false),
                (Raw::Number(3.0), "n", false),
                (Raw::Bool(true), "b", false),
                (Raw::Date("2026-03-01".into()), "n", true),
                (Raw::DateTime("2026-03-01T01:02:03.004Z".into()), "n", true),
            ]
        );
        assert_eq!(
            row(2),
            vec![
                (Raw::Number(-0.25), "n", false),
                (Raw::Bool(false), "b", false)
            ]
        );
        let report = read.read_sheet("Report").unwrap();
        assert_eq!(report.frozen, Some((1, 0)));
        assert_eq!(report.auto_filter, None);
        let workbook = {
            let entries = crate::zip::read_entries(&book).unwrap();
            let e = entries
                .iter()
                .find(|e| e.name == "xl/workbook.xml")
                .unwrap();
            let mut out = Vec::new();
            crate::zip::read_entry(&book, e, &mut |b| {
                out.extend_from_slice(b);
                Ok(())
            })
            .unwrap();
            String::from_utf8(out).unwrap()
        };
        assert!(workbook.contains("<definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"0\" hidden=\"1\">'Data'!$A$1:$F$3</definedName>"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stores_dates_as_1900_serials() {
        let day = |y, m, d| crate::time::days_from_civil(y, m, d);
        assert_eq!(
            serial(day(1900, 1, 1) * MS_PER_DAY, String::new).unwrap(),
            1.0
        );
        assert_eq!(
            serial(day(1900, 2, 28) * MS_PER_DAY, String::new).unwrap(),
            59.0
        );
        assert_eq!(
            serial(day(1900, 3, 1) * MS_PER_DAY, String::new).unwrap(),
            61.0
        );
        assert_eq!(
            serial(day(2023, 3, 15) * MS_PER_DAY, String::new).unwrap(),
            45000.0
        );
        assert_eq!(
            serial(day(2023, 3, 15) * MS_PER_DAY + MS_PER_DAY / 2, String::new).unwrap(),
            45000.5
        );
        let early = serial(day(1899, 12, 1) * MS_PER_DAY, || "1899-12-01".into()).unwrap_err();
        assert_eq!(early.code, "INVALID_INPUT");
        assert!(early.message.contains("1899-12-01"));
    }
}
