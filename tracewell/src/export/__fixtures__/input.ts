/** An inline dataset and export input for the export tests. */
import { sha256Hex } from '@tw/io';
import {
  canonicalJson,
  detection,
  type AuditEntry,
  type CellValue,
  type ColumnRole,
  type ColumnSchema,
  type CrsRef,
  type Issue,
  type JsonValue,
  type LogicalType,
  type QuantityKind,
} from '@tw/model';
import { Overlay, RowSet, TableBuilder, View, type CellParse, type Dataset } from '@tw/table';
import type { ExportInput } from '../build';

interface Col {
  name: string;
  type: LogicalType;
  role: ColumnRole;
  unit?: string;
  quantity?: QuantityKind;
}

export const COLS: Col[] = [
  { name: 'well_id', type: 'string', role: 'id' },
  { name: 'date', type: 'date', role: 'time' },
  { name: 'reading time', type: 'datetime', role: 'time' },
  { name: 'Pressure', type: 'number', role: 'measure', unit: 'psia', quantity: 'pressure_abs' },
  { name: 'Choke', type: 'integer', role: 'measure' },
  { name: 'lat', type: 'number', role: 'latitude' },
  { name: 'lon', type: 'number', role: 'longitude' },
  { name: 'Online', type: 'boolean', role: 'text' },
  { name: 'Note', type: 'string', role: 'text' },
];

export const ROWS: CellValue[][] = [
  [
    'NS-A01',
    { date: '2026-01-01' },
    { datetime: '2026-01-01T06:00:00.000Z' },
    1205.3,
    32,
    57.4802,
    1.7501,
    true,
    'normal, "steady" flow',
  ],
  ['NS-A02', { date: '2026-01-01' }, { datetime: '2026-01-01T06:15:30.250Z' }, 0.1 + 0.2, 28, 57.51, 1.8, false, null],
  [
    'NS-A03',
    { date: '2026-01-02' },
    { datetime: '2026-01-02T06:00:00.000Z' },
    null,
    null,
    null,
    null,
    null,
    'line one\nline two',
  ],
  [
    'NS-A01',
    { date: '2026-01-02' },
    { datetime: '2026-01-02T06:00:00.000Z' },
    1e21,
    34,
    -33.9,
    151.2,
    true,
    'émission ° Förderrate',
  ],
];

function schemaOf(c: Col, i: number): ColumnSchema {
  const d = <T>(v: T) => detection(v, 'high', 'test', 'test fixture');
  return {
    id: `c${i}`,
    name: c.name,
    sourceHeader: [c.name],
    sourceIndex: i,
    type: d(c.type),
    role: d(c.role),
    unit: d<string | null>(c.unit ?? null),
    quantity: c.quantity ?? null,
    nullMarkers: d<string[]>([]),
  };
}

export function datasetOf(
  cols: Col[] = COLS,
  rows: CellValue[][] = ROWS,
  crs: CrsRef | null = { code: 'EPSG:4326', source: 'assumed-latlon' },
  geometryColumn: string | null = null,
): Dataset {
  const schemas = cols.map(schemaOf);
  const b = new TableBuilder(schemas.map((s) => ({ id: s.id, type: s.type.value })));
  rows.forEach((r, i) =>
    b.pushRow(
      i + 2,
      r.map((v): CellParse => ({ ok: true, value: v })),
    ),
  );
  return b.finish({
    datasetId: 'd1',
    name: 'well daily',
    source: { fileId: SOURCE_SHA, fileName: 'well_daily.csv', format: 'csv' },
    columns: schemas,
    crs: crs === null ? null : detection(crs, 'medium', 'test', 'test fixture'),
    geometryColumn,
    partial: false,
  });
}

export function viewOf(ds: Dataset): View {
  return new View(ds, {
    overlay: new Overlay(),
    excluded: new RowSet(ds.rowCount),
    derived: [],
    hidden: [],
    rowFilter: null,
    columnOrder: null,
  });
}

export const SOURCE_SHA = sha256Hex('well_daily.csv bytes');

function auditOf(n: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  let prev = sha256Hex('tracewell-audit-v1:p_0123456789abcdef');
  for (let seq = 1; seq <= n; seq++) {
    const body = {
      action: seq === 1 ? ('project.create' as const) : ('check.run' as const),
      target: {},
      seq,
      at: `2026-01-03T09:00:0${seq}.000Z`,
      actor: { kind: 'system' as const, component: 'engine' as const },
      prev,
      payload: { n: seq },
    };
    const hash = sha256Hex(canonicalJson(body as unknown as JsonValue));
    out.push({ ...body, hash });
    prev = hash;
  }
  return out;
}

export const ISSUES: Issue[] = [
  {
    id: 'I-0123456789ab',
    ruleId: 'TW-DQ-001',
    ruleVersion: '0.1.0',
    packId: 'tracewell.generic-dq',
    severity: 'warning',
    category: 'completeness',
    datasetId: 'd1',
    columns: ['c3'],
    scope: 'rows',
    title: 'Missing values',
    message: '1 rows have no value in Pressure.',
    explanation: 'Empty cells.',
    source: 'ISO 8000-8',
    status: 'open',
    counts: { flagged: 1, open: 1, accepted: 0, excluded: 0, fixed: 0 },
  } as Issue,
];

export function inputOf(view: View, over: Partial<ExportInput> = {}): ExportInput {
  const audit = auditOf(3);
  const last = audit[audit.length - 1] as AuditEntry;
  return {
    exportId: 'e_0000abcd',
    baseName: 'well daily',
    profile: 'csv',
    at: '2026-01-03T10:00:00.000Z',
    appVersion: '0.1.0',
    owner: 'Prasad',
    project: { id: 'p_0123456789abcdef', name: 'North Sea wells' },
    view,
    crs: view.schema.crs,
    sources: [{ fileId: SOURCE_SHA, name: 'well_daily.csv', size: 20, mediaType: 'text/csv', addedSeq: 2 }],
    rulePacks: [{ id: 'tracewell.generic-dq', version: '0.1.0', sha256: sha256Hex('pack') }],
    unitRegistry: { version: '2026.1', sha256: sha256Hex('registry') },
    steps: [],
    stepDescriptions: [],
    excludedRows: 0,
    assumptions: [],
    issues: ISSUES,
    audit,
    auditHead: { seq: last.seq, hash: last.hash },
    ...over,
  };
}

export const CTX = { signal: new AbortController().signal, onProgress: () => undefined };
