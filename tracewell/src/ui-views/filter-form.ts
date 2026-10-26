/**
 * The filter builder's form, turned into the declarative predicate a filter step stores. Pure, so
 * the same rules apply in the dialog's live validation and in tests. Values are typed by the
 * column: a number column needs a number, a date column a date; anything else is a clear message.
 */
import type { ColumnId, ColumnSchema, Predicate, PredicateValue, TableSchema } from '@tw/model';

export type FilterOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'between' | 'in' | 'contains' | 'is_null' | 'not_null';

export interface FilterCondition {
  columnId: ColumnId;
  op: FilterOp | string;
  value?: string;
  value2?: string;
  /** Comma-separated list for 'in', such as 'NS-A01, NS-A02'. */
  values?: string;
}

export interface FilterFormState {
  combinator: 'all' | 'any';
  conditions: FilterCondition[];
  bbox?: {
    minLon: string;
    minLat: string;
    maxLon: string;
    maxLat: string;
    latColumn?: ColumnId;
    lonColumn?: ColumnId;
    geometryColumn?: ColumnId;
  };
}

export type FilterResult = { ok: true; predicate: Predicate } | { ok: false; message: string; field?: string };

export const OP_LABELS: Record<FilterOp, string> = {
  eq: 'equals',
  ne: 'does not equal',
  lt: 'is less than',
  le: 'is at most',
  gt: 'is greater than',
  ge: 'is at least',
  between: 'is between',
  in: 'is one of',
  contains: 'contains',
  is_null: 'is empty',
  not_null: 'is not empty',
};

/** The operators that make sense for a column of this type. */
export function opsFor(c: Pick<ColumnSchema, 'type'>): FilterOp[] {
  switch (c.type.value) {
    case 'number':
    case 'integer':
      return ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'in', 'is_null', 'not_null'];
    case 'date':
    case 'datetime':
      return ['between', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'is_null', 'not_null'];
    case 'boolean':
      return ['eq', 'ne', 'is_null', 'not_null'];
    case 'geometry':
      return ['is_null', 'not_null'];
    case 'string':
      return ['eq', 'ne', 'contains', 'in', 'is_null', 'not_null'];
  }
}

class FormError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i;

function validDate(text: string): boolean {
  const m = DATE.exec(text);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * A typed value for column `c`. A plain date given for a datetime column means the start of that
 * day in UTC, or its last millisecond when `endOfDay` is set (the upper end of a range).
 */
function typed(c: ColumnSchema, raw: string | undefined, field: string, endOfDay = false): PredicateValue {
  const text = (raw ?? '').trim();
  if (text === '') throw new FormError(`Enter a value for ${c.name}.`, field);
  switch (c.type.value) {
    case 'number':
    case 'integer': {
      const n = Number(text.replace(/,/g, ''));
      if (!Number.isFinite(n) || !/^[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) {
        throw new FormError(`"${text}" is not a number; ${c.name} holds numbers.`, field);
      }
      return n;
    }
    case 'date':
      if (!validDate(text)) throw new FormError(`"${text}" is not a date; write it as YYYY-MM-DD.`, field);
      return { date: text };
    case 'datetime': {
      if (validDate(text)) return { datetime: `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` };
      // A time without a zone is read as UTC, as the engine reads such data (rule TW-TIME-004).
      const ms = Date.parse(ZONED.test(text) ? text : `${text}Z`);
      if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
        throw new FormError(`"${text}" is not a date and time; write it as YYYY-MM-DD or YYYY-MM-DDTHH:MM.`, field);
      }
      return { datetime: new Date(ms).toISOString() };
    }
    case 'boolean':
      if (/^(true|yes|1)$/i.test(text)) return true;
      if (/^(false|no|0)$/i.test(text)) return false;
      throw new FormError(`"${text}" is not true or false.`, field);
    case 'geometry':
      throw new FormError(`${c.name} holds geometries; filter it with a bounding box.`, field);
    case 'string':
      return text;
  }
}

function column(schema: TableSchema, id: ColumnId | undefined, field: string): ColumnSchema {
  const c = schema.columns.find((x) => x.id === id);
  if (c === undefined) throw new FormError('Choose a column.', field);
  return c;
}

function condition(schema: TableSchema, x: FilterCondition, i: number): Predicate {
  const c = column(schema, x.columnId, `${i}.column`);
  const op = x.op as FilterOp;
  if (!opsFor(c).includes(op)) throw new FormError(`"${String(x.op)}" cannot be used with ${c.name}.`, `${i}.op`);
  switch (op) {
    case 'is_null':
    case 'not_null':
      return { column: c.id, op };
    case 'between': {
      const low = typed(c, x.value, `${i}.value`);
      const high = typed(c, x.value2, `${i}.value2`, true);
      return { column: c.id, op: 'between', low, high };
    }
    case 'in': {
      const parts = (x.values ?? x.value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (parts.length === 0)
        throw new FormError(`List at least one value for ${c.name}, separated by commas.`, `${i}.values`);
      const values = parts.map((p) => typed(c, p, `${i}.values`)) as (string | number)[];
      return { column: c.id, op: 'in', values };
    }
    case 'contains': {
      const text = x.value ?? '';
      if (text.trim() === '') throw new FormError(`Enter the text ${c.name} should contain.`, `${i}.value`);
      return { column: c.id, op: 'contains', text, caseSensitive: false };
    }
    default:
      return { column: c.id, op, value: typed(c, x.value, `${i}.value`) };
  }
}

function coordinate(text: string, name: string, limit: number): number {
  const n = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(n))
    throw new FormError(`${name} must be a number of degrees.`, `bbox.${name}`);
  if (Math.abs(n) > limit)
    throw new FormError(`${name} must be between -${limit} and ${limit} degrees.`, `bbox.${name}`);
  return n;
}

function bboxPredicate(schema: TableSchema, b: NonNullable<FilterFormState['bbox']>): Predicate {
  const box: [number, number, number, number] = [
    coordinate(b.minLon, 'minLon', 180),
    coordinate(b.minLat, 'minLat', 90),
    coordinate(b.maxLon, 'maxLon', 180),
    coordinate(b.maxLat, 'maxLat', 90),
  ];
  if (box[1] > box[3])
    throw new FormError('The south edge (minLat) must not be north of the north edge (maxLat).', 'bbox.minLat');
  const role = (r: string) => schema.columns.find((c) => c.role.value === r)?.id;
  const geometry = b.geometryColumn ?? (b.latColumn === undefined ? (schema.geometryColumn ?? undefined) : undefined);
  if (geometry !== undefined) return { bbox: box, geometry: column(schema, geometry, 'bbox.geometry').id };
  const lat = b.latColumn ?? role('latitude');
  const lon = b.lonColumn ?? role('longitude');
  if (lat === undefined || lon === undefined) {
    throw new FormError('This dataset has no geometry or latitude/longitude columns to test against the box.', 'bbox');
  }
  return { bbox: box, lat: column(schema, lat, 'bbox.lat').id, lon: column(schema, lon, 'bbox.lon').id };
}

/** The predicate the form describes, or the first problem with it. */
export function buildPredicate(form: FilterFormState, schema: TableSchema): FilterResult {
  try {
    const parts = form.conditions.map((x, i) => condition(schema, x, i));
    if (form.bbox !== undefined) parts.push(bboxPredicate(schema, form.bbox));
    if (parts.length === 0) return { ok: false, message: 'Add at least one condition.', field: 'conditions' };
    const predicate: Predicate =
      parts.length === 1 ? (parts[0] as Predicate) : form.combinator === 'any' ? { any: parts } : { all: parts };
    return { ok: true, predicate };
  } catch (e) {
    if (e instanceof FormError) return { ok: false, message: e.message, field: e.field };
    throw e;
  }
}

/** The predicate the form describes; throws an Error carrying the validation message otherwise. */
export function predicateFromForm(form: FilterFormState, schema: TableSchema): Predicate {
  const result = buildPredicate(form, schema);
  if (!result.ok) throw new Error(result.message);
  return result.predicate;
}
