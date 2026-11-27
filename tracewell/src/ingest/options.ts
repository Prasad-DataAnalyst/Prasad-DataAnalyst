/** Detection options and parsers derived from the reader's format options. */
import type { DetectOptions } from '@tw/detect';
import { makeParser } from '@tw/detect';
import type { CellValue, ColumnPlan, FormatOptions, RawRow } from '@tw/model';

export function detectOptionsFor(options: FormatOptions): DetectOptions {
  switch (options.format) {
    case 'csv':
    case 'tsv':
      return { decimalSeparator: options.csv.decimalSeparator, thousandsSeparator: options.csv.thousandsSeparator };
    case 'xlsx':
      return { decimalSeparator: '.', thousandsSeparator: '' };
    case 'geojson':
    case 'flatgeobuf':
    case 'kml':
    case 'shapefile':
      return { decimalSeparator: '.', thousandsSeparator: '', geometryColumn: true };
    case 'geopackage':
      return {
        decimalSeparator: '.',
        thousandsSeparator: '',
        ...(options.geopackage.geometry === null ? {} : { geometryColumn: true }),
      };
    case 'json':
    case 'parquet':
      return { decimalSeparator: '.', thousandsSeparator: '' };
  }
}

/** Formats whose rows carry their geometry beside their fields. */
const GEOMETRY_FORMATS: ReadonlySet<FormatOptions['format']> = new Set([
  'geojson',
  'flatgeobuf',
  'kml',
  'shapefile',
  'geopackage',
]);

export type CellParseResult = { ok: true; value: CellValue; nullMarker?: string } | { ok: false; raw: string };
export type RowParser = (row: RawRow) => CellParseResult[];

function isGeometryPlan(plan: ColumnPlan): boolean {
  return plan.type.value === 'geometry' && plan.role.value === 'geometry';
}

/** One parser per planned column; geometry comes from RawRow.geometry, never from a field. */
export function rowParser(plans: readonly ColumnPlan[], options: FormatOptions): RowParser {
  const dopts = detectOptionsFor(options);
  const parsers = plans.map((plan) => {
    if (isGeometryPlan(plan) && GEOMETRY_FORMATS.has(options.format)) {
      return (row: RawRow): CellParseResult =>
        row.geometry === undefined || row.geometry === null
          ? { ok: true, value: null }
          : { ok: true, value: { geometry: row.geometry } };
    }
    const parse = makeParser(plan, dopts);
    return (row: RawRow): CellParseResult => parse(row.fields[plan.sourceIndex] ?? null);
  });
  return (row) => parsers.map((p) => p(row));
}

export function geometryColumnOf(plans: readonly ColumnPlan[]): string | null {
  return plans.find(isGeometryPlan)?.id ?? null;
}

/** Parses text a user typed into a cell with the column's own parser, as an import would. */
export function cellParser(plan: ColumnPlan, options: FormatOptions): (text: string) => CellParseResult {
  const parse = makeParser(plan, detectOptionsFor(options));
  return (text) => parse(text);
}
