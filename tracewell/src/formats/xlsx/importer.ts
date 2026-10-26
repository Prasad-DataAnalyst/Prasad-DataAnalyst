/**
 * The XLSX Importer used by ingest. A workbook is a ZIP whose central directory sits at its end, so
 * both sniff() and read() load the whole file (under the reader's size guard) rather than the
 * first MiB.
 *
 * sniff() lists every sheet with its tables, picks the first visible sheet that has a table and
 * that sheet's first table, and returns the table's flattened header as a single header row
 * (detect then reads units from the brackets). read() emits the data rows of the chosen table with
 * their 1-based sheet row as source locator. A value merged across several data cells is repeated
 * in each of them, as the sheet shows it; fully blank rows inside a table are skipped.
 */
import {
  BATCH_ROWS,
  detection,
  type ByteSource,
  type Detection,
  type FormatOptions,
  type ImportNote,
  type Importer,
  type JsonValue,
  type RawBatch,
  type RawField,
  type RawRow,
  type ReadContext,
  type SheetInfo,
  type SniffResult,
  type XlsxOptions,
} from '@tw/model';
import { invalidArgument, throwIfAborted } from './errors';
import { isBlank, SheetGrid } from './grid';
import { blockFor, headerNotes, otherTableNote, tablesIn, type ChosenHeader } from './layout';
import { formatRange } from './refs';
import type { TableBlock, XlsxSheet, XlsxWorkbook } from './types';
import { openWorkbook } from './workbook';

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;
/** Cells filled from merged data ranges; beyond this a merge keeps its value in its first cell only. */
const MAX_MERGE_FILL_CELLS = 5_000_000;

async function allBytes(src: ByteSource): Promise<Uint8Array> {
  return src.slice(0, src.size);
}

interface SheetLayout {
  sheet: XlsxSheet;
  grid: SheetGrid;
  tables: TableBlock[];
}

function layoutOf(book: XlsxWorkbook, name: string): SheetLayout {
  const sheet = book.readSheet(name);
  const grid = new SheetGrid(sheet);
  return { sheet, grid, tables: tablesIn(grid) };
}

function sheetInfo(layout: SheetLayout): SheetInfo {
  return {
    name: layout.sheet.name,
    state: layout.sheet.state,
    dimension: layout.sheet.dimension,
    tables: layout.tables.map((t) => ({
      range: formatRange(t.range),
      headerRows: t.headerRows[1] - t.headerRows[0] + 1,
    })),
  };
}

/** The first visible sheet with a table, else the first visible sheet with any value, else the first sheet. */
function defaultSheet(layouts: readonly SheetLayout[]): SheetLayout | undefined {
  const visible = layouts.filter((l) => l.sheet.state === 'visible');
  return (
    visible.find((l) => l.tables.length > 0) ?? visible.find((l) => l.sheet.rows.length > 0) ?? visible[0] ?? layouts[0]
  );
}

// ---------------------------------------------------------------------------------------------
// Detections
//
// The keys follow the CSV importer where they mean the same thing: skipLines is the 0-based sheet
// row of the first header row and headerRows counts every header row, a units row included.

function sheetDetection(chosen: SheetLayout, layouts: readonly SheetLayout[]): Detection<JsonValue> {
  const name = chosen.sheet.name;
  if (layouts.length === 1) {
    return detection(name, 'high', 'only-sheet', `The workbook has one sheet, "${name}".`);
  }
  const others = layouts
    .filter((l) => l !== chosen)
    .map((l) => `"${l.sheet.name}"${l.sheet.state === 'visible' ? '' : ` (${l.sheet.state})`}`)
    .join(', ');
  if (chosen.tables.length === 0) {
    return detection(
      name,
      'low',
      'no-table',
      `No visible sheet holds a table; the workbook also has ${others}.`,
      'default',
    );
  }
  const rivals = layouts.filter((l) => l !== chosen && l.sheet.state === 'visible' && l.tables.length > 0);
  if (rivals.length === 0) {
    // Hidden sheets are left out on purpose: they usually hold settings or lookups, not the data.
    return detection(
      name,
      'high',
      'only-visible-sheet-with-table',
      `"${name}" is the only visible sheet that holds a table; the workbook also has ${others}.`,
    );
  }
  return detection(
    name,
    'medium',
    'first-visible-sheet-with-table',
    `"${name}" is the first of ${rivals.length + 1} visible sheets that hold a table; the workbook also has ${others}.`,
  );
}

function noTableDetections(name: string): Record<string, Detection<JsonValue>> {
  const evidence = `Sheet "${name}" holds no table.`;
  return {
    tableIndex: detection(0, 'low', 'no-table', evidence, 'default'),
    skipLines: detection(0, 'low', 'no-table', evidence, 'default'),
    headerRows: detection(0, 'low', 'no-table', evidence, 'default'),
  };
}

/**
 * The first table, top-left, is imported. With several tables the choice is not reported as an
 * assumed detection: the TW-IMP-002 note on every other table already asks the user to check it,
 * and a second, generic TW-IMP-005 for the same fact would only add noise.
 */
function tableIndexDetection(chosen: SheetLayout, table: TableBlock): Detection<JsonValue> {
  const name = chosen.sheet.name;
  const range = formatRange(table.range);
  if (chosen.tables.length === 1) {
    return detection(0, 'high', 'only-table', `The table at ${range} is the only one in sheet "${name}".`);
  }
  const others = chosen.tables.slice(1).map((t) => formatRange(t.range));
  return detection(
    0,
    'high',
    'first-table',
    `Sheet "${name}" holds ${chosen.tables.length} tables; the first, at ${range}, is imported and ` +
      `TW-IMP-002 names the others (${others.join(', ')}).`,
  );
}

function tableEvidence(table: TableBlock): string {
  return `The table spans ${formatRange(table.range)}, bounded by blank rows and columns; its data starts on row ${table.dataStartRow + 1}.`;
}

function skipLinesDetection(grid: SheetGrid, table: TableBlock): Detection<JsonValue> {
  const top = table.headerRows[0];
  if (top === 0) return detection(0, 'high', 'table-block', 'The header is on the first row of the sheet.');
  const above = grid.rowsIn(0, top - 1, table.range.s.c, table.range.e.c).length;
  const what = above === 0 ? 'blank' : `blank or titles (${above} with text)`;
  return detection(top, 'high', 'table-block', `The header starts on row ${top + 1}; the rows above it are ${what}.`);
}

function headerRowsDetection(table: TableBlock): Detection<JsonValue> {
  const [first, last] = table.headerRows;
  const rows = last - first + 1;
  if (rows === 1) {
    return detection(1, 'high', 'single-header-row', `Row ${first + 1} holds the column names.`);
  }
  // Layout detection only extends a header on structural evidence (merged cells, sub-headers under
  // a group, or a row of units above numbers), so a multi-row header is as certain as a single one.
  return detection(
    rows,
    'high',
    'merged-or-units-header',
    `Rows ${first + 1} to ${last + 1} form the header (merged cells or a units row); they were joined into one row of names.`,
  );
}

function tableDetections(chosen: SheetLayout, table: TableBlock | undefined): Record<string, Detection<JsonValue>> {
  if (table === undefined) return noTableDetections(chosen.sheet.name);
  return {
    tableIndex: tableIndexDetection(chosen, table),
    tableRange: detection(formatRange(table.range), 'high', 'blank-row-column-blocks', tableEvidence(table)),
    skipLines: skipLinesDetection(chosen.grid, table),
    headerRows: headerRowsDetection(table),
  };
}

function date1904Detection(book: XlsxWorkbook): Detection<JsonValue> {
  const evidence = book.date1904
    ? 'The workbook uses the 1904 date system (workbookPr date1904).'
    : 'The workbook uses the 1900 date system.';
  return detection(book.date1904, 'high', 'workbook-property', evidence);
}

// ---------------------------------------------------------------------------------------------
// Rows

interface Fill {
  c1: number;
  c2: number;
  v: RawField;
}

/** Values of merged ranges that start in the data area, by data row, clipped to the table. */
function mergeFills(grid: SheetGrid, chosen: ChosenHeader): Map<number, Fill[]> {
  const fills = new Map<number, Fill[]>();
  let budget = MAX_MERGE_FILL_CELLS;
  for (const m of grid.sheet.merges) {
    if (m.s.r < chosen.dataStartRow || m.s.r > chosen.lastRow) continue;
    if (m.e.c < chosen.firstCol || m.s.c > chosen.lastCol) continue;
    const v = grid.value(m.s.r, m.s.c);
    const r2 = Math.min(m.e.r, chosen.lastRow);
    const fill = { c1: Math.max(m.s.c, chosen.firstCol), c2: Math.min(m.e.c, chosen.lastCol), v };
    budget -= (r2 - m.s.r + 1) * (fill.c2 - fill.c1 + 1);
    if (isBlank(v) || budget < 0) continue;
    for (let r = m.s.r; r <= r2; r++) fills.set(r, [...(fills.get(r) ?? []), fill]);
  }
  return fills;
}

function* tableRows(grid: SheetGrid, chosen: ChosenHeader): Generator<RawRow> {
  const width = chosen.lastCol - chosen.firstCol + 1;
  if (width <= 0) return;
  const fills = mergeFills(grid, chosen);
  for (const row of grid.sheet.rows) {
    if (row.r < chosen.dataStartRow || row.r > chosen.lastRow) continue;
    const fields: RawField[] = new Array<RawField>(width).fill(null);
    for (const cell of row.cells) {
      if (cell.c >= chosen.firstCol && cell.c <= chosen.lastCol) fields[cell.c - chosen.firstCol] = cell.v;
    }
    for (const fill of fills.get(row.r) ?? []) {
      for (let c = fill.c1; c <= fill.c2; c++) fields[c - chosen.firstCol] = fill.v;
    }
    if (!fields.every(isBlank)) yield { srcLoc: row.r + 1, fields };
  }
}

// ---------------------------------------------------------------------------------------------
// Options

function lastSheetRow(sheet: XlsxSheet): number {
  return sheet.rows[sheet.rows.length - 1]?.r ?? 0;
}

function chosenFromTable(table: TableBlock): ChosenHeader {
  return {
    headerRowStart: table.headerRows[0],
    headerRowEnd: table.headerRows[1],
    dataStartRow: table.dataStartRow,
    firstCol: table.range.s.c,
    lastCol: table.range.e.c,
    lastRow: table.range.e.r,
  };
}

/** Options for a sheet without tables: no columns, so no rows. */
function emptyChosen(): ChosenHeader {
  return { headerRowStart: 0, headerRowEnd: 0, dataStartRow: 1, firstCol: 0, lastCol: -1, lastRow: 0 };
}

function toOptions(sheet: string, tableIndex: number, chosen: ChosenHeader): XlsxOptions {
  const { headerRowStart, headerRowEnd, dataStartRow, firstCol, lastCol } = chosen;
  return { sheet, tableIndex, headerRowStart, headerRowEnd, dataStartRow, firstCol, lastCol };
}

function isWholeNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function xlsxOptionsOf(opts: FormatOptions): XlsxOptions {
  if (opts.format !== 'xlsx') {
    throw invalidArgument(`The XLSX reader was given options for the format "${opts.format}".`, {
      format: opts.format,
    });
  }
  const o = opts.xlsx;
  const counts = [o.tableIndex, o.headerRowStart, o.headerRowEnd, o.dataStartRow, o.firstCol];
  const valid =
    counts.every(isWholeNumber) &&
    Number.isSafeInteger(o.lastCol) &&
    o.lastCol >= o.firstCol - 1 &&
    o.headerRowEnd >= o.headerRowStart &&
    o.dataStartRow > o.headerRowEnd;
  if (!valid) {
    throw invalidArgument(
      'The XLSX options must give whole, 0-based rows and columns with the header before the data ' +
        'and the last column not before the first.',
      { ...o },
    );
  }
  return o;
}

/**
 * The rows and columns to read: the options' header, data start and columns, ending where the
 * chosen table ends (or at the sheet's last row when the sheet has no such table).
 */
function chosenFromOptions(o: XlsxOptions, layout: SheetLayout): ChosenHeader {
  const table = layout.tables[o.tableIndex];
  return {
    headerRowStart: o.headerRowStart,
    headerRowEnd: o.headerRowEnd,
    dataStartRow: o.dataStartRow,
    firstCol: o.firstCol,
    lastCol: o.lastCol,
    lastRow: table?.range.e.r ?? lastSheetRow(layout.sheet),
  };
}

/** TW-IMP-003 for the chosen header and TW-IMP-002 for each table that is not imported. */
function notesFor(layout: SheetLayout, chosen: ChosenHeader, tableIndex: number): ImportNote[] {
  if (chosen.lastCol < chosen.firstCol) return [];
  const name = layout.sheet.name;
  const block = blockFor(layout.grid, chosen);
  const imported = { ...block, notes: [] };
  const others = layout.tables.filter((_, i) => i !== tableIndex).map((t) => otherTableNote(name, t, imported));
  return [...headerNotes(name, block), ...others];
}

// ---------------------------------------------------------------------------------------------

async function sniff(src: ByteSource): Promise<SniffResult> {
  const book = openWorkbook(await allBytes(src));
  const layouts = book.sheets.map((s) => layoutOf(book, s.name));
  const chosen = defaultSheet(layouts);
  if (chosen === undefined) {
    throw invalidArgument('The workbook has no sheets.');
  }
  const table = chosen.tables[0];
  const rows = table === undefined ? emptyChosen() : chosenFromTable(table);
  const sampleRows: RawRow[] = [];
  for (const row of tableRows(chosen.grid, rows)) {
    if (sampleRows.length >= SAMPLE_ROWS) break;
    sampleRows.push(row);
  }
  return {
    format: 'xlsx',
    options: { format: 'xlsx', xlsx: toOptions(chosen.sheet.name, 0, rows) },
    detections: {
      sheet: sheetDetection(chosen, layouts),
      ...tableDetections(chosen, table),
      date1904: date1904Detection(book),
    },
    header: table === undefined ? [] : [table.flattenedHeader],
    sampleRows,
    sheets: layouts.map(sheetInfo),
    notes: table === undefined ? [] : notesFor(chosen, rows, 0),
  };
}

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  const o = xlsxOptionsOf(opts);
  throwIfAborted(ctx.signal);
  const bytes = await allBytes(src);
  ctx.onBytes(bytes.byteLength);
  throwIfAborted(ctx.signal);
  const layout = layoutOf(openWorkbook(bytes), o.sheet);
  const chosen = chosenFromOptions(o, layout);
  for (const note of notesFor(layout, chosen, o.tableIndex)) ctx.note(note);
  let batch: RawRow[] = [];
  for (const row of tableRows(layout.grid, chosen)) {
    batch.push(row);
    if (batch.length < BATCH_ROWS) continue;
    yield { rows: batch };
    batch = [];
    throwIfAborted(ctx.signal);
  }
  if (batch.length > 0) yield { rows: batch };
}

/** The XLSX Importer: formats ['xlsx']. */
export const xlsxImporter: Importer = {
  formats: ['xlsx'],
  sniff,
  read,
};
