/**
 * Data-file writers and the content they are given. The writers themselves are injectable so the
 * fault-injection tests can prove that read-back catches a corrupted value, a missing row or sheet.
 */
import { writeCsv } from '@tw/formats-csv';
import { writeGeoJson, type GeoJsonFeatureOut } from '@tw/formats-geojson';
import { writeParquet, type ParquetColumnIn } from '@tw/formats-parquet';
import {
  writeXlsx,
  type XlsxColumnKind,
  type XlsxWriteBook,
  type XlsxWriteSheet,
  type XlsxWriteValue,
} from '@tw/formats-xlsx';
import { pointFromLatLon } from '@tw/geo';
import { isGeometryCell, type AuditEntry, type ColumnId, type ColumnSchema, type LogicalType } from '@tw/model';
import type { View } from '@tw/table';
import { headerFor } from './profiles';
import { exportable, neutralizeFormula, textOf } from './values';

export interface ExportWriters {
  csv(header: string[], rows: Iterable<string[]>): Uint8Array;
  xlsx(book: XlsxWriteBook): Uint8Array;
  geojson(features: Iterable<GeoJsonFeatureOut>): Uint8Array;
  parquet(columns: ParquetColumnIn[]): Uint8Array;
}

export const DEFAULT_WRITERS: ExportWriters = Object.freeze({
  csv: (header: string[], rows: Iterable<string[]>) => writeCsv(header, rows),
  xlsx: (book: XlsxWriteBook) => writeXlsx(book),
  geojson: (features: Iterable<GeoJsonFeatureOut>) => writeGeoJson(features),
  parquet: (columns: ParquetColumnIn[]) => writeParquet(columns),
});

/** The columns of a Parquet data file: header names, logical types and exported values. */
export function parquetColumns(view: View, cols: ColumnId[]): ParquetColumnIn[] {
  return cols.map((c) => {
    const schema = view.columnSchema(c);
    const values = [];
    for (const r of view.rows()) values.push(exportable(view.value(r, c)));
    return { name: headerFor(schema), type: schema.type.value, values };
  });
}

/** Rows as CSV text; with `neutralize`, text columns are protected against formula injection. */
export function* csvRows(view: View, cols: ColumnId[], neutralize = false): IterableIterator<string[]> {
  const text = cols.map((c) => neutralize && view.columnSchema(c).type.value === 'string');
  for (const r of view.rows()) {
    yield cols.map((c, j) => {
      const t = textOf(view.value(r, c));
      return text[j] === true ? neutralizeFormula(t) : t;
    });
  }
}

export function csvHeader(view: View, cols: ColumnId[]): string[] {
  return cols.map((c) => headerFor(view.columnSchema(c)));
}

export function kindOf(type: LogicalType): XlsxColumnKind {
  return type === 'geometry' ? 'string' : type;
}

function cellOf(v: ReturnType<View['value']>, type: LogicalType): XlsxWriteValue {
  if (v === null) return null;
  if (type === 'geometry') return textOf(v);
  if (typeof v === 'object' && isGeometryCell(v)) return textOf(v);
  return v as XlsxWriteValue;
}

export function dataSheet(view: View, cols: ColumnId[]): XlsxWriteSheet {
  const schemas = cols.map((c) => view.columnSchema(c));
  return {
    name: 'Data',
    columns: schemas.map((s) => ({ header: headerFor(s), kind: kindOf(s.type.value) })),
    rows: (function* () {
      for (const r of view.rows()) yield schemas.map((s) => cellOf(view.value(r, s.id), s.type.value));
    })(),
    freezeHeader: true,
    autoFilter: true,
  };
}

export function keyValueSheet(name: string, rows: [string, string][]): XlsxWriteSheet {
  return {
    name,
    columns: [
      { header: 'Item', kind: 'string', width: 28 },
      { header: 'Value', kind: 'string', width: 100 },
    ],
    rows,
    freezeHeader: true,
    autoFilter: false,
  };
}

const LOG_COLUMNS: { header: string; kind: XlsxColumnKind }[] = [
  { header: 'Seq', kind: 'integer' },
  { header: 'Time (UTC)', kind: 'datetime' },
  { header: 'Actor', kind: 'string' },
  { header: 'Action', kind: 'string' },
  { header: 'Target', kind: 'string' },
  { header: 'Old', kind: 'string' },
  { header: 'New', kind: 'string' },
  { header: 'Reason', kind: 'string' },
  { header: 'Method', kind: 'string' },
  { header: 'Hash', kind: 'string' },
];

function json(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

export function logSheet(audit: readonly AuditEntry[]): XlsxWriteSheet {
  return {
    name: 'Log',
    columns: LOG_COLUMNS,
    rows: audit.map((e): XlsxWriteValue[] => [
      e.seq,
      { datetime: e.at },
      e.actor.kind === 'user' ? `${e.actor.name} (${e.actor.role})` : `system: ${e.actor.component}`,
      e.action,
      json(e.target),
      json(e.old),
      json(e.new),
      e.reason ?? null,
      e.method === undefined ? null : e.method.formula,
      e.hash,
    ]),
    freezeHeader: true,
    autoFilter: true,
  };
}

/** GeoJSON features: geometry from the geometry column, or a point from latitude and longitude. */
export function* features(view: View, source: 'column' | 'latlon'): IterableIterator<GeoJsonFeatureOut> {
  const cols = view.schema.columns;
  const geometryId = view.schema.geometryColumn;
  const lat = cols.find((c) => c.role.value === 'latitude');
  const lon = cols.find((c) => c.role.value === 'longitude');
  const props: ColumnSchema[] = cols.filter((c) => !(source === 'column' && c.id === geometryId));
  for (const r of view.rows()) {
    let geometry = null;
    if (source === 'column' && geometryId !== null) {
      const v = view.value(r, geometryId);
      geometry = isGeometryCell(v) ? v.geometry : null;
    } else if (lat !== undefined && lon !== undefined) {
      const y = view.value(r, lat.id);
      const x = view.value(r, lon.id);
      geometry = typeof x === 'number' && typeof y === 'number' ? pointFromLatLon(y, x) : null;
    }
    const properties: GeoJsonFeatureOut['properties'] = {};
    for (const c of props) {
      const v = view.value(r, c.id);
      properties[headerFor(c)] =
        v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : textOf(v);
    }
    yield { geometry, properties };
  }
}
