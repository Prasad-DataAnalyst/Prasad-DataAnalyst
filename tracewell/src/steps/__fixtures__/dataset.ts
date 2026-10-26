/** A small dataset for the step tests: id, date, datetime, pressure in psia, text, lat/lon, geometry. */
import {
  detection,
  type CellValue,
  type ColumnSchema,
  type LogicalType,
  type ColumnRole,
  type QuantityKind,
} from '@tw/model';
import { Overlay, RowSet, TableBuilder, type CellParse, type Dataset } from '@tw/table';
import type { StepState } from '../views';

interface Col {
  name: string;
  type: LogicalType;
  role: ColumnRole;
  unit?: string;
  quantity?: QuantityKind;
}

const COLS: Col[] = [
  { name: 'well_id', type: 'string', role: 'id' },
  { name: 'date', type: 'date', role: 'time' },
  { name: 'time', type: 'datetime', role: 'time' },
  { name: 'Pressure', type: 'number', role: 'measure', unit: 'psia', quantity: 'pressure_abs' },
  { name: 'Note', type: 'string', role: 'text' },
  { name: 'lat', type: 'number', role: 'latitude' },
  { name: 'lon', type: 'number', role: 'longitude' },
  { name: 'geometry', type: 'geometry', role: 'geometry' },
];

const d = (date: string): CellValue => ({ date });
const t = (datetime: string): CellValue => ({ datetime });
const pt = (lon: number, lat: number): CellValue => ({ geometry: { type: 'Point', coordinates: [lon, lat] } });

/** Row 4 has a pressure that failed to parse ('n/a?'), kept as raw text. */
export const ROWS: (CellValue | { raw: string })[][] = [
  ['W-01', d('2026-01-01'), t('2026-01-01T06:00:00.000Z'), 1200, 'Normal flow', 57.1, 1.7, pt(1.7, 57.1)],
  ['W-02', d('2026-01-02'), t('2026-01-02T06:00:00.000Z'), 14.7, 'choke CHANGED', 57.3, 1.9, pt(1.9, 57.3)],
  ['W-01', d('2026-01-03'), t('2026-01-03T06:00:00.000Z'), null, null, 58.0, 2.5, null],
  ['W-03', d('2026-01-04'), t('2026-01-04T18:30:00.000Z'), 980.5, 'shut-in', 56.2, 0.4, pt(0.4, 56.2)],
  ['W-02', d('2026-01-05'), t('2026-01-05T06:00:00.000Z'), { raw: 'n/a?' }, 'normal', null, null, pt(3, 59)],
];

function schemaOf(c: Col, i: number): ColumnSchema {
  const det = <T>(v: T) => detection(v, 'high', 'test', 'test fixture');
  return {
    id: `c${i}`,
    name: c.name,
    sourceHeader: [c.name],
    sourceIndex: i,
    type: det(c.type),
    role: det(c.role),
    unit: det<string | null>(c.unit ?? null),
    quantity: c.quantity ?? null,
    nullMarkers: det<string[]>([]),
  };
}

export function dataset(): Dataset {
  const schemas = COLS.map(schemaOf);
  const b = new TableBuilder(schemas.map((s) => ({ id: s.id, type: s.type.value })));
  ROWS.forEach((row, i) =>
    b.pushRow(
      i + 2,
      row.map((v): CellParse =>
        v !== null && typeof v === 'object' && 'raw' in v ? { ok: false, raw: v.raw } : { ok: true, value: v },
      ),
    ),
  );
  return b.finish({
    datasetId: 'd1',
    name: 'steps',
    source: { fileId: 'a'.repeat(64), fileName: 'steps.csv', format: 'csv' },
    columns: schemas,
    crs: detection({ code: 'EPSG:4326', source: 'assumed-latlon' }, 'medium', 'test', 'test fixture'),
    geometryColumn: 'c7',
    partial: false,
  });
}

export function state(over: Partial<StepState> = {}): StepState {
  return { overlay: new Overlay(), excluded: new RowSet(ROWS.length), steps: [], ...over };
}
