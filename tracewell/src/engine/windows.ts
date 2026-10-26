/**
 * Windowed reads (SAD section 4.1): the data grid asks for at most ROW_WINDOW_MAX rows at a time,
 * with each cell's edit marker and the worst open issue severity, and for one column's statistics.
 */
import {
  EngineError,
  ROW_WINDOW_MAX,
  canonicalCell,
  isDateCell,
  isDateTimeCell,
  type CellValue,
  type ColumnId,
  type ColumnSchema,
  type ColumnStats,
  type RowId,
  type RowWindow,
  type RowWindowRequest,
  type Severity,
} from '@tw/model';
import { locator, type View } from '@tw/table';
import { worse } from './issues-state';
import type { DatasetState } from './state';
import { viewFor, workingView } from './views';

/** Distinct values are counted up to this many; beyond it `distinctCapped` is set. */
const DISTINCT_CAP = 10_000;
const TOP_VALUES = 5;

export function invalid(message: string, fix: string): EngineError {
  return new EngineError('INVALID_INPUT', message, fix);
}

export function requireCount(v: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) {
    throw invalid(`${name} must be a whole number from 0 to ${max}; it was ${String(v)}.`, `Pass a valid ${name}.`);
  }
  return v;
}

export function requireStage(stage: unknown): 'working' | 'output' {
  if (stage === 'working' || stage === 'output') return stage;
  throw invalid(`The stage ${String(stage)} does not exist.`, "Ask for the 'working' or the 'output' stage.");
}

/** The source column a column comes from: itself, or the column a conversion step derived it from. */
export function rootColumn(view: View, columnId: ColumnId): ColumnId {
  let id = columnId;
  for (let schema = view.columnSchema(id); schema.derivedFrom !== undefined;) {
    id = schema.derivedFrom.column;
    schema = view.columnSchema(id);
  }
  return id;
}

export function requireVisibleColumn(view: View, columnId: ColumnId): ColumnSchema {
  const schema = view.schema.columns.find((c) => c.id === columnId);
  if (schema === undefined) {
    throw new EngineError(
      'NOT_FOUND',
      `Dataset ${view.schema.datasetId} has no column ${String(columnId)} at this stage.`,
      'Choose a listed column.',
      { columnId: String(columnId) },
    );
  }
  return schema;
}

function isAssumed(c: ColumnSchema): boolean {
  return c.type.assumed || c.role.assumed || c.unit.assumed || c.nullMarkers.assumed;
}

/** Worst open severity of row-scope issues per row and source column, for the rows asked about. */
function severities(ds: DatasetState, rows: RowId[]): Map<string, Severity> {
  const worst = new Map<string, Severity>();
  for (const st of ds.issues.values()) {
    if (st.draft.scope !== 'rows') continue;
    for (const r of rows) {
      if (!st.current.has(r) || st.accepted.has(r) || ds.excluded.has(r)) continue;
      for (const c of st.draft.columns) {
        const key = `${r}:${c}`;
        worst.set(key, worse(worst.get(key) ?? null, st.draft.severity));
      }
    }
  }
  return worst;
}

export function rowWindow(ds: DatasetState, q: RowWindowRequest): RowWindow {
  const stage = requireStage(q.stage);
  const offset = requireCount(q.offset, 'offset');
  const limit = requireCount(q.limit, 'limit', ROW_WINDOW_MAX);
  const view = viewFor(ds, stage);
  const columns = (q.columns ?? view.columnIds()).map((id) => requireVisibleColumn(view, id));
  const roots = columns.map((c) => rootColumn(view, c.id));
  const end = Math.min(view.rowCount, offset + limit);
  const rowIds: RowId[] = [];
  for (let i = offset; i < end; i++) rowIds.push(view.rowIdAt(i));
  const worst = severities(ds, rowIds);
  return {
    datasetId: ds.id,
    stage,
    offset,
    totalRows: view.rowCount,
    columns: columns.map((c) => ({
      id: c.id,
      name: c.name,
      unit: c.unit.value,
      type: c.type.value,
      assumed: isAssumed(c),
      derived: c.derivedFrom !== undefined,
    })),
    rows: rowIds.map((rowId) => ({
      rowId,
      locator: locator(ds.dataset.schema, ds.dataset.srcLoc(rowId)),
      cells: columns.map((c) => view.value(rowId, c.id)),
      edited: columns.map((c, j) => view.isEdited(rowId, c.id) || view.isEdited(rowId, roots[j] as ColumnId)),
      // Checks run on the working view, so an issue may name a converted column or its source.
      issue: columns.map((c, j) => {
        const own = worst.get(`${rowId}:${c.id}`) ?? null;
        const source = worst.get(`${rowId}:${roots[j] as ColumnId}`);
        return source === undefined ? own : worse(own, source);
      }),
    })),
  };
}

/** Code-unit order for text, numeric order for numbers, then dates; geometries have no order. */
function compareCells(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const ta = isDateCell(a) ? a.date : isDateTimeCell(a) ? a.datetime : null;
  const tb = isDateCell(b) ? b.date : isDateTimeCell(b) ? b.datetime : null;
  if (ta !== null && tb !== null) return ta < tb ? -1 : ta > tb ? 1 : 0;
  return 0;
}

function orderable(v: CellValue): boolean {
  return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || isDateCell(v) || isDateTimeCell(v);
}

export function columnStats(ds: DatasetState, columnId: ColumnId): ColumnStats {
  const view = workingView(ds);
  const schema = requireVisibleColumn(view, columnId);
  const base = schema.derivedFrom === undefined ? ds.dataset.column(columnId) : null;
  const counts = new Map<string, { value: CellValue; count: number }>();
  let count = 0;
  let nulls = 0;
  let rawRejected = 0;
  let capped = false;
  let min: CellValue = null;
  let max: CellValue = null;
  let sum = 0;
  let numeric = 0;
  for (const r of view.rows()) {
    count++;
    const v = view.value(r, columnId);
    if (v === null) {
      nulls++;
      if (base !== null && !view.isEdited(r, columnId) && !base.parseOk(r)) rawRejected++;
      continue;
    }
    if (typeof v === 'number') {
      sum += v;
      numeric++;
    }
    if (orderable(v)) {
      if (min === null || compareCells(v, min) < 0) min = v;
      if (max === null || compareCells(v, max) > 0) max = v;
    }
    const key = canonicalCell(v);
    const entry = counts.get(key);
    if (entry !== undefined) entry.count++;
    else if (counts.size < DISTINCT_CAP) counts.set(key, { value: v, count: 1 });
    else capped = true;
  }
  const top = [...counts.entries()]
    .sort(([ka, a], [kb, b]) => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, TOP_VALUES)
    .map(([, e]) => ({ value: e.value, count: e.count }));
  return {
    columnId,
    count,
    nulls,
    rawRejected,
    distinct: counts.size,
    distinctCapped: capped,
    min,
    max,
    mean: numeric === 0 ? null : sum / numeric,
    topValues: top,
  };
}
