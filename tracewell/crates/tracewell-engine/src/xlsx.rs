//! Excel workbooks (src/formats/xlsx): an .xlsx package or a legacy .xls (Excel 97-2003) is read
//! into sheets of typed cells, layout detection finds the tables in a sheet, and the chosen
//! table's data rows are read as rows of raw fields, each with its 1-based sheet row as locator.
//!
//! The first visible sheet that holds a table, and that sheet's first table, are imported unless
//! the settings choose others. A value merged across several data cells is repeated in each of
//! them, as the sheet shows it; fully blank rows inside a table are skipped. The workbook is read
//! in memory, as the TypeScript reader reads it, under a cap on what an .xlsx package may expand to.

mod book;
mod layout;
mod legacy;
mod xml;

use crate::csv::Note;
use crate::detect::det;
use crate::error::{EngineError, Result};
use crate::parse::Raw;
use serde_json::{Value, json};
use std::path::Path;

use layout::Grid;

// ---------------------------------------------------------------------------------------------
// The workbook model (types.ts)

/// A rectangle of cells, 0-based and inclusive at both ends (A1:B2 is s (0, 0), e (1, 1)).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellRange {
    pub sr: u32,
    pub sc: u32,
    pub er: u32,
    pub ec: u32,
}

impl CellRange {
    pub fn contains(&self, r: u32, c: u32) -> bool {
        r >= self.sr && r <= self.er && c >= self.sc && c <= self.ec
    }
}

/// A cell that holds a value or a formula. Formula cells hold the result their producer cached;
/// a formula without one has the value Null.
#[derive(Clone, Debug)]
pub struct Cell {
    /// 0-based column.
    pub c: u32,
    pub v: Raw,
    pub formula: bool,
}

#[derive(Clone, Debug)]
pub struct Row {
    /// 0-based sheet row.
    pub r: u32,
    /// The cells that hold a value or a formula, in column order.
    pub cells: Vec<Cell>,
}

#[derive(Clone, Debug)]
pub struct Sheet {
    pub name: String,
    /// 'visible', 'hidden' or 'veryHidden'.
    pub state: &'static str,
    /// The used range of the cells that hold a value, e.g. 'A1:F120'; 'A1' for an empty sheet.
    pub dimension: String,
    pub merges: Vec<CellRange>,
    /// Rows that hold at least one cell, in row order.
    pub rows: Vec<Row>,
}

impl Sheet {
    fn empty(name: &str, state: &'static str) -> Sheet {
        Sheet {
            name: name.to_string(),
            state,
            dimension: "A1".into(),
            merges: Vec::new(),
            rows: Vec::new(),
        }
    }
}

pub fn sheet_state(value: Option<&str>) -> &'static str {
    match value {
        Some("hidden") => "hidden",
        Some("veryHidden") => "veryHidden",
        _ => "visible",
    }
}

/// The used range of the cells that hold a value; 'A1' when there are none.
fn used_range(rows: &[Row]) -> String {
    let mut range: Option<CellRange> = None;
    for row in rows {
        for cell in &row.cells {
            if matches!(cell.v, Raw::Null) {
                continue;
            }
            let r = range.get_or_insert(CellRange {
                sr: row.r,
                sc: cell.c,
                er: row.r,
                ec: cell.c,
            });
            r.sr = r.sr.min(row.r);
            r.er = r.er.max(row.r);
            r.sc = r.sc.min(cell.c);
            r.ec = r.ec.max(cell.c);
        }
    }
    range.map_or_else(|| "A1".to_string(), |r| format_range(&r))
}

/// An open workbook: its sheets in workbook order and its date system.
pub struct Workbook {
    pub sheets: Vec<(String, &'static str)>,
    pub date1904: bool,
    kind: Kind,
}

enum Kind {
    Package(book::Package),
    Legacy(legacy::LegacyBook),
}

impl Workbook {
    /// Parses one sheet; NOT_FOUND for a name the workbook does not have.
    pub fn read_sheet(&mut self, name: &str) -> Result<Sheet> {
        if !self.sheets.iter().any(|(n, _)| n == name) {
            let names: Vec<String> = self
                .sheets
                .iter()
                .map(|(n, _)| format!("\"{n}\""))
                .collect();
            return Err(EngineError::not_found(
                format!("The workbook has no sheet named \"{name}\"."),
                format!("Choose one of the workbook's sheets: {}.", names.join(", ")),
            ));
        }
        let date1904 = self.date1904;
        match &mut self.kind {
            Kind::Package(p) => p.read_sheet(name, date1904),
            Kind::Legacy(b) => b.read_sheet(name),
        }
    }
}

/// Opens an Excel workbook: an .xlsx package, or a legacy .xls in an OLE compound file.
pub fn open(path: &Path) -> Result<Workbook> {
    let mut head = [0u8; 8];
    let n = {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let mut n = 0;
        while n < head.len() {
            let got = f.read(&mut head[n..])?;
            if got == 0 {
                break;
            }
            n += got;
        }
        n
    };
    if n == 8 && head == legacy::SIGNATURE && std::fs::metadata(path)?.len() >= 512 {
        let book = legacy::open(&std::fs::read(path)?)?;
        return Ok(Workbook {
            sheets: book.sheets(),
            date1904: book.date1904,
            kind: Kind::Legacy(book),
        });
    }
    let (package, sheets, date1904) = book::open(path)?;
    Ok(Workbook {
        sheets,
        date1904,
        kind: Kind::Package(package),
    })
}

/// True when the file is a legacy .xls (an OLE compound file) rather than an .xlsx package.
pub fn is_legacy(head: &[u8]) -> bool {
    head.starts_with(&legacy::SIGNATURE)
}

// ---------------------------------------------------------------------------------------------
// Errors (errors.ts)

const DAMAGED_FIX: &str = "Open the file in Excel or LibreOffice and save it again as an Excel workbook (.xlsx), then import the new copy.";

/// The workbook's content cannot be read: broken XML, a missing part or an impossible value.
pub fn damaged(message: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "PARSE_FAILED",
        format!("The workbook cannot be read: {message}"),
        DAMAGED_FIX,
    )
}

pub fn not_a_workbook(message: impl Into<String>, fix: impl Into<String>) -> EngineError {
    EngineError::new("FORMAT_UNSUPPORTED", message, fix)
}

/// A caller passed an argument that no correct program passes.
fn invalid_argument(message: impl Into<String>) -> EngineError {
    EngineError::new(
        "INVALID_INPUT",
        message,
        "Correct the value passed to the function; this is a defect in the calling code, not in the data.",
    )
}

// ---------------------------------------------------------------------------------------------
// References (refs.ts)

const MAX_ROWS: u32 = 1_048_576;
const MAX_COLS: u32 = 16_384;

/// 0 -> 'A', 25 -> 'Z', 26 -> 'AA'.
pub fn column_name(c: u32) -> String {
    let mut name = Vec::new();
    let mut n = c as u64 + 1;
    while n > 0 {
        name.push(b'A' + ((n - 1) % 26) as u8);
        n = (n - 1) / 26;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}

/// 'A' -> 0, 'aa' -> 26; None when the letters name no column of the grid.
fn column_index(letters: &str) -> Option<u32> {
    if letters.is_empty() || letters.len() > 3 || !letters.bytes().all(|b| b.is_ascii_alphabetic())
    {
        return None;
    }
    let n = letters.bytes().fold(0u32, |n, b| {
        n * 26 + (b.to_ascii_uppercase() - b'A' + 1) as u32
    });
    (n <= MAX_COLS).then(|| n - 1)
}

fn format_cell_ref(r: u32, c: u32) -> String {
    format!("{}{}", column_name(c), r as u64 + 1)
}

/// 'B3' or '$B$3' -> (2, 1); None when the text is not a reference inside the grid.
pub fn parse_cell_ref(text: &str) -> Option<(u32, u32)> {
    let t = text.strip_prefix('$').unwrap_or(text);
    let split = t.find(|ch: char| !ch.is_ascii_alphabetic())?;
    let (letters, rest) = t.split_at(split);
    let digits = rest.strip_prefix('$').unwrap_or(rest);
    let valid = !digits.is_empty()
        && digits.len() <= 7
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !digits.starts_with('0');
    if !valid || letters.is_empty() || letters.len() > 3 {
        return None;
    }
    let c = column_index(letters)?;
    let r = digits.parse::<u32>().ok()? - 1;
    (r < MAX_ROWS).then_some((r, c))
}

/// 'A1:C3', '$A$1:$C$3' or a single cell 'B2', corners put in order; None when not a range.
pub fn parse_range(text: &str) -> Option<CellRange> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.len() > 2 {
        return None;
    }
    let a = parse_cell_ref(parts[0])?;
    let b = if parts.len() == 2 {
        parse_cell_ref(parts[1])?
    } else {
        a
    };
    Some(CellRange {
        sr: a.0.min(b.0),
        sc: a.1.min(b.1),
        er: a.0.max(b.0),
        ec: a.1.max(b.1),
    })
}

/// A single cell is written as 'B2', anything larger as 'A1:C3'.
pub fn format_range(r: &CellRange) -> String {
    let start = format_cell_ref(r.sr, r.sc);
    if r.sr == r.er && r.sc == r.ec {
        start
    } else {
        format!("{start}:{}", format_cell_ref(r.er, r.ec))
    }
}

// ---------------------------------------------------------------------------------------------
// The importer (importer.ts)

/// Rows in a preview sample.
const SAMPLE_ROWS: usize = 1000;
/// Cells filled from merged data ranges; beyond this a merge keeps its value in its first cell only.
const MAX_MERGE_FILL_CELLS: i64 = 5_000_000;

struct SheetLayout {
    grid: Grid,
    tables: Vec<layout::TableBlock>,
}

impl SheetLayout {
    fn sheet(&self) -> &Sheet {
        &self.grid.sheet
    }
}

fn layout_of(book: &mut Workbook, name: &str) -> Result<SheetLayout> {
    let grid = Grid::new(book.read_sheet(name)?);
    let tables = layout::tables_in(&grid);
    Ok(SheetLayout { grid, tables })
}

fn sheet_info(l: &SheetLayout) -> Value {
    let tables: Vec<Value> = l
        .tables
        .iter()
        .map(|t| {
            json!({
                "range": format_range(&t.range),
                "headerRows": t.header_rows.1 - t.header_rows.0 + 1,
            })
        })
        .collect();
    json!({
        "name": l.sheet().name,
        "state": l.sheet().state,
        "dimension": l.sheet().dimension,
        "tables": tables,
    })
}

/// The first visible sheet with a table, else the first visible sheet with any value, else the
/// first sheet.
fn default_sheet(layouts: &[SheetLayout]) -> Option<usize> {
    let visible: Vec<usize> = (0..layouts.len())
        .filter(|&i| layouts[i].sheet().state == "visible")
        .collect();
    visible
        .iter()
        .find(|&&i| !layouts[i].tables.is_empty())
        .or_else(|| {
            visible
                .iter()
                .find(|&&i| !layouts[i].sheet().rows.is_empty())
        })
        .or(visible.first())
        .copied()
        .or(if layouts.is_empty() { None } else { Some(0) })
}

// Detections. The keys follow the CSV importer where they mean the same thing: skipLines is the
// 0-based sheet row of the first header row and headerRows counts every header row, a units row
// included.

fn sheet_detection(chosen: usize, layouts: &[SheetLayout]) -> Value {
    let name = &layouts[chosen].sheet().name;
    if layouts.len() == 1 {
        return det(
            json!(name),
            "high",
            "only-sheet",
            format!("The workbook has one sheet, \"{name}\"."),
            false,
        );
    }
    let others: Vec<String> = layouts
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != chosen)
        .map(|(_, l)| {
            let s = l.sheet();
            if s.state == "visible" {
                format!("\"{}\"", s.name)
            } else {
                format!("\"{}\" ({})", s.name, s.state)
            }
        })
        .collect();
    let others = others.join(", ");
    if layouts[chosen].tables.is_empty() {
        return det(
            json!(name),
            "low",
            "no-table",
            format!("No visible sheet holds a table; the workbook also has {others}."),
            true,
        );
    }
    let rivals = layouts
        .iter()
        .enumerate()
        .filter(|(i, l)| *i != chosen && l.sheet().state == "visible" && !l.tables.is_empty())
        .count();
    if rivals == 0 {
        // Hidden sheets are left out on purpose: they usually hold settings or lookups.
        return det(
            json!(name),
            "high",
            "only-visible-sheet-with-table",
            format!(
                "\"{name}\" is the only visible sheet that holds a table; the workbook also has {others}."
            ),
            false,
        );
    }
    det(
        json!(name),
        "medium",
        "first-visible-sheet-with-table",
        format!(
            "\"{name}\" is the first of {} visible sheets that hold a table; the workbook also has {others}.",
            rivals + 1
        ),
        false,
    )
}

fn no_table_detections(name: &str) -> Vec<(String, Value)> {
    let evidence = format!("Sheet \"{name}\" holds no table.");
    ["tableIndex", "skipLines", "headerRows"]
        .iter()
        .map(|k| {
            (
                k.to_string(),
                det(json!(0), "low", "no-table", evidence.clone(), true),
            )
        })
        .collect()
}

/// The first table, top-left, is imported; the TW-IMP-002 note on every other table asks the
/// user to check the choice, so it is not also an assumed detection.
fn table_index_detection(chosen: &SheetLayout, table: &layout::TableBlock) -> Value {
    let name = &chosen.sheet().name;
    let range = format_range(&table.range);
    if chosen.tables.len() == 1 {
        return det(
            json!(0),
            "high",
            "only-table",
            format!("The table at {range} is the only one in sheet \"{name}\"."),
            false,
        );
    }
    let others: Vec<String> = chosen.tables[1..]
        .iter()
        .map(|t| format_range(&t.range))
        .collect();
    det(
        json!(0),
        "high",
        "first-table",
        format!(
            "Sheet \"{name}\" holds {} tables; the first, at {range}, is imported and TW-IMP-002 names the others ({}).",
            chosen.tables.len(),
            others.join(", ")
        ),
        false,
    )
}

fn skip_lines_detection(grid: &Grid, table: &layout::TableBlock) -> Value {
    let top = table.header_rows.0;
    if top == 0 {
        return det(
            json!(0),
            "high",
            "table-block",
            "The header is on the first row of the sheet.",
            false,
        );
    }
    let above = grid
        .rows_in(0, top - 1, table.range.sc, table.range.ec)
        .len();
    let what = if above == 0 {
        "blank".to_string()
    } else {
        format!("blank or titles ({above} with text)")
    };
    det(
        json!(top),
        "high",
        "table-block",
        format!(
            "The header starts on row {}; the rows above it are {what}.",
            top + 1
        ),
        false,
    )
}

fn header_rows_detection(table: &layout::TableBlock) -> Value {
    let (first, last) = table.header_rows;
    let rows = last - first + 1;
    if rows == 1 {
        return det(
            json!(1),
            "high",
            "single-header-row",
            format!("Row {} holds the column names.", first + 1),
            false,
        );
    }
    // Layout detection only extends a header on structural evidence, so a multi-row header is as
    // certain as a single one.
    det(
        json!(rows),
        "high",
        "merged-or-units-header",
        format!(
            "Rows {} to {} form the header (merged cells or a units row); they were joined into one row of names.",
            first + 1,
            last + 1
        ),
        false,
    )
}

fn table_detections(
    chosen: &SheetLayout,
    table: Option<&layout::TableBlock>,
) -> Vec<(String, Value)> {
    let Some(table) = table else {
        return no_table_detections(&chosen.sheet().name);
    };
    vec![
        ("tableIndex".into(), table_index_detection(chosen, table)),
        (
            "tableRange".into(),
            det(
                json!(format_range(&table.range)),
                "high",
                "blank-row-column-blocks",
                format!(
                    "The table spans {}, bounded by blank rows and columns; its data starts on row {}.",
                    format_range(&table.range),
                    table.data_start_row + 1
                ),
                false,
            ),
        ),
        (
            "skipLines".into(),
            skip_lines_detection(&chosen.grid, table),
        ),
        ("headerRows".into(), header_rows_detection(table)),
    ]
}

fn date1904_detection(date1904: bool) -> Value {
    let evidence = if date1904 {
        "The workbook uses the 1904 date system (workbookPr date1904)."
    } else {
        "The workbook uses the 1900 date system."
    };
    det(
        json!(date1904),
        "high",
        "workbook-property",
        evidence,
        false,
    )
}

// Rows

/// The header rows and columns to read and where the table ends; lastCol may be firstCol - 1.
#[derive(Clone, Copy, Debug)]
pub struct Chosen {
    pub header_row_start: i64,
    pub header_row_end: i64,
    pub data_start_row: i64,
    pub first_col: i64,
    pub last_col: i64,
    pub last_row: i64,
}

struct Fill {
    c1: i64,
    c2: i64,
    v: Raw,
}

/// Values of merged ranges that start in the data area, by data row, clipped to the table.
fn merge_fills(grid: &Grid, chosen: &Chosen) -> std::collections::HashMap<u32, Vec<Fill>> {
    let mut fills: std::collections::HashMap<u32, Vec<Fill>> = std::collections::HashMap::new();
    let mut budget = MAX_MERGE_FILL_CELLS;
    for m in &grid.sheet.merges {
        let (sr, er, sc, ec) = (m.sr as i64, m.er as i64, m.sc as i64, m.ec as i64);
        if sr < chosen.data_start_row || sr > chosen.last_row {
            continue;
        }
        if ec < chosen.first_col || sc > chosen.last_col {
            continue;
        }
        let v = grid.value(m.sr, m.sc).clone();
        let r2 = er.min(chosen.last_row);
        let (c1, c2) = (sc.max(chosen.first_col), ec.min(chosen.last_col));
        budget -= (r2 - sr + 1) * (c2 - c1 + 1);
        if layout::is_blank(&v) || budget < 0 {
            continue;
        }
        for r in sr..=r2 {
            fills.entry(r as u32).or_default().push(Fill {
                c1,
                c2,
                v: v.clone(),
            });
        }
    }
    fills
}

/// The data rows of the chosen table, with their 1-based sheet rows; `take` answers false to stop.
fn table_rows(
    grid: &Grid,
    chosen: &Chosen,
    take: &mut dyn FnMut(u64, Vec<Raw>) -> Result<bool>,
) -> Result<()> {
    let width = chosen.last_col - chosen.first_col + 1;
    if width <= 0 {
        return Ok(());
    }
    let fills = merge_fills(grid, chosen);
    for row in &grid.sheet.rows {
        let r = row.r as i64;
        if r < chosen.data_start_row || r > chosen.last_row {
            continue;
        }
        let mut fields = vec![Raw::Null; width as usize];
        for cell in &row.cells {
            let c = cell.c as i64;
            if c >= chosen.first_col && c <= chosen.last_col {
                fields[(c - chosen.first_col) as usize] = cell.v.clone();
            }
        }
        for fill in fills.get(&row.r).map(Vec::as_slice).unwrap_or(&[]) {
            for c in fill.c1..=fill.c2 {
                fields[(c - chosen.first_col) as usize] = fill.v.clone();
            }
        }
        if !fields.iter().all(layout::is_blank) && !take(r as u64 + 1, fields)? {
            return Ok(());
        }
    }
    Ok(())
}

// Options

fn chosen_from_table(table: &layout::TableBlock) -> Chosen {
    Chosen {
        header_row_start: table.header_rows.0 as i64,
        header_row_end: table.header_rows.1 as i64,
        data_start_row: table.data_start_row as i64,
        first_col: table.range.sc as i64,
        last_col: table.range.ec as i64,
        last_row: table.range.er as i64,
    }
}

/// Options for a sheet without tables: no columns, so no rows.
fn empty_chosen() -> Chosen {
    Chosen {
        header_row_start: 0,
        header_row_end: 0,
        data_start_row: 1,
        first_col: 0,
        last_col: -1,
        last_row: 0,
    }
}

fn to_options(sheet: &str, table_index: u64, c: &Chosen) -> Value {
    json!({
        "format": "xlsx",
        "xlsx": {
            "sheet": sheet,
            "tableIndex": table_index,
            "headerRowStart": c.header_row_start,
            "headerRowEnd": c.header_row_end,
            "dataStartRow": c.data_start_row,
            "firstCol": c.first_col,
            "lastCol": c.last_col,
        },
    })
}

/// The XLSX options of an import, checked as xlsxOptionsOf checks them.
pub struct Options {
    pub sheet: String,
    pub table_index: usize,
    pub header_row_start: i64,
    pub header_row_end: i64,
    pub data_start_row: i64,
    pub first_col: i64,
    pub last_col: i64,
}

/// A JSON number that is a whole number JavaScript holds exactly.
fn safe_integer(v: &Value) -> Option<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= MAX_SAFE).then_some(n as i64)
}

pub fn options_of(options: &Value) -> Result<Options> {
    let format = options["format"].as_str().unwrap_or("");
    if format != "xlsx" {
        return Err(invalid_argument(format!(
            "The XLSX reader was given options for the format \"{format}\"."
        )));
    }
    let o = &options["xlsx"];
    let whole = |k: &str| safe_integer(&o[k]).filter(|n| *n >= 0);
    let fields = (
        whole("tableIndex"),
        whole("headerRowStart"),
        whole("headerRowEnd"),
        whole("dataStartRow"),
        whole("firstCol"),
        safe_integer(&o["lastCol"]),
    );
    let refuse = || {
        invalid_argument(
            "The XLSX options must give whole, 0-based rows and columns with the header before the data and the last column not before the first.",
        )
    };
    let (Some(table_index), Some(start), Some(end), Some(data), Some(first), Some(last)) = fields
    else {
        return Err(refuse());
    };
    if last < first - 1 || end < start || data <= end {
        return Err(refuse());
    }
    Ok(Options {
        sheet: o["sheet"].as_str().unwrap_or("").to_string(),
        table_index: table_index as usize,
        header_row_start: start,
        header_row_end: end,
        data_start_row: data,
        first_col: first,
        last_col: last,
    })
}

/// The rows and columns to read: the options' header, data start and columns, ending where the
/// chosen table ends (or at the sheet's last row when the sheet has no such table).
fn chosen_from_options(o: &Options, l: &SheetLayout) -> Chosen {
    let last_sheet_row = l.sheet().rows.last().map_or(0, |r| r.r as i64);
    Chosen {
        header_row_start: o.header_row_start,
        header_row_end: o.header_row_end,
        data_start_row: o.data_start_row,
        first_col: o.first_col,
        last_col: o.last_col,
        last_row: l
            .tables
            .get(o.table_index)
            .map_or(last_sheet_row, |t| t.range.er as i64),
    }
}

/// TW-IMP-003 for the chosen header and TW-IMP-002 for each table that is not imported.
fn notes_for(l: &SheetLayout, chosen: &Chosen, table_index: usize) -> Vec<Note> {
    if chosen.last_col < chosen.first_col {
        return Vec::new();
    }
    let name = &l.sheet().name;
    let block = layout::block_for(&l.grid, chosen);
    let mut notes = layout::header_notes(name, &block);
    for (i, t) in l.tables.iter().enumerate() {
        if i != table_index {
            notes.push(layout::other_table_note(name, t, &block));
        }
    }
    notes
}

/// What a workbook's preview holds (SniffResult for 'xlsx').
pub struct Sniff {
    pub options: Value,
    pub detections: Vec<(String, Value)>,
    pub header: Vec<Vec<String>>,
    pub rows: Vec<(u64, Vec<Raw>)>,
    pub sheets: Vec<Value>,
    pub notes: Vec<Note>,
}

pub fn sniff(path: &Path) -> Result<Sniff> {
    let mut book = open(path)?;
    let names: Vec<String> = book.sheets.iter().map(|(n, _)| n.clone()).collect();
    let layouts = names
        .iter()
        .map(|n| layout_of(&mut book, n))
        .collect::<Result<Vec<_>>>()?;
    let chosen =
        default_sheet(&layouts).ok_or_else(|| invalid_argument("The workbook has no sheets."))?;
    let l = &layouts[chosen];
    let table = l.tables.first();
    let rows = table.map_or_else(empty_chosen, chosen_from_table);
    let mut sample = Vec::new();
    table_rows(&l.grid, &rows, &mut |loc, fields| {
        if sample.len() >= SAMPLE_ROWS {
            return Ok(false);
        }
        sample.push((loc, fields));
        Ok(true)
    })?;
    let mut detections = vec![("sheet".to_string(), sheet_detection(chosen, &layouts))];
    detections.extend(table_detections(l, table));
    detections.push(("date1904".into(), date1904_detection(book.date1904)));
    Ok(Sniff {
        options: to_options(&l.sheet().name, 0, &rows),
        detections,
        header: table.map_or_else(Vec::new, |t| vec![t.flattened_header.clone()]),
        rows: sample,
        sheets: layouts.iter().map(sheet_info).collect(),
        notes: if table.is_some() {
            notes_for(l, &rows, 0)
        } else {
            Vec::new()
        },
    })
}

fn chosen_by_user(value: Value) -> Value {
    json!({
        "value": value,
        "confidence": "high",
        "assumed": false,
        "source": "user",
        "method": "user-override",
        "evidence": "Chosen by the user in the import settings.",
    })
}

/// The preview of a workbook read with settings the user chose (sniffXlsxWith; `base` is its
/// default preview). Choosing another sheet or table reads that table as layout detection found
/// it, its header rows and columns included; header rows and columns given for the detected sheet
/// and table are taken as given. The header is the flattened one the import's TW-IMP-003 note names.
pub fn sniff_with(path: &Path, options: &Value, base: &Sniff) -> Result<Sniff> {
    let o = options_of(options)?;
    let mut book = open(path)?;
    let l = layout_of(&mut book, &o.sheet)?;
    let before = &base.options["xlsx"];
    let same_sheet = before["sheet"].as_str() == Some(o.sheet.as_str());
    let same_table = same_sheet && before["tableIndex"].as_u64() == Some(o.table_index as u64);
    let table = l.tables.get(o.table_index);
    let rows = if same_table {
        chosen_from_options(&o, &l)
    } else {
        table.map_or_else(empty_chosen, chosen_from_table)
    };
    let mut sample = Vec::new();
    table_rows(&l.grid, &rows, &mut |loc, fields| {
        if sample.len() >= SAMPLE_ROWS {
            return Ok(false);
        }
        sample.push((loc, fields));
        Ok(true)
    })?;
    let base_detection = |k: &str| {
        base.detections
            .iter()
            .find(|(name, _)| name == k)
            .map(|(_, d)| d.clone())
    };
    let detections = if same_table {
        base.detections.clone()
    } else {
        let sheet = if same_sheet {
            base_detection("sheet")
        } else {
            None
        };
        let mut d = vec![
            (
                "sheet".to_string(),
                sheet.unwrap_or_else(|| chosen_by_user(json!(o.sheet))),
            ),
            (
                "tableIndex".to_string(),
                chosen_by_user(json!(o.table_index)),
            ),
        ];
        d.extend(
            table_detections(&l, table)
                .into_iter()
                .filter(|(k, _)| k != "tableIndex"),
        );
        if let Some(date1904) = base_detection("date1904") {
            d.push(("date1904".into(), date1904));
        }
        d
    };
    let has_columns = rows.last_col >= rows.first_col;
    let header = match (has_columns, table) {
        (false, _) => Vec::new(),
        (true, Some(t)) if !same_table => vec![t.flattened_header.clone()],
        (true, _) => vec![layout::block_for(&l.grid, &rows).flattened_header],
    };
    Ok(Sniff {
        options: to_options(&o.sheet, o.table_index as u64, &rows),
        detections,
        header,
        rows: sample,
        sheets: base.sheets.clone(),
        notes: if has_columns {
            notes_for(&l, &rows, o.table_index)
        } else {
            Vec::new()
        },
    })
}

/// Reads the rows the options choose, handing each to `take` with its 1-based sheet row until
/// `take` answers false; returns the notes on the import (TW-IMP-002 and TW-IMP-003).
pub fn read(
    path: &Path,
    options: &Value,
    take: &mut dyn FnMut(u64, Vec<Raw>) -> Result<bool>,
) -> Result<Vec<Note>> {
    let o = options_of(options)?;
    let mut book = open(path)?;
    let l = layout_of(&mut book, &o.sheet)?;
    let chosen = chosen_from_options(&o, &l);
    let notes = notes_for(&l, &chosen, o.table_index);
    table_rows(&l.grid, &chosen, take)?;
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_cell_references() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(16_383), "XFD");
        assert_eq!(parse_cell_ref("B3"), Some((2, 1)));
        assert_eq!(parse_cell_ref("$b$3"), Some((2, 1)));
        assert_eq!(parse_cell_ref("XFE1"), None);
        assert_eq!(parse_cell_ref("A0"), None);
        assert_eq!(parse_cell_ref("A1048577"), None);
        assert_eq!(
            parse_range("C3:A1").map(|r| format_range(&r)),
            Some("A1:C3".into())
        );
        assert_eq!(
            parse_range("B2").map(|r| format_range(&r)),
            Some("B2".into())
        );
        assert_eq!(parse_range("A1:B2:C3"), None);
    }
}
