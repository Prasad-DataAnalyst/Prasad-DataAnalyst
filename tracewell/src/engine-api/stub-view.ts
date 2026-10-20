/**
 * The stub's data layer: parsing the canned text, building working and output views through the
 * recorded steps, unit conversion, filter predicates and column statistics. It mirrors the real
 * engine's semantics closely enough for UI work and is never used to produce real results.
 */
import {
  canonicalCell,
  detection,
  EngineError,
  isDateCell,
  isDateTimeCell,
  type CellValue,
  type ColumnId,
  type ColumnSchema,
  type ColumnStats,
  type ConversionMethod,
  type DatasetId,
  type Predicate,
  type PredicateValue,
  type RowId,
  type Step,
  type StepInput,
} from '@tw/model';
import { findUnit, SOURCE_ROWS, STUB_REGISTRY_VERSION, type StubUnit } from './stub-data';

export interface StubDataset {
  id: DatasetId;
  name: string;
  /** Source columns, with any detection overrides applied. */
  columns: ColumnSchema[];
  /** Overlay of edited cells, keyed by cellKey(). */
  edits: Map<string, CellValue>;
  /** Excluded rows and the audit entry that excluded each. */
  excluded: Map<RowId, number>;
  steps: Step[];
  checked: boolean;
}

export interface ViewColumn {
  schema: ColumnSchema;
  derived: boolean;
  value(rowId: RowId): CellValue;
  edited(rowId: RowId): boolean;
  /** The source text behind the value (for a derived column, the text of the column it converts). */
  raw(rowId: RowId): string | null;
}

export interface StubView {
  columns: ViewColumn[];
  rows: RowId[];
}

export function cellKey(rowId: RowId, columnId: ColumnId): string {
  return `${rowId}:${columnId}`;
}

export function rowCount(): number {
  return SOURCE_ROWS.length;
}

/** Parses source text with the column's current detections, as the import would. */
export function parseText(text: string, column: ColumnSchema): CellValue {
  if (text === '' || column.nullMarkers.value.includes(text)) return null;
  switch (column.type.value) {
    case 'string':
      return text;
    case 'integer':
    case 'number': {
      const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim()) ? Number(text) : NaN;
      return Number.isFinite(n) && (column.type.value === 'number' || Number.isInteger(n)) ? n : null;
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : null;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { date: text } : null;
    case 'datetime':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ? { datetime: text } : null;
    case 'geometry':
      return null;
  }
}

function sourceColumn(ds: StubDataset, column: ColumnSchema): ViewColumn {
  const raw = (rowId: RowId): string | null => SOURCE_ROWS[rowId]?.[column.sourceIndex] ?? null;
  const key = (rowId: RowId): string => cellKey(rowId, column.id);
  return {
    schema: column,
    derived: false,
    value: (rowId) => (ds.edits.has(key(rowId)) ? (ds.edits.get(key(rowId)) ?? null) : parseText(raw(rowId) ?? '', column)),
    edited: (rowId) => ds.edits.has(key(rowId)),
    raw,
  };
}

/** The working view: source data, edits and unit conversions, without excluded rows. */
export function workingView(ds: StubDataset): StubView {
  let columns = ds.columns.map((c) => sourceColumn(ds, c));
  for (const step of ds.steps) {
    if (step.kind === 'convert_unit') columns = withConversion(columns, step);
  }
  const rows: RowId[] = [];
  for (let r = 0; r < rowCount(); r++) if (!ds.excluded.has(r)) rows.push(r);
  return { columns, rows };
}

/** The output view: the working view after filters and column selection. */
export function outputView(ds: StubDataset): StubView {
  const view = workingView(ds);
  let { columns, rows } = view;
  for (const step of ds.steps) {
    if (step.kind === 'filter') rows = rows.filter((r) => matches(step.predicate, columns, r));
    if (step.kind === 'select_columns') {
      const keep = new Set(step.columnIds);
      columns = columns.filter((c) => keep.has(c.schema.id));
    }
  }
  return { columns, rows };
}

export function viewOf(ds: StubDataset, stage: 'working' | 'output'): StubView {
  return stage === 'working' ? workingView(ds) : outputView(ds);
}

export function findColumn(view: StubView, columnId: ColumnId): ViewColumn {
  const column = view.columns.find((c) => c.schema.id === columnId);
  if (column === undefined) {
    throw new EngineError('NOT_FOUND', `There is no column ${columnId} in this view.`, 'Choose a column shown in the grid.');
  }
  return column;
}

/** The source column a column comes from: 'c3' for 'c3~kPa' and for 'c3' itself. */
export function rootColumn(columnId: ColumnId): ColumnId {
  return columnId.split('~')[0] ?? columnId;
}

/** 'c3~kPa': the derived column ID, with the unit code reduced to [A-Za-z0-9_]. */
export function derivedId(columnId: ColumnId, toUnit: string): ColumnId {
  return `${columnId}~${toUnit.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function withConversion(columns: ViewColumn[], step: Step & { kind: 'convert_unit' }): ViewColumn[] {
  const index = columns.findIndex((c) => c.schema.id === step.columnId);
  const source = columns[index];
  if (source === undefined) return columns;
  const method = conversionMethod(source.schema, step.toUnit);
  const derived: ViewColumn = {
    schema: {
      ...source.schema,
      id: derivedId(source.schema.id, step.toUnit),
      unit: detection<string | null>(step.toUnit, 'high', 'convert_unit', `Converted from ${method.from} by step ${step.id}.`),
      derivedFrom: { column: source.schema.id, step: step.id },
    },
    derived: true,
    value: (rowId) => convertValue(source.value(rowId), method),
    edited: source.edited,
    raw: source.raw,
  };
  const next = [...columns];
  if (step.mode === 'replace') next.splice(index, 1, derived);
  else next.splice(index + 1, 0, derived);
  return next;
}

export function convertValue(v: CellValue, m: ConversionMethod): CellValue {
  return typeof v === 'number' ? (v * m.fromFactor + m.fromOffset - m.toOffset) / m.toFactor : v;
}

/** The conversion from a column's unit to `toUnit`, refused with the same codes as the real units library. */
export function conversionMethod(column: ColumnSchema, toUnit: string): ConversionMethod {
  const from = findUnit(column.unit.value);
  const to = findUnit(toUnit);
  if (column.type.value !== 'number' && column.type.value !== 'integer') {
    throw new EngineError('INVALID_INPUT', `${column.name} is not a numeric column.`, 'Choose a numeric column to convert.');
  }
  if (from === undefined) {
    throw new EngineError(
      'UNIT_UNKNOWN',
      `${column.name} has no recognised unit to convert from.`,
      'Set the column unit first (override the unit detection), then convert.',
    );
  }
  if (to === undefined) {
    throw new EngineError('UNIT_UNKNOWN', `The unit '${toUnit}' is not in the unit registry.`, 'Choose a unit from the list.');
  }
  guardCompatible(from, to);
  return {
    from: from.code,
    to: to.code,
    fromFactor: from.toSI.factor,
    fromOffset: from.toSI.offset,
    toFactor: to.toSI.factor,
    toOffset: to.toSI.offset,
    formula: `y = x * ${from.toSI.factor} / ${to.toSI.factor}`,
    source: from.source === to.source ? from.source : `${from.source}; ${to.source}`,
    registryVersion: STUB_REGISTRY_VERSION,
  };
}

function guardCompatible(from: StubUnit, to: StubUnit): void {
  if (from.code === to.code) {
    throw new EngineError('INVALID_INPUT', `The column is already in ${to.code}.`, 'Choose a different target unit.');
  }
  const kinds = new Set([from.quantity, to.quantity]);
  if (kinds.has('pressure_abs') && kinds.has('pressure_gauge')) {
    throw new EngineError(
      'UNIT_GAUGE_ABSOLUTE',
      `${from.code} and ${to.code} differ by the atmospheric pressure, which the data does not record.`,
      'Convert to a unit of the same kind (gauge to gauge, absolute to absolute).',
    );
  }
  if (from.convention !== to.convention && kinds.size === 2 && [...kinds].some((k) => k.startsWith('std_'))) {
    throw new EngineError(
      'UNIT_CONVENTION',
      `${from.code} and ${to.code} are measured at different reference conditions.`,
      'Convert between units with the same reference conditions; conversions between conventions come later.',
    );
  }
  if (from.quantity !== to.quantity) {
    throw new EngineError(
      'UNIT_DIMENSION',
      `${from.code} (${from.quantity}) and ${to.code} (${to.quantity}) measure different things.`,
      `Choose a ${from.quantity.replace(/_/g, ' ')} unit.`,
    );
  }
}

/** Checks a step against the working view; throws the EngineError a preview reports. */
export function validateStep(ds: StubDataset, s: StepInput): void {
  const view = workingView(ds);
  switch (s.kind) {
    case 'convert_unit':
      conversionMethod(findColumn(view, s.columnId).schema, s.toUnit);
      return;
    case 'filter':
      for (const id of predicateColumns(s.predicate)) findColumn(view, id);
      return;
    case 'select_columns':
      if (s.columnIds.length === 0) {
        throw new EngineError('INVALID_INPUT', 'No columns were selected.', 'Select at least one column to keep.');
      }
      for (const id of s.columnIds) findColumn(view, id);
      return;
  }
}

function predicateColumns(p: Predicate): ColumnId[] {
  if ('all' in p) return p.all.flatMap(predicateColumns);
  if ('any' in p) return p.any.flatMap(predicateColumns);
  if ('not' in p) return predicateColumns(p.not);
  if ('bbox' in p) return 'geometry' in p ? [p.geometry] : [p.lat, p.lon];
  return [p.column];
}

/** Filter semantics as in SQL: every comparison with null is false; only 'is_null' matches null. */
export function matches(p: Predicate, columns: ViewColumn[], rowId: RowId): boolean {
  if ('all' in p) return p.all.every((q) => matches(q, columns, rowId));
  if ('any' in p) return p.any.some((q) => matches(q, columns, rowId));
  if ('not' in p) return !matches(p.not, columns, rowId);
  // The canned dataset has no geometry or coordinates, so no row lies inside a box.
  if ('bbox' in p) return false;
  const v = columns.find((c) => c.schema.id === p.column)?.value(rowId) ?? null;
  switch (p.op) {
    case 'is_null':
      return v === null;
    case 'not_null':
      return v !== null;
    case 'contains':
      return typeof v === 'string' && contains(v, p.text, p.caseSensitive === true);
    case 'in':
      return (typeof v === 'string' || typeof v === 'number') && p.values.includes(v);
    case 'between':
      return compare(v, p.low) >= 0 && compare(v, p.high) <= 0;
    default:
      return holds(p.op, compare(v, p.value));
  }
}

function contains(v: string, text: string, caseSensitive: boolean): boolean {
  return caseSensitive ? v.includes(text) : v.toLowerCase().includes(text.toLowerCase());
}

function holds(op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge', c: number): boolean {
  if (Number.isNaN(c)) return false;
  switch (op) {
    case 'eq':
      return c === 0;
    case 'ne':
      return c !== 0;
    case 'lt':
      return c < 0;
    case 'le':
      return c <= 0;
    case 'gt':
      return c > 0;
    case 'ge':
      return c >= 0;
  }
}

/** Orders a cell against a predicate value; NaN when they cannot be compared (null or different kinds). */
function compare(v: CellValue, w: PredicateValue): number {
  const a = sortKey(v);
  const b = sortKey(w);
  if (a === null || b === null || typeof a !== typeof b) return NaN;
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKey(v: CellValue | PredicateValue): number | string | null {
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isDateCell(v)) return v.date;
  if (isDateTimeCell(v)) return v.datetime;
  return null;
}

/** Column statistics over the working view. */
export function columnStats(column: ViewColumn, rows: RowId[]): ColumnStats {
  const counts = new Map<string, { value: CellValue; count: number }>();
  let nulls = 0;
  let rawRejected = 0;
  for (const r of rows) {
    const v = column.value(r);
    if (v === null) {
      nulls++;
      if (isRejected(column, r)) rawRejected++;
      continue;
    }
    const key = canonicalCell(v);
    const entry = counts.get(key) ?? { value: v, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const values = [...counts.values()];
  const ordered = values.map((e) => e.value).sort((a, b) => compare(a, b as PredicateValue) || 0);
  const numbers = values.flatMap((e) => (typeof e.value === 'number' ? Array<number>(e.count).fill(e.value) : []));
  return {
    columnId: column.schema.id,
    count: rows.length,
    nulls,
    rawRejected,
    distinct: values.length,
    distinctCapped: false,
    min: ordered[0] ?? null,
    max: ordered[ordered.length - 1] ?? null,
    mean: numbers.length === 0 ? null : numbers.reduce((s, n) => s + n, 0) / numbers.length,
    topValues: values.sort((a, b) => b.count - a.count).slice(0, 5),
  };
}

/** A null whose source text was neither empty nor a null marker: the text did not fit the type. */
function isRejected(column: ViewColumn, rowId: RowId): boolean {
  if (column.edited(rowId)) return false;
  const raw = column.raw(rowId);
  return raw !== null && raw !== '' && !column.schema.nullMarkers.value.includes(raw);
}
