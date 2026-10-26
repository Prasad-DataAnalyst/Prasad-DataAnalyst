/**
 * Random access to a parsed sheet for layout detection and table reading: cell values by position,
 * merged ranges, and which cells are occupied. A merged range counts as occupied in full when its
 * top-left cell holds a value, so a title or group header merged across columns holds the block
 * together instead of leaving blank cells that would split it.
 */
import type { RawField } from '@tw/model';
import { rangeContains } from './refs';
import type { CellRange, XlsxRow, XlsxSheet } from './types';

/** Merged ranges larger than this are not filled in, so one huge merge cannot exhaust memory. */
const MAX_MERGE_FILL_CELLS = 100_000;

/** Empty cells and text that is only white space carry no data. */
export function isBlank(v: RawField): boolean {
  return v === null || (typeof v === 'string' && v.trim() === '');
}

/** Index of the first element >= x in an ascending array. */
function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Runs of consecutive integers in an ascending array: [1, 2, 3, 7, 8] -> [[1, 3], [7, 8]]. */
export function runs(sorted: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

export class SheetGrid {
  readonly sheet: XlsxSheet;
  /** Rows with at least one occupied cell, ascending. */
  readonly occupiedRows: readonly number[];
  readonly #rows: Map<number, XlsxRow>;
  readonly #occupied: Map<number, number[]>;

  constructor(sheet: XlsxSheet) {
    this.sheet = sheet;
    this.#rows = new Map(sheet.rows.map((row) => [row.r, row]));
    this.#occupied = new Map();
    for (const row of sheet.rows) {
      const cols = row.cells.filter((cell) => !isBlank(cell.v)).map((cell) => cell.c);
      if (cols.length > 0) this.#occupied.set(row.r, cols);
    }
    this.#fillMerges();
    this.occupiedRows = [...this.#occupied.keys()].sort((a, b) => a - b);
  }

  /** The value stored in a cell; null for an empty cell or one hidden under a merge. */
  value(r: number, c: number): RawField {
    const cells = this.#rows.get(r)?.cells;
    if (cells === undefined) return null;
    let lo = 0;
    let hi = cells.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cell = cells[mid];
      if (cell === undefined) break;
      if (cell.c === c) return cell.v;
      if (cell.c < c) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** The non-blank stored values of a row between two columns, in column order. */
  rowValues(r: number, c1: number, c2: number): { c: number; v: RawField }[] {
    const cells = this.#rows.get(r)?.cells ?? [];
    return cells.filter((cell) => cell.c >= c1 && cell.c <= c2 && !isBlank(cell.v)).map(({ c, v }) => ({ c, v }));
  }

  /** The merged range that covers a cell, or null. */
  mergeAt(r: number, c: number): CellRange | null {
    return this.sheet.merges.find((m) => rangeContains(m, r, c)) ?? null;
  }

  /** The value a cell shows: its own, or that of the merged range covering it. */
  shownValue(r: number, c: number): RawField {
    const merge = this.mergeAt(r, c);
    return merge === null ? this.value(r, c) : this.value(merge.s.r, merge.s.c);
  }

  rowHasOccupied(r: number, c1: number, c2: number): boolean {
    const cols = this.#occupied.get(r);
    if (cols === undefined) return false;
    const i = lowerBound(cols, c1);
    return i < cols.length && (cols[i] as number) <= c2;
  }

  /** Occupied rows between r1 and r2 that have an occupied cell between c1 and c2. */
  rowsIn(r1: number, r2: number, c1: number, c2: number): number[] {
    const start = lowerBound(this.occupiedRows, r1);
    const out: number[] = [];
    for (let i = start; i < this.occupiedRows.length; i++) {
      const r = this.occupiedRows[i] as number;
      if (r > r2) break;
      if (this.rowHasOccupied(r, c1, c2)) out.push(r);
    }
    return out;
  }

  /** Columns between c1 and c2 that are occupied in at least one row between r1 and r2, ascending. */
  colsIn(r1: number, r2: number, c1: number, c2: number): number[] {
    const seen = new Set<number>();
    for (const r of this.rowsIn(r1, r2, c1, c2)) {
      const cols = this.#occupied.get(r) ?? [];
      for (let i = lowerBound(cols, c1); i < cols.length && (cols[i] as number) <= c2; i++) seen.add(cols[i] as number);
    }
    return [...seen].sort((a, b) => a - b);
  }

  /** The smallest range holding every occupied cell, or null for an empty sheet. */
  bounds(): CellRange | null {
    const first = this.occupiedRows[0];
    const last = this.occupiedRows[this.occupiedRows.length - 1];
    if (first === undefined || last === undefined) return null;
    let c1 = Infinity;
    let c2 = -Infinity;
    for (const cols of this.#occupied.values()) {
      c1 = Math.min(c1, cols[0] as number);
      c2 = Math.max(c2, cols[cols.length - 1] as number);
    }
    return { s: { r: first, c: c1 }, e: { r: last, c: c2 } };
  }

  #fillMerges(): void {
    const valueBounds = this.#valueBounds();
    if (valueBounds === null) return;
    const extra = new Map<number, Set<number>>();
    for (const m of this.sheet.merges) {
      if (isBlank(this.value(m.s.r, m.s.c))) continue;
      const r2 = Math.min(m.e.r, valueBounds.e.r);
      const c2 = Math.min(m.e.c, valueBounds.e.c);
      if ((r2 - m.s.r + 1) * (c2 - m.s.c + 1) > MAX_MERGE_FILL_CELLS) continue;
      for (let r = m.s.r; r <= r2; r++) {
        const cols = extra.get(r) ?? new Set<number>();
        for (let c = m.s.c; c <= c2; c++) cols.add(c);
        extra.set(r, cols);
      }
    }
    for (const [r, cols] of extra) {
      for (const c of this.#occupied.get(r) ?? []) cols.add(c);
      this.#occupied.set(
        r,
        [...cols].sort((a, b) => a - b),
      );
    }
  }

  /** Bounds of the cells that hold values, before merges are filled in. */
  #valueBounds(): CellRange | null {
    let bounds: CellRange | null = null;
    for (const [r, cols] of this.#occupied) {
      const c1 = cols[0] as number;
      const c2 = cols[cols.length - 1] as number;
      if (bounds === null) bounds = { s: { r, c: c1 }, e: { r, c: c2 } };
      bounds.s.r = Math.min(bounds.s.r, r);
      bounds.e.r = Math.max(bounds.e.r, r);
      bounds.s.c = Math.min(bounds.s.c, c1);
      bounds.e.c = Math.max(bounds.e.c, c2);
    }
    return bounds;
  }
}
