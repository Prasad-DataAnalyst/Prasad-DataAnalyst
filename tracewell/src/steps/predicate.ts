/**
 * Filter predicates (SAD section 7): SQL-like null semantics (every comparison with null is false;
 * only is_null matches a null), typed comparison of dates and date-times, inclusive between, and
 * case-insensitive contains unless asked otherwise. Compiled once against the schema, so a bad
 * column or a value of the wrong type is reported before any row is read.
 */
import { bboxContains, bboxIntersectsGeometry } from '@tw/geo';
import {
  EngineError,
  isDateCell,
  isDateTimeCell,
  isGeometryCell,
  type CellValue,
  type ColumnId,
  type ColumnSchema,
  type LogicalType,
  type Predicate,
  type PredicateValue,
  type TableSchema,
} from '@tw/model';

export type CompiledPredicate = (get: (c: ColumnId) => CellValue) => boolean;

function invalid(message: string, fix: string, detail?: Record<string, string>): EngineError {
  return new EngineError('INVALID_INPUT', message, fix, detail);
}

function columnOf(schema: TableSchema, id: ColumnId): ColumnSchema {
  const c = schema.columns.find((x) => x.id === id);
  if (c === undefined) {
    throw invalid(
      `The filter refers to column ${id}, which is not in the data at this step.`,
      'Choose a listed column.',
      {
        column: id,
      },
    );
  }
  return c;
}

/** A comparable key for a cell or predicate value of the column's type, or null when it has none. */
function comparable(type: LogicalType, v: CellValue | PredicateValue): number | string | boolean | null {
  if (v === null) return null;
  switch (type) {
    case 'integer':
    case 'number':
      return typeof v === 'number' ? v : null;
    case 'string':
      return typeof v === 'string' ? v : null;
    case 'boolean':
      return typeof v === 'boolean' ? v : null;
    case 'date':
      return isDateCell(v) ? v.date : null;
    case 'datetime':
      return isDateTimeCell(v) ? v.datetime : null;
    case 'geometry':
      return null;
  }
}

function checkValue(c: ColumnSchema, v: PredicateValue): void {
  if (comparable(c.type.value, v) === null) {
    throw invalid(
      `The value ${JSON.stringify(v)} cannot be compared with ${c.name}, which holds ${c.type.value} values.`,
      `Enter a ${c.type.value} value.`,
      { column: c.id },
    );
  }
}

function compare(a: number | string | boolean, b: number | string | boolean): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compilePredicate(p: Predicate, schema: TableSchema): CompiledPredicate {
  if ('all' in p) {
    const parts = p.all.map((x) => compilePredicate(x, schema));
    return (get) => parts.every((f) => f(get));
  }
  if ('any' in p) {
    const parts = p.any.map((x) => compilePredicate(x, schema));
    return (get) => parts.some((f) => f(get));
  }
  if ('not' in p) {
    const inner = compilePredicate(p.not, schema);
    return (get) => !inner(get);
  }
  if ('bbox' in p) return compileBbox(p, schema);

  const c = columnOf(schema, p.column);
  const type = c.type.value;
  switch (p.op) {
    case 'is_null':
      return (get) => get(c.id) === null;
    case 'not_null':
      return (get) => get(c.id) !== null;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge': {
      checkValue(c, p.value);
      if (type === 'boolean' && p.op !== 'eq' && p.op !== 'ne') {
        throw invalid(
          `${c.name} holds true/false values, which can only be tested for equal or not equal.`,
          'Use = or ≠.',
        );
      }
      const target = comparable(type, p.value) as number | string | boolean;
      const test = {
        eq: (n: number) => n === 0,
        ne: (n: number) => n !== 0,
        lt: (n: number) => n < 0,
        le: (n: number) => n <= 0,
        gt: (n: number) => n > 0,
        ge: (n: number) => n >= 0,
      }[p.op];
      return (get) => {
        const v = comparable(type, get(c.id));
        return v !== null && test(compare(v, target));
      };
    }
    case 'between': {
      checkValue(c, p.low);
      checkValue(c, p.high);
      const low = comparable(type, p.low) as number | string;
      const high = comparable(type, p.high) as number | string;
      return (get) => {
        const v = comparable(type, get(c.id));
        return v !== null && compare(v, low) >= 0 && compare(v, high) <= 0;
      };
    }
    case 'in': {
      const values = p.values;
      for (const v of values) checkValue(c, v);
      const set = new Set<number | string>(values);
      return (get) => {
        const v = get(c.id);
        return (typeof v === 'number' || typeof v === 'string') && set.has(v);
      };
    }
    case 'contains': {
      if (type !== 'string') {
        throw invalid(
          `"Contains" works on text columns; ${c.name} holds ${type} values.`,
          'Use a comparison instead.',
          {
            column: c.id,
          },
        );
      }
      const sensitive = p.caseSensitive === true;
      const needle = sensitive ? p.text : p.text.toLowerCase();
      return (get) => {
        const v = get(c.id);
        return typeof v === 'string' && (sensitive ? v : v.toLowerCase()).includes(needle);
      };
    }
  }
}

function compileBbox(p: Extract<Predicate, { bbox: unknown }>, schema: TableSchema): CompiledPredicate {
  const box = p.bbox;
  if ('geometry' in p) {
    const g = columnOf(schema, p.geometry);
    if (g.type.value !== 'geometry') {
      throw invalid(`${g.name} does not hold geometries.`, 'Choose the geometry column.', { column: g.id });
    }
    return (get) => {
      const v = get(g.id);
      return isGeometryCell(v) && bboxIntersectsGeometry(box, v.geometry);
    };
  }
  const lat = columnOf(schema, p.lat);
  const lon = columnOf(schema, p.lon);
  for (const c of [lat, lon]) {
    if (c.type.value !== 'number' && c.type.value !== 'integer') {
      throw invalid(
        `${c.name} does not hold numbers, so it cannot be used as a coordinate.`,
        'Choose the latitude and longitude columns.',
        {
          column: c.id,
        },
      );
    }
  }
  return (get) => {
    const y = get(lat.id);
    const x = get(lon.id);
    return typeof x === 'number' && typeof y === 'number' && bboxContains(box, x, y);
  };
}

/** Plain-language form of a predicate, for step descriptions. */
export function describePredicate(p: Predicate, schema: TableSchema): string {
  const name = (id: ColumnId) => schema.columns.find((c) => c.id === id)?.name ?? id;
  const value = (v: PredicateValue) =>
    typeof v === 'object' ? ('date' in v ? v.date : v.datetime) : typeof v === 'string' ? `"${v}"` : String(v);
  if ('all' in p) return p.all.map((x) => describePredicate(x, schema)).join(' and ');
  if ('any' in p) return `(${p.any.map((x) => describePredicate(x, schema)).join(' or ')})`;
  if ('not' in p) return `not (${describePredicate(p.not, schema)})`;
  if ('bbox' in p) return `location is within [${p.bbox.join(', ')}]`;
  const ops = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥' } as const;
  switch (p.op) {
    case 'is_null':
      return `${name(p.column)} is empty`;
    case 'not_null':
      return `${name(p.column)} is not empty`;
    case 'between':
      return `${name(p.column)} is between ${value(p.low)} and ${value(p.high)}`;
    case 'in':
      return `${name(p.column)} is one of ${p.values.map((v) => value(v)).join(', ')}`;
    case 'contains':
      return `${name(p.column)} contains "${p.text}"${p.caseSensitive === true ? ' (case-sensitive)' : ''}`;
    default:
      return `${name(p.column)} ${ops[p.op]} ${value(p.value)}`;
  }
}
