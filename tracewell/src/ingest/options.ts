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
      return { decimalSeparator: '.', thousandsSeparator: '', geometryColumn: true };
  }
}

export type CellParseResult = { ok: true; value: CellValue; nullMarker?: string } | { ok: false; raw: string };
export type RowParser = (row: RawRow) => CellParseResult[];

function isGeometryPlan(plan: ColumnPlan): boolean {
  return plan.type.value === 'geometry' && plan.role.value === 'geometry';
}

/** One parser per planned column; geometry comes from RawRow.geometry, never from a field. */
export function rowParser(plans: readonly ColumnPlan[], options: FormatOptions): RowParser {
  const dopts = detectOptionsFor(options);
  const parsers = plans.map((plan) => {
    if (isGeometryPlan(plan) && options.format === 'geojson') {
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
