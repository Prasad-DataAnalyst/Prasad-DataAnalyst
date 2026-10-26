/**
 * How each logical type is written to text formats and read back. Writing and reading are separate
 * functions on purpose: read-back must not share the writer's code path.
 */
import { canonicalNumber, type CellValue, type Geometry, type LogicalType } from '@tw/model';

/** The value written to a CSV field (and to text cells): lossless and locale-independent. */
export function textOf(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return canonicalNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if ('date' in v) return v.date;
  if ('datetime' in v) return v.datetime;
  return JSON.stringify(v.geometry);
}

/** Exported text cannot tell an empty string from no value, so both count as no value. */
export function exportable(v: CellValue): CellValue {
  return v === '' ? null : v;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/;

/** Re-types text read back from a file, using the manifest's column type. Undefined when it does not fit. */
export function retypeText(text: string, type: LogicalType): CellValue | undefined {
  if (text === '') return null;
  switch (type) {
    case 'string':
      return text;
    case 'integer':
    case 'number':
      return NUMBER.test(text) ? Number(text) : undefined;
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : undefined;
    case 'date':
      return DATE.test(text) ? { date: text } : undefined;
    case 'datetime':
      return DATETIME.test(text) ? { datetime: text } : undefined;
    case 'geometry':
      try {
        const g = JSON.parse(text) as unknown;
        return typeof g === 'object' && g !== null && 'type' in g ? { geometry: g as Geometry } : undefined;
      } catch {
        return undefined;
      }
  }
}
