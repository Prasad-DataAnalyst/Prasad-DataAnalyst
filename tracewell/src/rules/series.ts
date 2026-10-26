/**
 * Time-series helpers shared by the time rules: the first time column, the first id column, and the
 * rows of each id group in file order or sorted by time (then file order).
 */
import type { CellValue, ColumnId, ColumnSchema, RowId } from '@tw/model';
import type { View } from '@tw/table';

export interface SeriesColumns {
  time: ColumnSchema;
  id: ColumnSchema | null;
}

export function seriesColumns(view: View): SeriesColumns | null {
  const cols = view.schema.columns;
  const time = cols.find((c) => c.role.value === 'time' && (c.type.value === 'date' || c.type.value === 'datetime'));
  if (time === undefined) return null;
  return { time, id: cols.find((c) => c.role.value === 'id') ?? null };
}

/** Milliseconds since the epoch for a date or date-time cell; null otherwise. */
export function timeValue(v: CellValue): number | null {
  if (v === null || typeof v !== 'object') return null;
  if ('date' in v) {
    const [y, m, d] = v.date.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  }
  if ('datetime' in v) return Date.parse(v.datetime);
  return null;
}

/** A group key that distinguishes value types, so 1 and '1' are different groups. */
export function keyOf(v: CellValue): string {
  return v === null ? '\u0000null' : JSON.stringify(v);
}

export interface TimedRow {
  row: RowId;
  t: number;
  /** Position in file order, used to break time ties. */
  order: number;
}

/** Visible rows with a time, grouped by id (one group when there is no id column), in file order. */
export function groupsInFileOrder(view: View, s: SeriesColumns): TimedRow[][] {
  const groups = new Map<string, TimedRow[]>();
  for (let i = 0; i < view.rowCount; i++) {
    const row = view.rowIdAt(i);
    const t = timeValue(view.value(row, s.time.id));
    if (t === null || !Number.isFinite(t)) continue;
    const key = s.id === null ? '' : keyOf(view.value(row, s.id.id));
    let g = groups.get(key);
    if (g === undefined) {
      g = [];
      groups.set(key, g);
    }
    g.push({ row, t, order: i });
  }
  return [...groups.values()];
}

export function sortedByTime(group: TimedRow[]): TimedRow[] {
  return [...group].sort((a, b) => a.t - b.t || a.order - b.order);
}

export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

export function columnValues(view: View, rows: TimedRow[], c: ColumnId): CellValue[] {
  return rows.map((r) => view.value(r.row, c));
}
