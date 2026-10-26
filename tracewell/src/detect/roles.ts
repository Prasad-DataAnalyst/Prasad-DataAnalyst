/**
 * Column roles from the name, the type and the values, and the CRS a latitude/longitude pair
 * implies for formats that cannot declare one (SAD section 7.6).
 */
import {
  detection,
  type CellValue,
  type ColumnPlan,
  type ColumnRole,
  type CrsRef,
  type Detection,
  type LogicalType,
} from '@tw/model';
import { nameTokens } from './names';

/** Full words name the axis outright; abbreviations need the values to agree. */
const AXES = {
  latitude: { words: ['latitude'], abbreviations: ['lat'], limit: 90 },
  longitude: { words: ['longitude'], abbreviations: ['lon', 'long', 'lng'], limit: 180 },
} as const;

const EASTING_WORDS: ReadonlySet<string> = new Set(['easting', 'eastings']);
const NORTHING_WORDS: ReadonlySet<string> = new Set(['northing', 'northings']);
const UNIT_WORDS: ReadonlySet<string> = new Set(['unit', 'units', 'uom']);
const ID_WORDS: ReadonlySet<string> = new Set(['id', 'uwi', 'api', 'guid', 'uuid', 'key', 'ids']);
/** Words that often, but not always, name an identifier; they need distinct values to count. */
const ID_LIKE_WORDS: ReadonlySet<string> = new Set([
  'code',
  'no',
  'num',
  'number',
  'tag',
  'serial',
  'ref',
  'reference',
]);

/** An identifier column has mostly distinct values; below this many the share means little. */
const CARDINALITY_MIN_VALUES = 5;
const CARDINALITY_SHARE = 0.9;

function numbers(values: CellValue[]): number[] {
  return values.filter((v): v is number => typeof v === 'number');
}

function withinLimit(values: CellValue[], limit: number): boolean {
  const nums = numbers(values);
  return nums.length > 0 && nums.every((v) => Math.abs(v) <= limit);
}

function isNumeric(type: LogicalType): boolean {
  return type === 'integer' || type === 'number';
}

function axisRole(axis: keyof typeof AXES, tokens: string[], values: CellValue[]): Detection<ColumnRole> | null {
  const spec = AXES[axis];
  const has = (words: readonly string[]): boolean => tokens.some((t) => words.includes(t));
  if (has(spec.words)) return detection<ColumnRole>(axis, 'high', 'name', `The name says ${axis}.`);
  if (!has(spec.abbreviations)) return null;
  if (withinLimit(values, spec.limit))
    return detection<ColumnRole>(
      axis,
      'high',
      'name-and-range',
      `The name abbreviates ${axis} and every value is within ±${spec.limit}.`,
    );
  return detection<ColumnRole>(
    axis,
    'medium',
    'name',
    `The name abbreviates ${axis}, but some values fall outside ±${spec.limit}.`,
  );
}

function distinctShare(values: CellValue[]): { count: number; share: number } {
  const present = values.filter((v) => v !== null).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
  return { count: present.length, share: present.length === 0 ? 0 : new Set(present).size / present.length };
}

function idRole(tokens: string[], type: LogicalType, values: CellValue[]): Detection<ColumnRole> | null {
  if (type !== 'string' && type !== 'integer') return null;
  if (tokens.some((t) => ID_WORDS.has(t)))
    return detection<ColumnRole>('id', 'high', 'name', 'The name marks an identifier.');
  if (!tokens.some((t) => ID_LIKE_WORDS.has(t))) return null;
  const { count, share } = distinctShare(values);
  if (count < CARDINALITY_MIN_VALUES || share < CARDINALITY_SHARE) return null;
  return detection<ColumnRole>(
    'id',
    'medium',
    'name-and-cardinality',
    `The name suggests an identifier and ${Math.round(share * 100)} % of values are distinct.`,
  );
}

function spatialRole(tokens: string[], values: CellValue[]): Detection<ColumnRole> | null {
  const axis = axisRole('latitude', tokens, values) ?? axisRole('longitude', tokens, values);
  if (axis !== null) return axis;
  if (tokens.some((t) => EASTING_WORDS.has(t)))
    return detection<ColumnRole>('easting', 'high', 'name', 'The name says easting.');
  if (tokens.some((t) => NORTHING_WORDS.has(t)))
    return detection<ColumnRole>('northing', 'high', 'name', 'The name says northing.');
  return null;
}

function fallbackRole(type: LogicalType, unit: string | null): Detection<ColumnRole> {
  if (isNumeric(type)) {
    const evidence = unit === null ? 'Numeric values are measurements.' : `Numeric values in ${unit} are measurements.`;
    return detection<ColumnRole>('measure', 'high', 'type', evidence);
  }
  return detection<ColumnRole>('text', 'high', 'type', 'Non-numeric values are descriptive.');
}

/**
 * The role of a column. Order matters: geometry and time follow from the type; latitude,
 * longitude, easting and northing from the name (checked against the values); identifiers from
 * the name, or an id-like name with mostly distinct values; other numbers are measures and the
 * rest text.
 */
export function detectRole(
  name: string,
  type: LogicalType,
  values: CellValue[],
  unit: string | null,
): Detection<ColumnRole> {
  if (type === 'geometry') return detection<ColumnRole>('geometry', 'high', 'type', 'The column holds geometries.');
  if (type === 'date' || type === 'datetime')
    return detection<ColumnRole>('time', 'high', 'type', 'The column holds dates or times.');
  const tokens = nameTokens(name);
  const spatial = isNumeric(type) ? spatialRole(tokens, values) : null;
  if (spatial !== null) return spatial;
  if (type === 'string' && tokens.some((t) => UNIT_WORDS.has(t)))
    return detection<ColumnRole>('unit', 'high', 'name', 'The name says the column holds units.');
  return idRole(tokens, type, values) ?? fallbackRole(type, unit);
}

/**
 * EPSG:4326 for a table with a latitude and a longitude column, assumed: CSV and spreadsheets
 * cannot declare a CRS, and WGS84 is what such columns almost always hold. Null otherwise.
 */
export function detectLatLonCrs(columns: ColumnPlan[]): Detection<CrsRef> | null {
  const has = (role: ColumnRole): boolean => columns.some((c) => c.role.value === role && isNumeric(c.type.value));
  if (!has('latitude') || !has('longitude')) return null;
  return detection<CrsRef>(
    { code: 'EPSG:4326', source: 'assumed-latlon' },
    'medium',
    'latlon-columns',
    'Latitude and longitude columns are assumed to be WGS84 (EPSG:4326); the file does not say.',
  );
}
