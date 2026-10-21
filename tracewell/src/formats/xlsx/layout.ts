/**
 * Layout detection: where the tables are in a sheet and which rows are their header.
 *
 *   1. Blocks. Occupied cells are cut into blocks along fully blank rows and columns, repeatedly
 *      (a recursive XY cut). A block that starts with numbers, dates or booleans right under a
 *      table with the same columns, after at most two blank rows, continues that table: one blank
 *      row inside data does not make a second table.
 *   2. Titles. Rows at the top of a block with a single text cell at its left edge (or merged across
 *      its full width) are titles, not header rows. Blocks with fewer than two other rows are notes.
 *   3. Header. The first remaining row is the header. It grows downwards while a merged header cell
 *      reaches into the next row, or while a group header merged across columns has sub-headers
 *      under it (at most three rows of names). A row of units right under it joins it too.
 *   4. Names. Each column's header parts are joined with ' / ' and its unit appended in brackets,
 *      so a merged two-row header with a units row gives 'Pressure / Max [psi]'.
 */
import { rawToText, type ImportNote, type RawField } from '@tw/model';
import { isBlank, runs, SheetGrid } from './grid';
import { formatRange } from './refs';
import type { CellRange, TableBlock, XlsxSheet } from './types';
import { isNoUnitText, isUnitText, unitName } from './unit-text';

/** Header rows that hold names; a units row may follow them. */
const MAX_NAME_ROWS = 3;
/** Blank rows a table may continue across. */
const MAX_CONTINUATION_GAP = 2;
/** Data rows inspected for numbers under a candidate units row. */
const UNIT_EVIDENCE_ROWS = 20;

// ---------------------------------------------------------------------------------------------
// 1. Blocks

function cut(grid: SheetGrid, box: CellRange): CellRange[] {
  const rowRuns = runs(grid.rowsIn(box.s.r, box.e.r, box.s.c, box.e.c));
  if (rowRuns.length === 0) return [];
  if (rowRuns.length > 1) {
    return rowRuns.flatMap(([r1, r2]) => cut(grid, { s: { r: r1, c: box.s.c }, e: { r: r2, c: box.e.c } }));
  }
  const [r1, r2] = rowRuns[0] as [number, number];
  const colRuns = runs(grid.colsIn(r1, r2, box.s.c, box.e.c));
  if (colRuns.length > 1) {
    return colRuns.flatMap(([c1, c2]) => cut(grid, { s: { r: r1, c: c1 }, e: { r: r2, c: c2 } }));
  }
  const [c1, c2] = colRuns[0] as [number, number];
  return [{ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } }];
}

function byTopLeft(a: CellRange, b: CellRange): number {
  return a.s.r - b.s.r || a.s.c - b.s.c;
}

function isDataValue(v: RawField): boolean {
  return typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'object' && v !== null && !('error' in v));
}

function startsWithData(grid: SheetGrid, box: CellRange): boolean {
  return grid.rowValues(box.s.r, box.s.c, box.e.c).some((cell) => isDataValue(cell.v));
}

function overlapsColumns(a: CellRange, b: CellRange): boolean {
  return a.s.c <= b.e.c && b.s.c <= a.e.c;
}

/** The table a block continues: directly above it, at least as wide, with nothing in between. */
function continued(grid: SheetGrid, done: readonly CellRange[], box: CellRange): CellRange | null {
  const above = done.filter((d) => d.e.r < box.s.r && overlapsColumns(d, box));
  const nearest = above.reduce<CellRange | null>((best, d) => (best === null || d.e.r > best.e.r ? d : best), null);
  if (nearest === null || nearest.s.c > box.s.c || nearest.e.c < box.e.c) return null;
  if (box.s.r - nearest.e.r - 1 > MAX_CONTINUATION_GAP || nearest.e.r === nearest.s.r) return null;
  return startsWithData(grid, box) ? nearest : null;
}

function blocks(grid: SheetGrid): CellRange[] {
  const bounds = grid.bounds();
  if (bounds === null) return [];
  const done: CellRange[] = [];
  for (const box of cut(grid, bounds).sort(byTopLeft)) {
    const table = continued(grid, done, box);
    if (table === null) done.push({ s: { ...box.s }, e: { ...box.e } });
    else table.e.r = box.e.r;
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// 2. Titles

function isTitleRow(grid: SheetGrid, r: number, box: CellRange): boolean {
  if (box.e.c === box.s.c) return false;
  const cells = grid.rowValues(r, box.s.c, box.e.c);
  const only = cells[0];
  if (cells.length !== 1 || only === undefined || typeof only.v !== 'string') return false;
  const merge = grid.mergeAt(r, only.c);
  if (merge !== null && merge.e.r > merge.s.r) return false;
  if (only.c === box.s.c) return true;
  return merge !== null && merge.s.c <= box.s.c && merge.e.c >= box.e.c;
}

/** The rows of the block that hold something, after its title rows; null when too few remain. */
function bodyRows(grid: SheetGrid, box: CellRange): number[] | null {
  const rows = grid.rowsIn(box.s.r, box.e.r, box.s.c, box.e.c);
  let first = 0;
  while (rows.length - first > 2 && isTitleRow(grid, rows[first] as number, box)) first += 1;
  const body = rows.slice(first);
  return body.length >= 2 ? body : null;
}

// ---------------------------------------------------------------------------------------------
// 3. Header

function mergesInColumns(grid: SheetGrid, box: CellRange): CellRange[] {
  return grid.sheet.merges.filter((m) => overlapsColumns(m, box) && !isBlank(grid.value(m.s.r, m.s.c)));
}

/** A merged header cell that starts in the header and reaches into row `next`. */
function mergeReachesInto(merges: readonly CellRange[], top: number, next: number): boolean {
  return merges.some((m) => m.s.r >= top && m.s.r < next && m.e.r >= next);
}

function isTextRow(grid: SheetGrid, r: number, box: CellRange): boolean {
  const cells = grid.rowValues(r, box.s.c, box.e.c);
  return cells.length > 0 && cells.every((cell) => typeof cell.v === 'string');
}

/** A group header merged across columns in row `last`, with text under it in row `next`. */
function groupHasSubheaders(grid: SheetGrid, merges: readonly CellRange[], last: number, next: number, box: CellRange) {
  if (!isTextRow(grid, next, box)) return false;
  return merges.some(
    (m) => m.s.r === last && m.e.r === last && m.e.c > m.s.c && grid.rowValues(next, m.s.c, m.e.c).length > 0,
  );
}

function isUnitsRow(grid: SheetGrid, u: number, dataRows: readonly number[], box: CellRange): boolean {
  const cells = grid.rowValues(u, box.s.c, box.e.c);
  if (cells.length === 0 || !cells.every((cell) => typeof cell.v === 'string')) return false;
  const unitCols = cells.filter((cell) => isUnitText(cell.v as string)).map((cell) => cell.c);
  if (unitCols.length === 0) return false;
  if (!cells.every((cell) => unitCols.includes(cell.c) || isNoUnitText(cell.v as string))) return false;
  const evidence = dataRows.slice(0, UNIT_EVIDENCE_ROWS);
  return unitCols.some((c) => evidence.some((r) => typeof grid.value(r, c) === 'number'));
}

interface HeaderLayout {
  top: number;
  lastName: number;
  unitsRow: number | null;
}

function headerLayout(grid: SheetGrid, body: readonly number[], box: CellRange): HeaderLayout {
  const merges = mergesInColumns(grid, box);
  const top = body[0] as number;
  let i = 0;
  // The header grows only over adjacent rows and always leaves at least one data row.
  while (i + 1 < MAX_NAME_ROWS && i + 2 < body.length && body[i + 1] === (body[i] as number) + 1) {
    const last = body[i] as number;
    const next = last + 1;
    if (!mergeReachesInto(merges, top, next) && !groupHasSubheaders(grid, merges, last, next, box)) break;
    i += 1;
  }
  const lastName = body[i] as number;
  const candidate = body[i + 1];
  const hasUnits =
    candidate === lastName + 1 && i + 2 < body.length && isUnitsRow(grid, candidate, body.slice(i + 2), box);
  return { top, lastName, unitsRow: hasUnits ? (candidate as number) : null };
}

// ---------------------------------------------------------------------------------------------
// 4. Names

/** Header text of a cell, showing the value of a merged range that starts inside the header. */
function headerText(grid: SheetGrid, r: number, c: number, top: number): string {
  const merge = grid.mergeAt(r, c);
  const v = merge !== null && merge.s.r >= top ? grid.value(merge.s.r, merge.s.c) : grid.value(r, c);
  return rawToText(v);
}

function headerCells(grid: SheetGrid, layout: HeaderLayout, box: CellRange): string[][] {
  const last = layout.unitsRow ?? layout.lastName;
  const out: string[][] = [];
  for (let r = layout.top; r <= last; r++) {
    const row: string[] = [];
    for (let c = box.s.c; c <= box.e.c; c++) row.push(headerText(grid, r, c, layout.top));
    out.push(row);
  }
  return out;
}

function normaliseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The unit written in the units row for a column; a cell covered by a merge from above has none. */
function unitOf(grid: SheetGrid, unitsRow: number, c: number): string | null {
  const merge = grid.mergeAt(unitsRow, c);
  if (merge !== null && merge.s.r < unitsRow) return null;
  const v = grid.value(unitsRow, c);
  return typeof v === 'string' && isUnitText(v) ? normaliseSpace(unitName(v)) : null;
}

function flatten(grid: SheetGrid, cells: readonly string[][], layout: HeaderLayout, box: CellRange): string[] {
  const nameRows = cells.slice(0, layout.lastName - layout.top + 1);
  const names: string[] = [];
  for (let j = 0; j <= box.e.c - box.s.c; j++) {
    const parts: string[] = [];
    for (const row of nameRows) {
      const part = normaliseSpace(row[j] ?? '');
      if (part !== '' && parts[parts.length - 1] !== part) parts.push(part);
    }
    const name = parts.join(' / ');
    const unit = layout.unitsRow === null ? null : unitOf(grid, layout.unitsRow, box.s.c + j);
    names.push(unit === null ? name : `${name} [${unit}]`.trim());
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// Notes

function headerRowsNote(sheet: string, block: Omit<TableBlock, 'notes'>): ImportNote {
  const [first, last] = block.headerRows;
  const example = block.flattenedHeader.find((n) => n.includes(' / ') || n.includes('[')) ?? block.flattenedHeader[0];
  return {
    code: 'TW-IMP-003',
    message:
      `Rows ${first + 1} to ${last + 1} of sheet "${sheet}" form a multi-row header and were joined into one ` +
      `header row${example === undefined ? '' : `, for example "${example}"`}.`,
    srcLoc: first + 1,
    detail: { sheet, range: formatRange(block.range), headerRows: [first + 1, last + 1], columns: block.flattenedHeader },
  };
}

/** TW-IMP-002 for a table that is not imported, naming its range and the table that is. */
export function otherTableNote(sheet: string, other: TableBlock, imported: TableBlock): ImportNote {
  const range = formatRange(other.range);
  return {
    code: 'TW-IMP-002',
    message:
      `Sheet "${sheet}" has another table at ${range}; the table at ${formatRange(imported.range)} was imported. ` +
      'Choose the table in the import preview to import the other one.',
    srcLoc: other.range.s.r + 1,
    detail: { sheet, range },
  };
}

// ---------------------------------------------------------------------------------------------

function analyse(grid: SheetGrid, box: CellRange): Omit<TableBlock, 'notes'> | null {
  const body = bodyRows(grid, box);
  if (body === null) return null;
  const layout = headerLayout(grid, body, box);
  const cells = headerCells(grid, layout, box);
  const lastHeader = layout.unitsRow ?? layout.lastName;
  return {
    range: { s: { r: layout.top, c: box.s.c }, e: { r: box.e.r, c: box.e.c } },
    headerRows: [layout.top, lastHeader],
    dataStartRow: lastHeader + 1,
    flattenedHeader: flatten(grid, cells, layout, box),
    headerCells: cells,
  };
}

/** The TW-IMP-003 note for a block whose header has several rows; none for a single header row. */
export function headerNotes(sheet: string, block: Omit<TableBlock, 'notes'>): ImportNote[] {
  return block.headerRows[1] > block.headerRows[0] ? [headerRowsNote(sheet, block)] : [];
}

/**
 * The tables in a sheet, ordered top-left first. Each block's notes hold TW-IMP-003 when its header
 * has several rows; every block after the first also holds the TW-IMP-002 note that importing the
 * first table by default gives.
 */
export function detectTables(sheet: XlsxSheet): TableBlock[] {
  return tablesIn(new SheetGrid(sheet));
}

export function tablesIn(grid: SheetGrid): TableBlock[] {
  const name = grid.sheet.name;
  const found = blocks(grid)
    .map((box) => analyse(grid, box))
    .filter((b): b is Omit<TableBlock, 'notes'> => b !== null)
    .map((b) => ({ ...b, notes: headerNotes(name, b) }));
  const first = found[0];
  if (first === undefined) return found;
  return found.map((b, i) => (i === 0 ? b : { ...b, notes: [...b.notes, otherTableNote(name, b, first)] }));
}

/** Header rows and columns chosen in the import options, which may differ from the detected ones. */
export interface ChosenHeader {
  headerRowStart: number;
  headerRowEnd: number;
  dataStartRow: number;
  firstCol: number;
  lastCol: number;
  lastRow: number;
}

/** True when every non-blank cell of a row is a unit or a no-unit placeholder, and one is a unit. */
function looksLikeUnits(grid: SheetGrid, r: number, box: CellRange): boolean {
  const cells = grid.rowValues(r, box.s.c, box.e.c);
  const texts = cells.map((cell) => (typeof cell.v === 'string' ? cell.v : null));
  return (
    texts.every((t) => t !== null && (isUnitText(t) || isNoUnitText(t))) &&
    texts.some((t) => t !== null && isUnitText(t))
  );
}

/**
 * The table block for header rows and columns given explicitly (a structural override). The last
 * header row is read as a units row when it holds only units.
 */
export function blockFor(grid: SheetGrid, chosen: ChosenHeader): Omit<TableBlock, 'notes'> {
  const box = { s: { r: chosen.headerRowStart, c: chosen.firstCol }, e: { r: chosen.lastRow, c: chosen.lastCol } };
  const multi = chosen.headerRowEnd > chosen.headerRowStart;
  const units = multi && looksLikeUnits(grid, chosen.headerRowEnd, box);
  const layout: HeaderLayout = {
    top: chosen.headerRowStart,
    lastName: units ? chosen.headerRowEnd - 1 : chosen.headerRowEnd,
    unitsRow: units ? chosen.headerRowEnd : null,
  };
  const cells = headerCells(grid, layout, box);
  return {
    range: box,
    headerRows: [chosen.headerRowStart, chosen.headerRowEnd],
    dataStartRow: chosen.dataStartRow,
    flattenedHeader: flatten(grid, cells, layout, box),
    headerCells: cells,
  };
}
