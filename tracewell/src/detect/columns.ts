/**
 * Column plans: everything detection decides about each column of a table, from its header
 * cells and up to 10,000 sample rows.
 */
import {
  detection,
  type CellValue,
  type ColumnPlan,
  type Detection,
  type LogicalType,
  type QuantityKind,
  type RawField,
  type RawRow,
} from '@tw/model';
import { getUnit, parseHeaderUnit } from '@tw/units';
import { EXCEL_MAX_SERIAL } from './dates';
import { detectNullMarkers, matchNullMarker } from './markers';
import {
  flattenHeader,
  hasBooleanHint,
  hasDateHint,
  headerWidth,
  nameTokens,
  placeholderName,
  uniqueNames,
} from './names';
import { parseNumber } from './numbers';
import { SAMPLE_LIMIT, type DetectOptions } from './options';
import { makeParser } from './parser';
import { detectRole } from './roles';
import { inferType, type TypeInference } from './types';

/**
 * Smallest serial read as an Excel date from a date-named column: 1910-01-01. Smaller numbers
 * under such a header are far more often day counts or offsets than dates before 1910.
 */
const EXCEL_MIN_SERIAL = 3654;

interface NamedColumn {
  name: string;
  sourceHeader: string[];
  unit: Detection<string | null>;
}

function headerColumn(header: string[][], flat: string, index: number): NamedColumn {
  const parsed = parseHeaderUnit(flat);
  const unit: Detection<string | null> =
    parsed.unit ?? detection<string | null>(null, 'high', 'header', 'The header names no unit.');
  return {
    name: parsed.name === '' ? placeholderName(index) : parsed.name,
    sourceHeader: header.map((row) => row[index] ?? ''),
    unit,
  };
}

function numericValues(values: RawField[], o: DetectOptions): number[] | null {
  const nums: number[] = [];
  for (const v of values) {
    if (v === null || (typeof v === 'string' && v.trim() === '')) continue;
    const n =
      typeof v === 'number'
        ? v
        : typeof v === 'string'
          ? parseNumber(v, o.decimalSeparator, o.thousandsSeparator)
          : null;
    if (n === null) return null;
    nums.push(n);
  }
  return nums.length > 0 ? nums : null;
}

/** Numbers under a date-like header (Excel serials stored without a date format) become dates, assumed. */
function asSerialDates(nums: number[]): TypeInference | null {
  if (!nums.every((n) => n >= EXCEL_MIN_SERIAL && n <= EXCEL_MAX_SERIAL)) return null;
  const withTime = nums.some((n) => !Number.isInteger(n));
  const result: TypeInference = {
    type: detection<LogicalType>(
      withTime ? 'datetime' : 'date',
      'medium',
      'excel-serial',
      'Numbers in a date-named column are read as Excel serial dates.',
    ),
    dateFormat: detection(
      'excel-serial',
      'high',
      'value-pattern',
      'Values are Excel serial day numbers (1900 date system).',
    ),
  };
  if (withTime)
    result.timezone = detection(
      'naive-assumed-utc',
      'low',
      'no-zone',
      'Excel serial times name no time zone; they are read as UTC.',
      'default',
    );
  return result;
}

/** Header hints that values alone cannot give: serial dates and 1/0 booleans. */
function refineByName(
  inferred: TypeInference,
  tokens: string[],
  hasUnit: boolean,
  values: RawField[],
  o: DetectOptions,
): TypeInference {
  const type = inferred.type.value;
  if (type !== 'integer' && type !== 'number') return inferred;
  const nums = numericValues(values, o);
  if (nums === null) return inferred;
  if (!hasUnit && hasDateHint(tokens)) return asSerialDates(nums) ?? inferred;
  if (type === 'integer' && hasBooleanHint(tokens) && nums.every((n) => n === 0 || n === 1))
    return {
      type: detection<LogicalType>('boolean', 'medium', 'name-and-values', 'Only 1 and 0 under a yes/no style header.'),
    };
  return inferred;
}

function quantityOf(unit: string | null): QuantityKind | null {
  return unit === null ? null : (getUnit(unit)?.quantity ?? null);
}

function parsedValues(plan: ColumnPlan, values: RawField[], o: DetectOptions): CellValue[] {
  const parse = makeParser(plan, o);
  return values.flatMap((raw) => {
    const r = parse(raw);
    return r.ok ? [r.value] : [];
  });
}

function planColumn(named: NamedColumn, index: number, values: RawField[], o: DetectOptions): ColumnPlan {
  const nullMarkers = detectNullMarkers(values);
  const typed = values.filter((v) => matchNullMarker(v, nullMarkers.value, o.decimalSeparator) === undefined);
  const inferred = refineByName(inferType(typed, o), nameTokens(named.name), named.unit.value !== null, typed, o);
  const plan: ColumnPlan = {
    id: `c${index}`,
    name: named.name,
    sourceHeader: named.sourceHeader,
    sourceIndex: index,
    type: inferred.type,
    // Replaced below, once the values can be parsed under the detected type.
    role: detection('text', 'high', 'type', ''),
    unit: named.unit,
    quantity: quantityOf(named.unit.value),
    nullMarkers,
  };
  if (inferred.dateFormat !== undefined) plan.dateFormat = inferred.dateFormat;
  if (inferred.timezone !== undefined) plan.timezone = inferred.timezone;
  if (inferred.type.value === 'integer' || inferred.type.value === 'number')
    plan.decimalSeparator = detection(
      o.decimalSeparator,
      'high',
      'file-dialect',
      'The decimal separator detected for the file.',
    );
  plan.role = detectRole(plan.name, plan.type.value, parsedValues(plan, values, o), plan.unit.value);
  return plan;
}

function geometryPlan(index: number, name: string): ColumnPlan {
  return {
    id: `c${index}`,
    name,
    sourceHeader: ['geometry'],
    sourceIndex: index,
    type: detection('geometry', 'high', 'source-format', 'Feature geometries from the GeoJSON file.'),
    role: detection('geometry', 'high', 'type', 'The column holds geometries.'),
    unit: detection<string | null>(null, 'high', 'type', 'Geometries have no unit.'),
    quantity: null,
    nullMarkers: detection<string[]>([], 'high', 'type', 'Missing geometries are null.'),
  };
}

function columnWidth(header: string[][], sample: RawRow[]): number {
  const width = headerWidth(header);
  // Without header rows, the widest sample row decides how many columns there are.
  return width > 0 ? width : sample.reduce((w, row) => Math.max(w, row.fields.length), 0);
}

/**
 * Plans every column of a table: name and unit from the header, type, null markers, date format,
 * timezone and role from the sample. Column ids are c0..cN by source position; with
 * `geometryColumn` a final geometry column follows the fields.
 */
export function detectColumns(header: string[][], sample: RawRow[], o: DetectOptions): ColumnPlan[] {
  const rows = sample.slice(0, SAMPLE_LIMIT);
  const width = columnWidth(header, rows);
  const flat = flattenHeader(header);
  const named = Array.from({ length: width }, (_, i) => headerColumn(header, flat[i] ?? placeholderName(i), i));
  const names = uniqueNames([...named.map((c) => c.name), ...(o.geometryColumn === true ? ['geometry'] : [])]);
  const plans = named.map((column, i) =>
    planColumn(
      { ...column, name: names[i] ?? column.name },
      i,
      rows.map((r) => r.fields[i] ?? null),
      o,
    ),
  );
  if (o.geometryColumn === true) plans.push(geometryPlan(width, names[width] ?? 'geometry'));
  return plans;
}
