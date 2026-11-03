//! Layout detection (grid.ts, unit-text.ts and layout.ts): where the tables are in a sheet and
//! which rows are their header.
//!
//!   1. Blocks. Occupied cells are cut into blocks along fully blank rows and columns, repeatedly
//!      (a recursive XY cut). A block that starts with numbers, dates or booleans right under a
//!      table with the same columns, after at most two blank rows, continues that table.
//!   2. Titles. Rows at the top of a block with a single text cell at its left edge (or merged
//!      across its full width) are titles, not header rows. Blocks with fewer than two other rows
//!      are notes.
//!   3. Header. The first remaining row is the header. It grows downwards while a merged header
//!      cell reaches into the next row, or while a group header merged across columns has
//!      sub-headers under it (at most three rows of names). A row of units right under it joins
//!      it too.
//!   4. Names. Each column's header parts are joined with ' / ' and its unit appended in
//!      brackets, so a merged two-row header with a units row gives 'Pressure / Max [psi]'.

use super::{CellRange, Chosen, Sheet, format_range};
use crate::csv::Note;
use crate::parse::Raw;
use serde_json::json;
use std::collections::{BTreeSet, HashMap};

// ---------------------------------------------------------------------------------------------
// The grid (grid.ts)

/// Merged ranges larger than this are not filled in, so one huge merge cannot exhaust memory.
const MAX_MERGE_FILL_CELLS: i64 = 100_000;

/// Empty cells and text that is only white space carry no data.
pub fn is_blank(v: &Raw) -> bool {
    match v {
        Raw::Null => true,
        Raw::Text(t) => t.trim_matches(crate::units::is_js_space).is_empty(),
        _ => false,
    }
}

/// Runs of consecutive integers in an ascending list: [1, 2, 3, 7, 8] -> [(1, 3), (7, 8)].
fn runs(sorted: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for &n in sorted {
        match out.last_mut() {
            Some(last) if n == last.1 + 1 => last.1 = n,
            _ => out.push((n, n)),
        }
    }
    out
}

/// Random access to a parsed sheet: values by position, merged ranges, and which cells are
/// occupied. A merged range counts as occupied in full when its top-left cell holds a value.
pub struct Grid {
    pub sheet: Sheet,
    /// Rows with at least one occupied cell, ascending.
    occupied_rows: Vec<u32>,
    /// Row index in sheet.rows by row number.
    rows: HashMap<u32, usize>,
    occupied: HashMap<u32, Vec<u32>>,
}

impl Grid {
    pub fn new(sheet: Sheet) -> Grid {
        let rows: HashMap<u32, usize> = sheet
            .rows
            .iter()
            .enumerate()
            .map(|(i, row)| (row.r, i))
            .collect();
        let mut occupied: HashMap<u32, Vec<u32>> = HashMap::new();
        for row in &sheet.rows {
            let cols: Vec<u32> = row
                .cells
                .iter()
                .filter(|c| !is_blank(&c.v))
                .map(|c| c.c)
                .collect();
            if !cols.is_empty() {
                occupied.insert(row.r, cols);
            }
        }
        let mut grid = Grid {
            sheet,
            occupied_rows: Vec::new(),
            rows,
            occupied,
        };
        grid.fill_merges();
        let mut keys: Vec<u32> = grid.occupied.keys().copied().collect();
        keys.sort_unstable();
        grid.occupied_rows = keys;
        grid
    }

    /// The value stored in a cell; Null for an empty cell or one hidden under a merge.
    pub fn value(&self, r: u32, c: u32) -> &Raw {
        static NULL: Raw = Raw::Null;
        let Some(&i) = self.rows.get(&r) else {
            return &NULL;
        };
        let cells = &self.sheet.rows[i].cells;
        match cells.binary_search_by(|cell| cell.c.cmp(&c)) {
            Ok(k) => &cells[k].v,
            Err(_) => &NULL,
        }
    }

    /// The non-blank stored values of a row between two columns, in column order.
    pub fn row_values(&self, r: u32, c1: u32, c2: u32) -> Vec<(u32, &Raw)> {
        let Some(&i) = self.rows.get(&r) else {
            return Vec::new();
        };
        self.sheet.rows[i]
            .cells
            .iter()
            .filter(|cell| cell.c >= c1 && cell.c <= c2 && !is_blank(&cell.v))
            .map(|cell| (cell.c, &cell.v))
            .collect()
    }

    /// The merged range that covers a cell.
    pub fn merge_at(&self, r: u32, c: u32) -> Option<&CellRange> {
        self.sheet.merges.iter().find(|m| m.contains(r, c))
    }

    fn row_has_occupied(&self, r: u32, c1: u32, c2: u32) -> bool {
        let Some(cols) = self.occupied.get(&r) else {
            return false;
        };
        let i = cols.partition_point(|&c| c < c1);
        i < cols.len() && cols[i] <= c2
    }

    /// Occupied rows between r1 and r2 that have an occupied cell between c1 and c2.
    pub fn rows_in(&self, r1: u32, r2: u32, c1: u32, c2: u32) -> Vec<u32> {
        let start = self.occupied_rows.partition_point(|&r| r < r1);
        self.occupied_rows[start..]
            .iter()
            .take_while(|&&r| r <= r2)
            .filter(|&&r| self.row_has_occupied(r, c1, c2))
            .copied()
            .collect()
    }

    /// Columns between c1 and c2 occupied in at least one row between r1 and r2, ascending.
    fn cols_in(&self, r1: u32, r2: u32, c1: u32, c2: u32) -> Vec<u32> {
        let mut seen = BTreeSet::new();
        for r in self.rows_in(r1, r2, c1, c2) {
            let cols = &self.occupied[&r];
            let from = cols.partition_point(|&c| c < c1);
            for &c in cols[from..].iter().take_while(|&&c| c <= c2) {
                seen.insert(c);
            }
        }
        seen.into_iter().collect()
    }

    /// The smallest range holding every occupied cell; None for an empty sheet.
    fn bounds(&self) -> Option<CellRange> {
        let (&first, &last) = (self.occupied_rows.first()?, self.occupied_rows.last()?);
        let c1 = self.occupied.values().map(|c| c[0]).min()?;
        let c2 = self.occupied.values().map(|c| c[c.len() - 1]).max()?;
        Some(CellRange {
            sr: first,
            sc: c1,
            er: last,
            ec: c2,
        })
    }

    fn fill_merges(&mut self) {
        let Some(bounds) = self.value_bounds() else {
            return;
        };
        let mut extra: HashMap<u32, BTreeSet<u32>> = HashMap::new();
        for m in &self.sheet.merges {
            if is_blank(self.value(m.sr, m.sc)) {
                continue;
            }
            let r2 = m.er.min(bounds.er);
            let c2 = m.ec.min(bounds.ec);
            if r2 < m.sr || c2 < m.sc {
                continue;
            }
            if (r2 - m.sr + 1) as i64 * (c2 - m.sc + 1) as i64 > MAX_MERGE_FILL_CELLS {
                continue;
            }
            for r in m.sr..=r2 {
                extra.entry(r).or_default().extend(m.sc..=c2);
            }
        }
        for (r, mut cols) in extra {
            cols.extend(self.occupied.get(&r).into_iter().flatten().copied());
            self.occupied.insert(r, cols.into_iter().collect());
        }
    }

    /// Bounds of the cells that hold values, before merges are filled in.
    fn value_bounds(&self) -> Option<CellRange> {
        let mut bounds: Option<CellRange> = None;
        for (&r, cols) in &self.occupied {
            let (c1, c2) = (cols[0], cols[cols.len() - 1]);
            let b = bounds.get_or_insert(CellRange {
                sr: r,
                sc: c1,
                er: r,
                ec: c2,
            });
            b.sr = b.sr.min(r);
            b.er = b.er.max(r);
            b.sc = b.sc.min(c1);
            b.ec = b.ec.max(c2);
        }
        bounds
    }
}

// ---------------------------------------------------------------------------------------------
// Units rows (unit-text.ts)

/// Lower case, without spaces. A compound unit is recognised when each of its parts is listed.
const KNOWN_UNITS: &[&str] = &[
    "psi psia psig kpa kpaa kpag mpa pa bar bara barg mbar atm inhg mmhg",
    "degc degf degr degk °c °f °r c f k deg °",
    "m km cm mm ft in mi yd ha acre",
    "bbl stb bopd bwpd bfpd sm3 nm3 scf mscf mmscf mmscfd mcf mmcf bcf boe",
    "l ml gal gpm kl",
    "kg g t tonne tonnes lb lbm klb kt",
    "s sec min h hr hrs d day days yr",
    "% ppm ppb ppmv ppmw mol% vol% wt% frac fraction",
    "api °api sg",
    "w kw mw gw kwh mwh gj mj kj j btu mmbtu kcal",
    "v a hz rpm cp cst kn knots mph",
    "co2e tco2e kgco2e",
];

fn known(part: &str) -> bool {
    KNOWN_UNITS
        .iter()
        .any(|line| line.split(' ').any(|u| u == part))
}

/// Placeholders a units row may hold for columns without a unit.
const NO_UNIT: &[&str] = &["-", "–", "—", "n/a", "na", "none", ""];

/// 'm3', 'ft²' and 'm^3' name the same parts as 'm', 'ft' and 'm'.
fn without_power(part: &str) -> &str {
    let mut end = part.len();
    loop {
        let rest = &part[..end];
        if let Some(stripped) = rest.strip_suffix(['²', '³']) {
            end = stripped.len();
            continue;
        }
        let Some(last) = rest.chars().last() else {
            break;
        };
        if !last.is_ascii_digit() {
            break;
        }
        let mut cut = rest.len() - 1;
        if part[..cut].ends_with('-') {
            cut -= 1;
        }
        if part[..cut].ends_with('^') {
            cut -= 1;
        }
        end = cut;
    }
    &part[..end]
}

fn is_known_unit(text: &str) -> bool {
    let compact: String = text
        .to_lowercase()
        .chars()
        .filter(|c| !crate::units::is_js_space(*c))
        .collect();
    if known(&compact) {
        return true;
    }
    let parts: Vec<&str> = compact.split(['/', '·', '*']).collect();
    parts.len() <= 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && known(without_power(p)))
}

/// The text inside brackets or parentheses, when the whole text is bracketed.
fn bracketed(t: &str) -> Option<&str> {
    let open = t.chars().next()?;
    let close = t.chars().last()?;
    if t.chars().count() < 3 || !matches!(open, '[' | '(') || !matches!(close, ']' | ')') {
        return None;
    }
    Some(&t[open.len_utf8()..t.len() - close.len_utf8()])
}

fn js_trim(t: &str) -> &str {
    t.trim_matches(crate::units::is_js_space)
}

/// True for text that names a unit: anything in brackets, or a listed (possibly compound) unit.
pub fn is_unit_text(text: &str) -> bool {
    let t = js_trim(text);
    if let Some(inner) = bracketed(t) {
        let inner = js_trim(inner);
        let len = inner.encode_utf16().count();
        return len > 0 && len <= 24;
    }
    is_known_unit(t)
}

/// A date or time format hint such as 'yyyy-mm-dd' or 'hh:mm' that a units row may hold.
fn is_format_hint(t: &str) -> bool {
    let groups: Vec<&str> = t.split(['-', '/', '.', ':', ' ', 'T', 't']).collect();
    // The separators are single characters between groups of one to four format letters.
    let letters = |g: &str| {
        (1..=4).contains(&g.len())
            && g.bytes()
                .all(|b| matches!(b.to_ascii_lowercase(), b'y' | b'm' | b'd' | b'h' | b's'))
    };
    !t.is_empty() && groups.iter().all(|g| letters(g))
}

/// True for a cell a units row may hold where a column has no unit: a dash, 'n/a' or a format hint.
pub fn is_no_unit_text(text: &str) -> bool {
    let t = js_trim(text).to_lowercase();
    NO_UNIT.contains(&t.as_str()) || is_format_hint(&t)
}

/// The unit without its brackets: '[psi]' and '(psi)' give 'psi'.
fn unit_name(text: &str) -> &str {
    let t = js_trim(text);
    js_trim(bracketed(t).unwrap_or(t))
}

// ---------------------------------------------------------------------------------------------
// Tables (layout.ts)

/// Header rows that hold names; a units row may follow them.
const MAX_NAME_ROWS: usize = 3;
/// Blank rows a table may continue across.
const MAX_CONTINUATION_GAP: i64 = 2;
/// Data rows inspected for numbers under a candidate units row.
const UNIT_EVIDENCE_ROWS: usize = 20;

/// One table found in a sheet.
#[derive(Clone, Debug)]
pub struct TableBlock {
    /// From the first header row to the last data row; title rows above the header are outside it.
    pub range: CellRange,
    /// First and last header row, 0-based and inclusive; a units row under the names is the last.
    pub header_rows: (u32, u32),
    pub data_start_row: u32,
    /// One name per column of the range, e.g. 'Pressure / Max [psi]'.
    pub flattened_header: Vec<String>,
}

fn cut(grid: &Grid, b: CellRange) -> Vec<CellRange> {
    let row_runs = runs(&grid.rows_in(b.sr, b.er, b.sc, b.ec));
    if row_runs.is_empty() {
        return Vec::new();
    }
    if row_runs.len() > 1 {
        return row_runs
            .into_iter()
            .flat_map(|(r1, r2)| {
                cut(
                    grid,
                    CellRange {
                        sr: r1,
                        sc: b.sc,
                        er: r2,
                        ec: b.ec,
                    },
                )
            })
            .collect();
    }
    let (r1, r2) = row_runs[0];
    let col_runs = runs(&grid.cols_in(r1, r2, b.sc, b.ec));
    if col_runs.len() > 1 {
        return col_runs
            .into_iter()
            .flat_map(|(c1, c2)| {
                cut(
                    grid,
                    CellRange {
                        sr: r1,
                        sc: c1,
                        er: r2,
                        ec: c2,
                    },
                )
            })
            .collect();
    }
    let (c1, c2) = col_runs[0];
    vec![CellRange {
        sr: r1,
        sc: c1,
        er: r2,
        ec: c2,
    }]
}

fn is_data_value(v: &Raw) -> bool {
    matches!(
        v,
        Raw::Number(_) | Raw::Bool(_) | Raw::Date(_) | Raw::DateTime(_)
    )
}

fn starts_with_data(grid: &Grid, b: &CellRange) -> bool {
    grid.row_values(b.sr, b.sc, b.ec)
        .iter()
        .any(|(_, v)| is_data_value(v))
}

fn overlaps_columns(a: &CellRange, b: &CellRange) -> bool {
    a.sc <= b.ec && b.sc <= a.ec
}

/// The table a block continues: directly above it, at least as wide, with nothing in between.
fn continued(grid: &Grid, done: &[CellRange], b: &CellRange) -> Option<usize> {
    let mut nearest: Option<usize> = None;
    for (i, d) in done.iter().enumerate() {
        if d.er < b.sr && overlaps_columns(d, b) && nearest.is_none_or(|n| d.er > done[n].er) {
            nearest = Some(i);
        }
    }
    let n = &done[nearest?];
    if n.sc > b.sc || n.ec < b.ec {
        return None;
    }
    if b.sr as i64 - n.er as i64 - 1 > MAX_CONTINUATION_GAP || n.er == n.sr {
        return None;
    }
    starts_with_data(grid, b).then_some(nearest?)
}

fn blocks(grid: &Grid) -> Vec<CellRange> {
    let Some(bounds) = grid.bounds() else {
        return Vec::new();
    };
    let mut boxes = cut(grid, bounds);
    boxes.sort_by_key(|b| (b.sr, b.sc));
    let mut done: Vec<CellRange> = Vec::new();
    for b in boxes {
        match continued(grid, &done, &b) {
            None => done.push(b),
            Some(i) => done[i].er = b.er,
        }
    }
    done
}

fn is_title_row(grid: &Grid, r: u32, b: &CellRange) -> bool {
    if b.ec == b.sc {
        return false;
    }
    let cells = grid.row_values(r, b.sc, b.ec);
    let [(c, Raw::Text(_))] = cells.as_slice() else {
        return false;
    };
    let merge = grid.merge_at(r, *c);
    if merge.is_some_and(|m| m.er > m.sr) {
        return false;
    }
    if *c == b.sc {
        return true;
    }
    merge.is_some_and(|m| m.sc <= b.sc && m.ec >= b.ec)
}

/// The rows of the block that hold something, after its title rows; None when too few remain.
fn body_rows(grid: &Grid, b: &CellRange) -> Option<Vec<u32>> {
    let rows = grid.rows_in(b.sr, b.er, b.sc, b.ec);
    let mut first = 0;
    while rows.len() - first > 2 && is_title_row(grid, rows[first], b) {
        first += 1;
    }
    let body = rows[first..].to_vec();
    (body.len() >= 2).then_some(body)
}

fn merges_in_columns(grid: &Grid, b: &CellRange) -> Vec<CellRange> {
    grid.sheet
        .merges
        .iter()
        .filter(|m| overlaps_columns(m, b) && !is_blank(grid.value(m.sr, m.sc)))
        .copied()
        .collect()
}

/// A merged header cell that starts in the header and reaches into row `next`.
fn merge_reaches_into(merges: &[CellRange], top: u32, next: u32) -> bool {
    merges
        .iter()
        .any(|m| m.sr >= top && m.sr < next && m.er >= next)
}

fn is_text_row(grid: &Grid, r: u32, b: &CellRange) -> bool {
    let cells = grid.row_values(r, b.sc, b.ec);
    !cells.is_empty() && cells.iter().all(|(_, v)| matches!(v, Raw::Text(_)))
}

/// A group header merged across columns in row `last`, with text under it in row `next`.
fn group_has_subheaders(
    grid: &Grid,
    merges: &[CellRange],
    last: u32,
    next: u32,
    b: &CellRange,
) -> bool {
    if !is_text_row(grid, next, b) {
        return false;
    }
    merges.iter().any(|m| {
        m.sr == last && m.er == last && m.ec > m.sc && !grid.row_values(next, m.sc, m.ec).is_empty()
    })
}

fn is_units_row(grid: &Grid, u: u32, data_rows: &[u32], b: &CellRange) -> bool {
    let cells = grid.row_values(u, b.sc, b.ec);
    let texts: Option<Vec<(u32, &str)>> = cells
        .iter()
        .map(|(c, v)| match v {
            Raw::Text(t) => Some((*c, t.as_str())),
            _ => None,
        })
        .collect();
    let Some(texts) = texts.filter(|t| !t.is_empty()) else {
        return false;
    };
    let unit_cols: Vec<u32> = texts
        .iter()
        .filter(|(_, t)| is_unit_text(t))
        .map(|(c, _)| *c)
        .collect();
    if unit_cols.is_empty() {
        return false;
    }
    if !texts
        .iter()
        .all(|(c, t)| unit_cols.contains(c) || is_no_unit_text(t))
    {
        return false;
    }
    let evidence = &data_rows[..data_rows.len().min(UNIT_EVIDENCE_ROWS)];
    unit_cols.iter().any(|&c| {
        evidence
            .iter()
            .any(|&r| matches!(grid.value(r, c), Raw::Number(_)))
    })
}

#[derive(Clone, Copy)]
struct HeaderLayout {
    top: u32,
    last_name: u32,
    units_row: Option<u32>,
}

fn header_layout(grid: &Grid, body: &[u32], b: &CellRange) -> HeaderLayout {
    let merges = merges_in_columns(grid, b);
    let top = body[0];
    let mut i = 0;
    // The header grows only over adjacent rows and always leaves at least one data row.
    while i + 1 < MAX_NAME_ROWS && i + 2 < body.len() && body[i + 1] == body[i] + 1 {
        let last = body[i];
        let next = last + 1;
        if !merge_reaches_into(&merges, top, next)
            && !group_has_subheaders(grid, &merges, last, next, b)
        {
            break;
        }
        i += 1;
    }
    let last_name = body[i];
    let has_units = body.get(i + 1).copied() == Some(last_name + 1)
        && i + 2 < body.len()
        && is_units_row(grid, last_name + 1, &body[i + 2..], b);
    HeaderLayout {
        top,
        last_name,
        units_row: has_units.then_some(last_name + 1),
    }
}

/// Header text of a cell, showing the value of a merged range that starts inside the header.
fn header_text(grid: &Grid, r: u32, c: u32, top: u32) -> String {
    let v = match grid.merge_at(r, c) {
        Some(m) if m.sr >= top => grid.value(m.sr, m.sc),
        _ => grid.value(r, c),
    };
    v.text()
}

fn header_cells(grid: &Grid, layout: &HeaderLayout, b: &CellRange) -> Vec<Vec<String>> {
    let last = layout.units_row.unwrap_or(layout.last_name);
    (layout.top..=last)
        .map(|r| {
            (b.sc..=b.ec)
                .map(|c| header_text(grid, r, c, layout.top))
                .collect()
        })
        .collect()
}

/// White space runs become one space, and the ends are trimmed (/\s+/g, ' ', then trim()).
fn normalise_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.chars() {
        if crate::units::is_js_space(ch) || ch == '\u{FEFF}' {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(ch);
        }
    }
    out
}

/// The unit written in the units row for a column; a cell covered by a merge from above has none.
fn unit_of(grid: &Grid, units_row: u32, c: u32) -> Option<String> {
    if grid
        .merge_at(units_row, c)
        .is_some_and(|m| m.sr < units_row)
    {
        return None;
    }
    match grid.value(units_row, c) {
        Raw::Text(v) if is_unit_text(v) => Some(normalise_space(unit_name(v))),
        _ => None,
    }
}

fn flatten(
    grid: &Grid,
    cells: &[Vec<String>],
    layout: &HeaderLayout,
    b: &CellRange,
) -> Vec<String> {
    let name_rows = &cells[..(layout.last_name - layout.top + 1) as usize];
    (0..=(b.ec - b.sc))
        .map(|j| {
            let mut parts: Vec<String> = Vec::new();
            for row in name_rows {
                let part = normalise_space(row.get(j as usize).map_or("", String::as_str));
                if !part.is_empty() && parts.last() != Some(&part) {
                    parts.push(part);
                }
            }
            let name = parts.join(" / ");
            match layout.units_row.and_then(|u| unit_of(grid, u, b.sc + j)) {
                None => name,
                Some(unit) => js_trim(&format!("{name} [{unit}]")).to_string(),
            }
        })
        .collect()
}

fn analyse(grid: &Grid, b: &CellRange) -> Option<TableBlock> {
    let body = body_rows(grid, b)?;
    let layout = header_layout(grid, &body, b);
    let cells = header_cells(grid, &layout, b);
    let last_header = layout.units_row.unwrap_or(layout.last_name);
    Some(TableBlock {
        range: CellRange {
            sr: layout.top,
            sc: b.sc,
            er: b.er,
            ec: b.ec,
        },
        header_rows: (layout.top, last_header),
        data_start_row: last_header + 1,
        flattened_header: flatten(grid, &cells, &layout, b),
    })
}

/// The tables in a sheet, ordered top-left first.
pub fn tables_in(grid: &Grid) -> Vec<TableBlock> {
    blocks(grid)
        .iter()
        .filter_map(|b| analyse(grid, b))
        .collect()
}

/// The TW-IMP-003 note for a block whose header has several rows; none for a single header row.
pub fn header_notes(sheet: &str, block: &TableBlock) -> Vec<Note> {
    let (first, last) = block.header_rows;
    if last <= first {
        return Vec::new();
    }
    let example = block
        .flattened_header
        .iter()
        .find(|n| n.contains(" / ") || n.contains('['))
        .or(block.flattened_header.first());
    let example = example.map_or_else(String::new, |e| format!(", for example \"{e}\""));
    vec![Note {
        code: "TW-IMP-003".into(),
        message: format!(
            "Rows {} to {} of sheet \"{sheet}\" form a multi-row header and were joined into one header row{example}.",
            first + 1,
            last + 1
        ),
        src_loc: Some(first as u64 + 1),
        detail: json!({
            "sheet": sheet,
            "range": format_range(&block.range),
            "headerRows": [first + 1, last + 1],
            "columns": block.flattened_header,
        }),
    }]
}

/// TW-IMP-002 for a table that is not imported, naming its range and the table that is.
pub fn other_table_note(sheet: &str, other: &TableBlock, imported: &TableBlock) -> Note {
    let range = format_range(&other.range);
    Note {
        code: "TW-IMP-002".into(),
        message: format!(
            "Sheet \"{sheet}\" has another table at {range}; the table at {} was imported. Choose the table in the import preview to import the other one.",
            format_range(&imported.range)
        ),
        src_loc: Some(other.range.sr as u64 + 1),
        detail: json!({ "sheet": sheet, "range": range }),
    }
}

/// True when every non-blank cell of a row is a unit or a no-unit placeholder, and one is a unit.
fn looks_like_units(grid: &Grid, r: u32, b: &CellRange) -> bool {
    let cells = grid.row_values(r, b.sc, b.ec);
    let texts: Vec<Option<&str>> = cells
        .iter()
        .map(|(_, v)| match v {
            Raw::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    texts
        .iter()
        .all(|t| t.is_some_and(|t| is_unit_text(t) || is_no_unit_text(t)))
        && texts.iter().any(|t| t.is_some_and(is_unit_text))
}

/// The table block for header rows and columns given explicitly (a structural override). The
/// last header row is read as a units row when it holds only units.
pub fn block_for(grid: &Grid, chosen: &Chosen) -> TableBlock {
    let clamp = |n: i64| n.clamp(0, u32::MAX as i64) as u32;
    let b = CellRange {
        sr: clamp(chosen.header_row_start),
        sc: clamp(chosen.first_col),
        er: clamp(chosen.last_row),
        ec: clamp(chosen.last_col),
    };
    let (start, end) = (clamp(chosen.header_row_start), clamp(chosen.header_row_end));
    let units = end > start && looks_like_units(grid, end, &b);
    let layout = HeaderLayout {
        top: start,
        last_name: if units { end - 1 } else { end },
        units_row: units.then_some(end),
    };
    let cells = header_cells(grid, &layout, &b);
    TableBlock {
        range: b,
        header_rows: (start, end),
        data_start_row: clamp(chosen.data_start_row),
        flattened_header: flatten(grid, &cells, &layout, &b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_units_and_placeholders() {
        for t in [
            "psi", "[degC]", "(m3/d)", "bbl/d", "MMscf/d", "m³", "ft^2", "°C", "kg·m",
        ] {
            assert!(is_unit_text(t), "{t}");
        }
        for t in ["Max", "Well name", "[]", "pressure"] {
            assert!(!is_unit_text(t), "{t}");
        }
        for t in ["-", "n/a", "yyyy-mm-dd", "hh:mm", "dd/mm/yyyy hh:mm", ""] {
            assert!(is_no_unit_text(t), "{t}");
        }
        assert!(!is_no_unit_text("Max"));
        assert_eq!(unit_name(" [ psi ] "), "psi");
        assert_eq!(normalise_space("  Gas\n rate \t"), "Gas rate");
        assert_eq!(runs(&[1, 2, 3, 7, 8]), vec![(1, 3), (7, 8)]);
    }
}
