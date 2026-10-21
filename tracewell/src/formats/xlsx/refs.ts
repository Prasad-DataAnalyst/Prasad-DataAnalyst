/**
 * A1 cell references: 'C17' is row 16, column 2 in this module's 0-based coordinates. Excel's grid
 * is 1,048,576 rows by 16,384 columns (A to XFD); references outside it are not valid.
 */
import type { CellRange } from './types';

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/;

/** 0 -> 'A', 25 -> 'Z', 26 -> 'AA'. */
export function columnName(c: number): string {
  let name = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** 'A' -> 0, 'aa' -> 26; -1 when the letters name no column of the grid. */
export function columnIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n <= MAX_COLS ? n - 1 : -1;
}

export function formatCellRef(r: number, c: number): string {
  return `${columnName(c)}${r + 1}`;
}

/** 'B3' or '$B$3' -> { r: 2, c: 1 }; null when the text is not a reference inside the grid. */
export function parseCellRef(ref: string): { r: number; c: number } | null {
  const match = CELL_REF.exec(ref);
  if (match === null) return null;
  const c = columnIndex(match[1] ?? '');
  const r = Number(match[2]) - 1;
  return c < 0 || r >= MAX_ROWS ? null : { r, c };
}

/** 'A1:C3', '$A$1:$C$3' or a single cell 'B2'; corners are put in order. Null when not a range. */
export function parseRange(ref: string): CellRange | null {
  const parts = ref.trim().split(':');
  if (parts.length > 2) return null;
  const a = parseCellRef(parts[0] ?? '');
  const b = parts.length === 2 ? parseCellRef(parts[1] ?? '') : a;
  if (a === null || b === null) return null;
  return {
    s: { r: Math.min(a.r, b.r), c: Math.min(a.c, b.c) },
    e: { r: Math.max(a.r, b.r), c: Math.max(a.c, b.c) },
  };
}

/** A single cell is written as 'B2', anything larger as 'A1:C3'. */
export function formatRange(range: CellRange): string {
  const start = formatCellRef(range.s.r, range.s.c);
  const single = range.s.r === range.e.r && range.s.c === range.e.c;
  return single ? start : `${start}:${formatCellRef(range.e.r, range.e.c)}`;
}

export function rangeContains(range: CellRange, r: number, c: number): boolean {
  return r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c;
}
