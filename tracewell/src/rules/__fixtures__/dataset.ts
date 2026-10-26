/** Small inline datasets for the check tests, built through TableBuilder like a real import. */
import {
  detection,
  type CellValue,
  type ColumnRole,
  type ColumnSchema,
  type CrsRef,
  type DateFormat,
  type LogicalType,
  type QuantityKind,
  type TimezoneMode,
} from '@tw/model';
import { Overlay, RowSet, TableBuilder, View, type CellParse } from '@tw/table';
import type { RuleContext } from '../context';

export interface Col {
  name: string;
  type: LogicalType;
  role: ColumnRole;
  unit?: string | null;
  quantity?: QuantityKind | null;
  timezone?: { value: TimezoneMode; assumed: boolean };
  dateFormat?: { value: DateFormat; assumed: boolean };
}

/** A cell: a value, or { raw } for a failed parse, or { marker } for a null marker. */
export type Cell = CellValue | { raw: string } | { marker: string };

function toParse(c: Cell): CellParse {
  if (c !== null && typeof c === 'object' && 'raw' in c) return { ok: false, raw: c.raw };
  if (c !== null && typeof c === 'object' && 'marker' in c) return { ok: true, value: null, nullMarker: c.marker };
  return { ok: true, value: c };
}

function schemaOf(col: Col, i: number): ColumnSchema {
  const d = <T>(v: T, assumed = false) => detection(v, assumed ? 'medium' : 'high', 'test', 'test fixture');
  return {
    id: `c${i}`,
    name: col.name,
    sourceHeader: [col.name],
    sourceIndex: i,
    type: d(col.type),
    role: d(col.role),
    unit: d(col.unit ?? null),
    quantity: col.quantity ?? null,
    nullMarkers: d<string[]>([]),
    ...(col.timezone === undefined ? {} : { timezone: d(col.timezone.value, col.timezone.assumed) }),
    ...(col.dateFormat === undefined ? {} : { dateFormat: d(col.dateFormat.value, col.dateFormat.assumed) }),
  };
}

export function viewOf(cols: Col[], rows: Cell[][], crs: CrsRef | null = null): View {
  const schemas = cols.map(schemaOf);
  const builder = new TableBuilder(schemas.map((s) => ({ id: s.id, type: s.type.value })));
  rows.forEach((r, i) => builder.pushRow(i + 2, r.map(toParse)));
  const geometry = schemas.find((s) => s.type.value === 'geometry')?.id ?? null;
  const ds = builder.finish({
    datasetId: 'd1',
    name: 'test',
    source: { fileId: 'a'.repeat(64), fileName: 'test.csv', format: 'csv' },
    columns: schemas,
    crs: crs === null ? null : detection(crs, 'high', 'test', 'test fixture'),
    geometryColumn: geometry,
    partial: false,
  });
  return new View(ds, {
    overlay: new Overlay(),
    excluded: new RowSet(ds.rowCount),
    derived: [],
    hidden: [],
    rowFilter: null,
    columnOrder: null,
  });
}

export function ctxOf(view: View, over: Partial<RuleContext> = {}): RuleContext {
  return {
    view,
    importNotes: [],
    assumptions: [],
    projectArea: null,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...over,
  };
}

export const day = (d: number): CellValue => ({ date: `2026-01-${String(d).padStart(2, '0')}` });
