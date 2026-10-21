/**
 * Public types of the XLSX adapter: the workbook as the reader sees it, the table blocks layout
 * detection finds in a sheet, and the typed workbook description the writer takes.
 * Rows and columns are 0-based everywhere in this module; A1 references appear only in text.
 */
import type { DateCell, DateTimeCell, ImportNote, IsoUtc, RawField } from '@tw/model';

/** A rectangle of cells, 0-based and inclusive at both ends (A1:B2 is s {r 0, c 0}, e {r 1, c 1}). */
export interface CellRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export type SheetState = 'visible' | 'hidden' | 'veryHidden';

/** The cell types of SpreadsheetML (ECMA-376 Part 1, 18.18.11 ST_CellType). */
export type XlsxCellType = 'n' | 's' | 'b' | 'e' | 'str' | 'inlineStr' | 'd';

export interface XlsxCell {
  /** 0-based column. */
  c: number;
  t: XlsxCellType;
  /**
   * The value: a number, text, boolean, an error as { error: '#DIV/0!' }, or a DateCell or
   * DateTimeCell when the cell's number format is a date format. Formula cells hold their cached
   * result; a formula without one has the value null.
   */
  v: RawField;
  /** The format code of the cell's number format; null for General. */
  numFmt: string | null;
  /** True when the value was converted to a DateCell or DateTimeCell. */
  isDate: boolean;
  /** True when the cell holds a formula; the formula itself is never evaluated or kept. */
  formula: boolean;
}

export interface XlsxRow {
  /** 0-based sheet row. */
  r: number;
  /** The cells that hold a value or a formula, in column order. */
  cells: XlsxCell[];
}

export interface XlsxSheet {
  name: string;
  state: SheetState;
  /** The used range of the cells that hold a value, e.g. 'A1:F120'; 'A1' for an empty sheet. */
  dimension: string;
  merges: CellRange[];
  /** The frozen pane: the first unfrozen row and column (A2 is { r: 1, c: 0 }); null when nothing is frozen. */
  frozen: { r: number; c: number } | null;
  autoFilter: CellRange | null;
  /** Rows that hold at least one cell, in row order. */
  rows: XlsxRow[];
}

export interface XlsxWorkbook {
  sheets: { name: string; state: SheetState }[];
  /** True when serial dates count from 1904-01-01 (the old Mac system) rather than 1900. */
  date1904: boolean;
  /** Parses one worksheet. Throws EngineError('NOT_FOUND') for a name the workbook does not have. */
  readSheet(name: string): XlsxSheet;
}

/** One table found in a sheet by layout detection. */
export interface TableBlock {
  /** From the first header row to the last data row; title rows above the header are outside it. */
  range: CellRange;
  /** First and last header row, 0-based and inclusive; a units row under the names is the last one. */
  headerRows: [number, number];
  dataStartRow: number;
  /** One name per column of the range, e.g. 'Pressure / Max [psi]'. */
  flattenedHeader: string[];
  /** The header rows as text, one array per row across the range's columns, merged values repeated. */
  headerCells: string[][];
  /** TW-IMP-003 when several header rows were joined; TW-IMP-002 on every block after the first. */
  notes: ImportNote[];
}

export type XlsxColumnKind = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime';

export type XlsxWriteValue = string | number | boolean | DateCell | DateTimeCell | null;

export interface XlsxWriteSheet {
  name: string;
  /** `width` is in Excel character units; without it the width follows the longest text in the column. */
  columns: { header: string; kind: XlsxColumnKind; width?: number }[];
  /** One array per row with one value per column; null leaves the cell empty. */
  rows: Iterable<XlsxWriteValue[]>;
  /** Freezes the header row (pane at A2). */
  freezeHeader: boolean;
  /** Adds an autofilter over the header and all data rows. */
  autoFilter: boolean;
}

export interface XlsxWriteBook {
  sheets: XlsxWriteSheet[];
  /** Written as both the created and the modified time, so the bytes never depend on the wall clock. */
  created: IsoUtc;
  creator: string;
  title?: string;
}
