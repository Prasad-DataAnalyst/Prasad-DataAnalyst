/**
 * One worksheet part (xl/worksheets/sheetN.xml) parsed with saxes into rows of typed cells, plus
 * the merged ranges, the frozen pane and the autofilter. Formulas are never evaluated: a formula
 * cell holds the result its producer cached, and the formula text is dropped.
 */
import type { RawField } from '@tw/model';
import { isoToDateValue, serialToDateValue } from './dates';
import { damagedWorkbook } from './errors';
import { formatRange, parseCellRef, parseRange } from './refs';
import type { StyleTable } from './styles';
import type { CellRange, SheetState, XlsxCell, XlsxCellType, XlsxRow, XlsxSheet } from './types';
import { attr, decodeXstring, parseXml, type Attributes } from './xml';

export interface SheetContext {
  name: string;
  state: SheetState;
  sharedStrings: readonly string[];
  styles: StyleTable;
  date1904: boolean;
}

const CELL_TYPES: ReadonlySet<string> = new Set(['n', 's', 'b', 'e', 'str', 'inlineStr', 'd']);
/** A plain decimal number as SpreadsheetML writes it; Number() alone would also take '0x1F' or ' '. */
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** What one <c> element held, collected while it is parsed. */
interface PendingCell {
  col: number;
  type: XlsxCellType;
  style: number;
  value: string;
  hasValue: boolean;
  inline: string;
  hasInline: boolean;
  formula: boolean;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Where the values of the cell being parsed come from. */
type TextTarget = 'value' | 'inline' | null;

class SheetParser {
  readonly #ctx: SheetContext;
  readonly #part: string;
  readonly rows: XlsxRow[] = [];
  readonly merges: CellRange[] = [];
  frozen: { r: number; c: number } | null = null;
  autoFilter: CellRange | null = null;
  #depth = 0;
  #sheetViews = 0;
  #row: XlsxRow | null = null;
  /** True when the current row's number comes from its r attribute rather than its position. */
  #rowNumbered = false;
  #nextRow = 0;
  #nextCol = 0;
  #cell: PendingCell | null = null;
  #inInline = false;
  #phoneticDepth = 0;
  #target: TextTarget = null;

  constructor(ctx: SheetContext, part: string) {
    this.#ctx = ctx;
    this.#part = part;
  }

  open(name: string, attrs: Attributes): void {
    const depth = this.#depth;
    this.#depth += 1;
    if (this.#cell !== null) {
      this.#openInCell(name);
      return;
    }
    switch (name) {
      case 'row':
        this.#openRow(attrs);
        return;
      case 'c':
        this.#openCell(attrs);
        return;
      case 'mergeCell':
        this.#addMerge(attr(attrs, 'ref'));
        return;
      case 'sheetView':
        this.#sheetViews += 1;
        return;
      case 'pane':
        if (this.#sheetViews === 1) this.#readPane(attrs);
        return;
      case 'autoFilter':
        // Custom sheet views carry their own autofilters; only the sheet's own one counts.
        if (depth === 1) this.autoFilter = parseRange(attr(attrs, 'ref') ?? '');
        return;
    }
  }

  close(name: string): void {
    this.#depth -= 1;
    if (this.#cell !== null) {
      this.#closeInCell(name);
      return;
    }
    if (name === 'row' && this.#row !== null) {
      if (this.#row.cells.length > 0) this.rows.push(this.#row);
      this.#nextRow = this.#row.r + 1;
      this.#row = null;
    }
  }

  text(t: string): void {
    if (this.#cell === null || this.#target === null) return;
    if (this.#target === 'value') this.#cell.value += t;
    else this.#cell.inline += t;
  }

  #openRow(attrs: Attributes): void {
    const r = nonNegativeInt(attr(attrs, 'r'), 0) - 1;
    this.#row = { r: r >= 0 ? r : this.#nextRow, cells: [] };
    this.#rowNumbered = r >= 0;
    this.#nextCol = 0;
  }

  #openCell(attrs: Attributes): void {
    const ref = attr(attrs, 'r');
    const at = ref === undefined ? null : parseCellRef(ref);
    if (ref !== undefined && at === null) {
      throw damagedWorkbook(`a cell in sheet "${this.#ctx.name}" has the invalid reference "${ref}".`, {
        sheet: this.#ctx.name,
        ref,
      });
    }
    // A cell outside any <row>, or in a row without a number, still says where it belongs.
    if (this.#row === null) {
      this.#row = { r: at?.r ?? this.#nextRow, cells: [] };
      this.#rowNumbered = at !== null;
    } else if (!this.#rowNumbered && at !== null && this.#row.cells.length === 0) {
      this.#row.r = at.r;
      this.#rowNumbered = true;
    }
    const t = attr(attrs, 't') ?? 'n';
    this.#cell = {
      col: at?.c ?? this.#nextCol,
      type: (CELL_TYPES.has(t) ? t : 'str') as XlsxCellType,
      style: nonNegativeInt(attr(attrs, 's'), 0),
      value: '',
      hasValue: false,
      inline: '',
      hasInline: false,
      formula: false,
    };
  }

  #openInCell(name: string): void {
    const cell = this.#cell as PendingCell;
    if (name === 'v') {
      cell.hasValue = true;
      this.#target = 'value';
    } else if (name === 'f') {
      cell.formula = true;
    } else if (name === 'is') {
      cell.hasInline = true;
      this.#inInline = true;
    } else if (name === 'rPh') {
      this.#phoneticDepth += 1;
    } else if (name === 't' && this.#inInline && this.#phoneticDepth === 0) {
      this.#target = 'inline';
    }
  }

  #closeInCell(name: string): void {
    if (name === 'v' || name === 't') this.#target = null;
    else if (name === 'is') this.#inInline = false;
    else if (name === 'rPh') this.#phoneticDepth -= 1;
    else if (name === 'c') this.#finishCell();
  }

  #finishCell(): void {
    const pending = this.#cell as PendingCell;
    const row = this.#row as XlsxRow;
    this.#cell = null;
    this.#target = null;
    this.#inInline = false;
    this.#phoneticDepth = 0;
    this.#nextCol = pending.col + 1;
    const cell = this.#toCell(pending, row.r);
    if (cell.v !== null || cell.formula) row.cells.push(cell);
  }

  #toCell(p: PendingCell, r: number): XlsxCell {
    const format = this.#ctx.styles.format(p.style);
    const base = { c: p.col, t: p.type, numFmt: format.numFmt, formula: p.formula };
    switch (p.type) {
      case 'n': {
        const text = p.value.trim();
        if (!p.hasValue || text === '') return { ...base, v: null, isDate: false };
        if (!NUMBER_TEXT.test(text)) return { ...base, v: text, isDate: false };
        const n = Number(text);
        const date = format.dateKind === null ? null : serialToDateValue(n, this.#ctx.date1904, format.dateKind);
        return date === null ? { ...base, v: n, isDate: false } : { ...base, v: date, isDate: true };
      }
      case 'd': {
        if (!p.hasValue || p.value.trim() === '') return { ...base, v: null, isDate: false };
        const date = isoToDateValue(p.value, format.dateKind);
        return date === null ? { ...base, v: p.value, isDate: false } : { ...base, v: date, isDate: true };
      }
      default:
        return { ...base, v: this.#textValue(p, r), isDate: false };
    }
  }

  #textValue(p: PendingCell, r: number): RawField {
    switch (p.type) {
      case 's':
        return p.hasValue ? this.#sharedString(p.value, r, p.col) : null;
      case 'b':
        return p.hasValue ? booleanValue(p.value) : null;
      case 'e':
        return p.value.trim() === '' ? null : { error: p.value.trim() };
      case 'inlineStr':
        if (p.hasInline) return decodeXstring(p.inline);
        return p.hasValue ? decodeXstring(p.value) : null;
      default:
        return p.hasValue ? decodeXstring(p.value) : null;
    }
  }

  #sharedString(text: string, r: number, c: number): string {
    const index = Number(text.trim());
    const value = Number.isInteger(index) ? this.#ctx.sharedStrings[index] : undefined;
    if (value !== undefined) return value;
    throw damagedWorkbook(
      `cell ${formatRange({ s: { r, c }, e: { r, c } })} of sheet "${this.#ctx.name}" refers to shared string ` +
        `"${text}", which the workbook does not have.`,
      { sheet: this.#ctx.name, part: this.#part, index: text },
    );
  }

  #addMerge(ref: string | undefined): void {
    const range = ref === undefined ? null : parseRange(ref);
    if (range !== null && (range.s.r !== range.e.r || range.s.c !== range.e.c)) this.merges.push(range);
  }

  #readPane(attrs: Attributes): void {
    const state = attr(attrs, 'state');
    if (state !== 'frozen' && state !== 'frozenSplit') return;
    const r = Math.trunc(Number(attr(attrs, 'ySplit') ?? '0'));
    const c = Math.trunc(Number(attr(attrs, 'xSplit') ?? '0'));
    const rows = Number.isFinite(r) && r > 0 ? r : 0;
    const cols = Number.isFinite(c) && c > 0 ? c : 0;
    if (rows > 0 || cols > 0) this.frozen = { r: rows, c: cols };
  }
}

function booleanValue(text: string): RawField {
  const t = text.trim();
  if (t === '1' || t === 'true') return true;
  if (t === '0' || t === 'false') return false;
  return t;
}

/** Rows and cells in order, one entry per row and per column; producers may write them out of order. */
function normalised(rows: XlsxRow[]): XlsxRow[] {
  const byRow = new Map<number, Map<number, XlsxCell>>();
  for (const row of rows) {
    const cells = byRow.get(row.r) ?? new Map<number, XlsxCell>();
    for (const cell of row.cells) cells.set(cell.c, cell);
    byRow.set(row.r, cells);
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, cells]) => ({ r, cells: [...cells.values()].sort((a, b) => a.c - b.c) }));
}

function isOrdered(rows: readonly XlsxRow[]): boolean {
  let lastRow = -1;
  for (const row of rows) {
    if (row.r <= lastRow) return false;
    lastRow = row.r;
    let lastCol = -1;
    for (const cell of row.cells) {
      if (cell.c <= lastCol) return false;
      lastCol = cell.c;
    }
  }
  return true;
}

/** The used range of the cells that hold a value; 'A1' when there are none. */
function usedRange(rows: readonly XlsxRow[]): string {
  let range: CellRange | null = null;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.v === null) continue;
      if (range === null) range = { s: { r: row.r, c: cell.c }, e: { r: row.r, c: cell.c } };
      range.s.r = Math.min(range.s.r, row.r);
      range.e.r = Math.max(range.e.r, row.r);
      range.s.c = Math.min(range.s.c, cell.c);
      range.e.c = Math.max(range.e.c, cell.c);
    }
  }
  return range === null ? 'A1' : formatRange(range);
}

export function parseSheet(bytes: Uint8Array, part: string, ctx: SheetContext): XlsxSheet {
  const p = new SheetParser(ctx, part);
  parseXml(bytes, part, {
    open: (name, attrs) => p.open(name, attrs),
    close: (name) => p.close(name),
    text: (t) => p.text(t),
  });
  const rows = isOrdered(p.rows) ? p.rows : normalised(p.rows);
  return {
    name: ctx.name,
    state: ctx.state,
    dimension: usedRange(rows),
    merges: p.merges,
    frozen: p.frozen,
    autoFilter: p.autoFilter,
    rows,
  };
}
