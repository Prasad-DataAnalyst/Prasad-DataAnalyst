/**
 * One pure function per check primitive (SAD section 8.3). Each scans the working view and returns
 * issue drafts; the semantics are written to translate one-to-one into the native engine's SQL.
 */
import {
  isBelowDetectionLimit,
  isGeometryCell,
  type CellValue,
  type CheckKind,
  type ColumnId,
  type ColumnSchema,
  type Geometry,
  type IssueDraft,
  type JsonValue,
  type RowId,
  type RuleDef,
  type RulePack,
} from '@tw/model';
import {
  bboxContains,
  bboxIntersectsGeometry,
  geometryInRange,
  geometryProblems,
  likelySwapped,
  positionsOf,
} from '@tw/geo';
import { physicalBounds, splitValueUnit } from '@tw/units';
import type { ColumnData, View } from '@tw/table';
import type { RuleContext } from './context';
import { flatlineRuns, hampelOutliers } from './hampel';
import { renderMessage } from './message';
import {
  columnValues,
  groupsInFileOrder,
  keyOf,
  median,
  seriesColumns,
  sortedByTime,
  type SeriesColumns,
  type TimedRow,
} from './series';

export type CheckFn = (rule: RuleDef, pack: RulePack, columns: ColumnSchema[], ctx: RuleContext) => IssueDraft[];

const WGS84 = new Set(['OGC:CRS84', 'EPSG:4326']);

// ---------------------------------------------------------------------------------------------
// Draft construction

interface DraftOptions {
  columns: ColumnSchema[];
  scope: IssueDraft['scope'];
  rows?: Iterable<RowId>;
  vars?: Record<string, string | number>;
  detail?: Record<string, JsonValue>;
}

function draft(rule: RuleDef, pack: RulePack, view: View, o: DraftOptions): IssueDraft {
  const rows = [...new Set(o.rows ?? [])].sort((a, b) => a - b);
  const first = o.columns[0];
  const vars = {
    column: first?.name ?? 'the dataset',
    count: rows.length,
    unit: first?.unit.value ?? '',
    detail: '',
    ...o.vars,
  };
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    packId: pack.id,
    severity: rule.severity,
    category: rule.category,
    datasetId: view.schema.datasetId,
    columns: o.columns.map((c) => c.id),
    scope: o.scope,
    rows,
    message: renderMessage(rule.message, vars),
    ...(o.detail === undefined ? {} : { detail: o.detail }),
  };
}

/** One rows-scope draft per column that flagged anything. */
function perColumn(
  rule: RuleDef,
  pack: RulePack,
  columns: ColumnSchema[],
  ctx: RuleContext,
  scan: (c: ColumnSchema) => {
    rows: RowId[];
    vars?: Record<string, string | number>;
    detail?: Record<string, JsonValue>;
  },
): IssueDraft[] {
  const out: IssueDraft[] = [];
  for (const c of columns) {
    const found = scan(c);
    if (found.rows.length === 0) continue;
    out.push(
      draft(rule, pack, ctx.view, {
        columns: [c],
        scope: 'rows',
        rows: found.rows,
        ...(found.vars === undefined ? {} : { vars: found.vars }),
        ...(found.detail === undefined ? {} : { detail: found.detail }),
      }),
    );
  }
  return out;
}

function columnScope(rule: RuleDef, pack: RulePack, ctx: RuleContext, c: ColumnSchema, detail: string): IssueDraft {
  return draft(rule, pack, ctx.view, { columns: [c], scope: 'column', vars: { detail } });
}

// ---------------------------------------------------------------------------------------------
// Cell access

function visibleRows(view: View): RowId[] {
  const rows: RowId[] = [];
  for (let i = 0; i < view.rowCount; i++) rows.push(view.rowIdAt(i));
  return rows;
}

function baseColumn(view: View, c: ColumnId): ColumnData | null {
  return view.dataset.schema.columns.some((s) => s.id === c) ? view.dataset.column(c) : null;
}

/** The source text kept for a failed parse; an edited cell has none. */
function failedText(view: View, base: ColumnData | null, r: RowId, c: ColumnId): string | undefined {
  if (base === null || view.isEdited(r, c) || base.parseOk(r)) return undefined;
  return base.raw(r);
}

function markerOf(view: View, base: ColumnData | null, r: RowId, c: ColumnId): string | undefined {
  if (base === null || view.isEdited(r, c)) return undefined;
  return base.nullMarker(r);
}

function examples(values: Iterable<string>, max = 3): string {
  const unique = [...new Set(values)];
  const shown = unique.slice(0, max).map((v) => (v === '' ? '(empty)' : v));
  return unique.length > max ? `${shown.join(', ')}, …` : shown.join(', ');
}

// ---------------------------------------------------------------------------------------------
// Completeness, validity, uniqueness

const notNull: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(
    rule,
    pack,
    columns.filter((c) => c.type.value !== 'geometry'),
    ctx,
    (c) => {
      const base = baseColumn(ctx.view, c.id);
      const rows = visibleRows(ctx.view).filter(
        (r) => ctx.view.value(r, c.id) === null && failedText(ctx.view, base, r, c.id) === undefined,
      );
      return { rows };
    },
  );

const typeConformance: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(rule, pack, columns, ctx, (c) => {
    const base = baseColumn(ctx.view, c.id);
    const texts: string[] = [];
    const rows = visibleRows(ctx.view).filter((r) => {
      const text = failedText(ctx.view, base, r, c.id);
      if (text === undefined || isBelowDetectionLimit(text)) return false;
      texts.push(text);
      return true;
    });
    return { rows, vars: { detail: c.type.value }, detail: { examples: examples(texts) } };
  });

const belowDetectionLimit: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(rule, pack, columns, ctx, (c) => {
    const base = baseColumn(ctx.view, c.id);
    const texts: string[] = [];
    const rows = visibleRows(ctx.view).filter((r) => {
      const text = failedText(ctx.view, base, r, c.id);
      if (text === undefined || !isBelowDetectionLimit(text)) return false;
      texts.push(text);
      return true;
    });
    return { rows, vars: { detail: examples(texts) } };
  });

const nullMarker: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(rule, pack, columns, ctx, (c) => {
    const base = baseColumn(ctx.view, c.id);
    const markers: string[] = [];
    const rows = visibleRows(ctx.view).filter((r) => {
      const m = markerOf(ctx.view, base, r, c.id);
      if (m === undefined || m === '') return false;
      markers.push(m);
      return true;
    });
    return { rows, vars: { detail: examples(markers) } };
  });

function rowKey(view: View, r: RowId): string {
  return JSON.stringify(
    view.schema.columns.map((c) => {
      const v = view.value(r, c.id);
      if (v !== null) return keyOf(v);
      const base = baseColumn(view, c.id);
      return ['raw', failedText(view, base, r, c.id) ?? markerOf(view, base, r, c.id) ?? null];
    }),
  );
}

function groupedRows(rows: RowId[], key: (r: RowId) => string | null): RowId[] {
  const groups = new Map<string, RowId[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [r]);
    else g.push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1).flat();
}

const duplicateRows: CheckFn = (rule, pack, _columns, ctx) => {
  const rows = groupedRows(visibleRows(ctx.view), (r) => rowKey(ctx.view, r));
  return rows.length === 0 ? [] : [draft(rule, pack, ctx.view, { columns: [], scope: 'rows', rows })];
};

function timeKeyRows(view: View, s: SeriesColumns, withId: boolean): RowId[] {
  return groupedRows(visibleRows(view), (r) => {
    const t = view.value(r, s.time.id);
    if (t === null) return null;
    return withId && s.id !== null ? `${keyOf(view.value(r, s.id.id))}|${keyOf(t)}` : keyOf(t);
  });
}

const duplicateKey: CheckFn = (rule, pack, _columns, ctx) => {
  const s = seriesColumns(ctx.view);
  if (s === null || s.id === null) return [];
  const rows = timeKeyRows(ctx.view, s, true);
  if (rows.length === 0) return [];
  return [
    draft(rule, pack, ctx.view, {
      columns: [s.id, s.time],
      scope: 'rows',
      rows,
      vars: { detail: `${s.id.name} and ${s.time.name}` },
    }),
  ];
};

// ---------------------------------------------------------------------------------------------
// Ranges and units

const physicalRange: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(rule, pack, columns, ctx, (c) => {
    const unit = c.unit.value;
    if (unit === null || c.quantity === null) return { rows: [] };
    const bounds = physicalBounds(c.quantity, unit);
    if (bounds === null || (bounds.min === undefined && bounds.max === undefined)) return { rows: [] };
    const rows = visibleRows(ctx.view).filter((r) => {
      const v = ctx.view.value(r, c.id);
      if (typeof v !== 'number') return false;
      return (bounds.min !== undefined && v < bounds.min) || (bounds.max !== undefined && v > bounds.max);
    });
    const limits = [
      bounds.min === undefined ? null : `minimum ${bounds.min}`,
      bounds.max === undefined ? null : `maximum ${bounds.max}`,
    ].filter((x) => x !== null);
    return {
      rows,
      vars: {
        unit,
        detail: limits.join(', '),
        ...(bounds.min === undefined ? {} : { min: bounds.min }),
        ...(bounds.max === undefined ? {} : { max: bounds.max }),
      },
      detail: { source: bounds.source },
    };
  });

const unitKnown: CheckFn = (rule, pack, columns, ctx) =>
  columns.filter((c) => c.unit.value === null).map((c) => columnScope(rule, pack, ctx, c, ''));

const unitConsistent: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(rule, pack, columns, ctx, (c) => {
    const units: { row: RowId; code: string }[] = [];
    let present = 0;
    for (const r of visibleRows(ctx.view)) {
      const v = ctx.view.value(r, c.id);
      if (typeof v !== 'string' || v.trim() === '') continue;
      present++;
      const split = splitValueUnit(v);
      if (split !== null) units.push({ row: r, code: split.unit.code });
    }
    // Only a column whose values mostly carry a unit is a column "of values with units".
    if (units.length < 2 || units.length * 2 < present) return { rows: [] };
    const counts = new Map<string, number>();
    for (const u of units) counts.set(u.code, (counts.get(u.code) ?? 0) + 1);
    let main = units[0]?.code ?? '';
    for (const [code, n] of counts) if (n > (counts.get(main) ?? 0)) main = code;
    const rows = units.filter((u) => u.code !== main).map((u) => u.row);
    const others = [...counts.keys()].filter((k) => k !== main);
    return { rows, vars: { detail: `mostly ${main}; also ${others.join(', ')}` } };
  });

// ---------------------------------------------------------------------------------------------
// Time

const tsDuplicate: CheckFn = (rule, pack, _columns, ctx) => {
  const s = seriesColumns(ctx.view);
  if (s === null) return [];
  const rows = timeKeyRows(ctx.view, s, true);
  if (rows.length === 0) return [];
  return [
    draft(rule, pack, ctx.view, {
      columns: s.id === null ? [s.time] : [s.id, s.time],
      scope: 'rows',
      rows,
      vars: { detail: s.id === null ? '' : `for the same ${s.id.name}` },
    }),
  ];
};

function seriesDraft(rule: RuleDef, pack: RulePack, ctx: RuleContext, s: SeriesColumns, rows: RowId[]): IssueDraft[] {
  if (rows.length === 0) return [];
  return [
    draft(rule, pack, ctx.view, {
      columns: s.id === null ? [s.time] : [s.id, s.time],
      scope: 'rows',
      rows,
      vars: { detail: s.id === null ? '' : `for the same ${s.id.name}` },
    }),
  ];
}

const tsOrder: CheckFn = (rule, pack, _columns, ctx) => {
  const s = seriesColumns(ctx.view);
  if (s === null) return [];
  const rows: RowId[] = [];
  for (const g of groupsInFileOrder(ctx.view, s)) {
    for (let i = 1; i < g.length; i++) {
      const cur = g[i] as TimedRow;
      if (cur.t < (g[i - 1] as TimedRow).t) rows.push(cur.row);
    }
  }
  return seriesDraft(rule, pack, ctx, s, rows);
};

const tsGap: CheckFn = (rule, pack, _columns, ctx) => {
  if (rule.check.kind !== 'ts_gap') return [];
  const factor = rule.check.factor;
  const s = seriesColumns(ctx.view);
  if (s === null) return [];
  const rows: RowId[] = [];
  for (const g of groupsInFileOrder(ctx.view, s)) {
    const sorted = sortedByTime(g);
    const steps = sorted.slice(1).map((r, i) => r.t - (sorted[i] as TimedRow).t);
    const positive = steps.filter((d) => d > 0);
    if (positive.length === 0) continue;
    const m = median(positive);
    steps.forEach((d, i) => {
      if (d > 0 && d > factor * m) rows.push((sorted[i + 1] as TimedRow).row);
    });
  }
  return seriesDraft(rule, pack, ctx, s, rows);
};

const tzSpecified: CheckFn = (rule, pack, columns, ctx) =>
  columns
    .filter((c) => c.type.value === 'datetime' && c.timezone?.assumed === true)
    .map((c) => columnScope(rule, pack, ctx, c, c.timezone?.value ?? ''));

const dateAmbiguous: CheckFn = (rule, pack, columns, ctx) =>
  columns
    .filter((c) => c.dateFormat?.assumed === true && (c.dateFormat.value === 'dmy' || c.dateFormat.value === 'mdy'))
    .map((c) => columnScope(rule, pack, ctx, c, c.dateFormat?.value === 'dmy' ? 'day/month' : 'month/day'));

function perSeriesColumn(
  rule: RuleDef,
  pack: RulePack,
  columns: ColumnSchema[],
  ctx: RuleContext,
  flag: (values: CellValue[]) => number[],
): IssueDraft[] {
  const s = seriesColumns(ctx.view);
  if (s === null) return [];
  const groups = groupsInFileOrder(ctx.view, s).map(sortedByTime);
  return perColumn(rule, pack, columns, ctx, (c) => {
    const rows: RowId[] = [];
    for (const g of groups) {
      const values = columnValues(ctx.view, g, c.id);
      for (const i of flag(values)) rows.push((g[i] as TimedRow).row);
    }
    return { rows };
  });
}

const flatline: CheckFn = (rule, pack, columns, ctx) => {
  if (rule.check.kind !== 'flatline') return [];
  const minRun = rule.check.minRun;
  return perSeriesColumn(rule, pack, columns, ctx, (values) =>
    flatlineRuns(values, minRun).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)),
  );
};

const spike: CheckFn = (rule, pack, columns, ctx) => {
  if (rule.check.kind !== 'spike') return [];
  const { window, k } = rule.check;
  return perSeriesColumn(rule, pack, columns, ctx, (values) =>
    hampelOutliers(
      values.map((v) => (typeof v === 'number' ? v : null)),
      window,
      k,
    ),
  );
};

// ---------------------------------------------------------------------------------------------
// Spatial

function geometryOf(v: CellValue): Geometry | null {
  return isGeometryCell(v) ? v.geometry : null;
}

function validGeometry(g: Geometry): boolean {
  return geometryProblems(g).every((p) => p.code === 'SKIPPED_TOO_LARGE');
}

function isWgs84(view: View): boolean {
  const crs = view.schema.crs;
  return crs !== null && WGS84.has(crs.value.code);
}

interface LatLon {
  lat: ColumnSchema;
  lon: ColumnSchema;
}

function latLonColumns(view: View): LatLon | null {
  const lat = view.schema.columns.find((c) => c.role.value === 'latitude');
  const lon = view.schema.columns.find((c) => c.role.value === 'longitude');
  return lat === undefined || lon === undefined ? null : { lat, lon };
}

function numberOrNull(v: CellValue): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function geometryColumn(view: View): ColumnSchema | null {
  const id = view.schema.geometryColumn;
  return id === null ? null : (view.schema.columns.find((c) => c.id === id) ?? null);
}

function spatialColumns(view: View): ColumnSchema[] {
  const g = geometryColumn(view);
  const ll = latLonColumns(view);
  return [...(g === null ? [] : [g]), ...(ll === null ? [] : [ll.lat, ll.lon])];
}

const geometryValid: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(rule, pack, columns, ctx, (c) => {
    const codes: string[] = [];
    const rows = visibleRows(ctx.view).filter((r) => {
      const g = geometryOf(ctx.view.value(r, c.id));
      if (g === null) return false;
      const problems = geometryProblems(g).filter((p) => p.code !== 'SKIPPED_TOO_LARGE');
      codes.push(...problems.map((p) => p.code));
      return problems.length > 0;
    });
    return { rows, vars: { detail: examples(codes, 4) } };
  });

const geometryPresent: CheckFn = (rule, pack, columns, ctx) =>
  perColumn(rule, pack, columns, ctx, (c) => ({
    rows: visibleRows(ctx.view).filter((r) => ctx.view.value(r, c.id) === null),
  }));

function spatialRows(
  view: View,
  test: { geometry(g: Geometry): boolean; point(lon: number | null, lat: number | null): boolean },
): RowId[] {
  const g = geometryColumn(view);
  const ll = latLonColumns(view);
  return visibleRows(view).filter((r) => {
    if (g !== null) {
      const geom = geometryOf(view.value(r, g.id));
      if (geom !== null && test.geometry(geom)) return true;
    }
    if (ll !== null) {
      const lat = numberOrNull(view.value(r, ll.lat.id));
      const lon = numberOrNull(view.value(r, ll.lon.id));
      if ((lat !== null || lon !== null) && test.point(lon, lat)) return true;
    }
    return false;
  });
}

function spatialDraft(rule: RuleDef, pack: RulePack, ctx: RuleContext, rows: RowId[]): IssueDraft[] {
  if (rows.length === 0) return [];
  return [draft(rule, pack, ctx.view, { columns: spatialColumns(ctx.view), scope: 'rows', rows })];
}

const coordRange: CheckFn = (rule, pack, _columns, ctx) => {
  if (!isWgs84(ctx.view)) return [];
  const rows = spatialRows(ctx.view, {
    geometry: (g) => validGeometry(g) && !geometryInRange(g),
    point: (lon, lat) => (lat !== null && Math.abs(lat) > 90) || (lon !== null && Math.abs(lon) > 180),
  });
  return spatialDraft(rule, pack, ctx, rows);
};

const latlonSwapped: CheckFn = (rule, pack, _columns, ctx) => {
  if (!isWgs84(ctx.view)) return [];
  const area = { projectArea: ctx.projectArea };
  const rows = spatialRows(ctx.view, {
    geometry: (g) =>
      validGeometry(g) && [...positionsOf(g)].some(([lon, lat]) => likelySwapped(lon ?? NaN, lat ?? NaN, area)),
    point: (lon, lat) => lon !== null && lat !== null && likelySwapped(lon, lat, area),
  });
  return spatialDraft(rule, pack, ctx, rows);
};

const crsWgs84: CheckFn = (rule, pack, _columns, ctx) => {
  const crs = ctx.view.schema.crs;
  if (crs === null || WGS84.has(crs.value.code)) return [];
  const label = crs.value.code === 'unknown' ? 'an undeclared coordinate system' : crs.value.code;
  return [
    draft(rule, pack, ctx.view, {
      columns: spatialColumns(ctx.view),
      scope: 'dataset',
      vars: { detail: label },
      detail: { crs: crs.value.code },
    }),
  ];
};

const withinArea: CheckFn = (rule, pack, _columns, ctx) => {
  const area = ctx.projectArea;
  if (area === null || !isWgs84(ctx.view)) return [];
  const rows = spatialRows(ctx.view, {
    geometry: (g) => validGeometry(g) && !bboxIntersectsGeometry(area, g),
    point: (lon, lat) => lon !== null && lat !== null && !bboxContains(area, lon, lat),
  });
  return spatialDraft(rule, pack, ctx, rows);
};

// ---------------------------------------------------------------------------------------------
// Import notes

function rowsAtLocations(view: View, locs: Set<number>): RowId[] {
  const rows: RowId[] = [];
  for (let r = 0; r < view.dataset.rowCount; r++) if (locs.has(view.dataset.srcLoc(r))) rows.push(r);
  return rows;
}

const importNote: CheckFn = (rule, pack, _columns, ctx) => {
  if (rule.check.kind !== 'import_note') return [];
  const code = rule.check.code;
  if (code === 'TW-IMP-005') {
    if (ctx.assumptions.length === 0) return [];
    return [
      draft(rule, pack, ctx.view, {
        columns: [],
        scope: 'dataset',
        vars: { count: ctx.assumptions.length },
        detail: { assumptions: ctx.assumptions.map((a) => `${a.columnId ?? 'dataset'}.${a.property}`) },
      }),
    ];
  }
  const notes = ctx.importNotes.filter((n) => n.code === code);
  if (notes.length === 0) return [];
  if (code === 'TW-IMP-001') {
    const locs = new Set(notes.flatMap((n) => (n.srcLoc === undefined ? [] : [n.srcLoc])));
    const rows = rowsAtLocations(ctx.view, locs);
    return [draft(rule, pack, ctx.view, { columns: [], scope: 'rows', rows })];
  }
  const detail = notes.map((n) => n.message).join(' ');
  return [
    draft(rule, pack, ctx.view, { columns: [], scope: 'dataset', vars: { detail }, detail: { notes: notes.length } }),
  ];
};

const systemOnly: CheckFn = () => [];

export const CHECKS: Record<CheckKind, CheckFn> = {
  not_null: notNull,
  duplicate_rows: duplicateRows,
  duplicate_key: duplicateKey,
  type_conformance: typeConformance,
  below_detection_limit: belowDetectionLimit,
  physical_range: physicalRange,
  null_marker: nullMarker,
  unit_known: unitKnown,
  unit_consistent: unitConsistent,
  ts_duplicate: tsDuplicate,
  ts_order: tsOrder,
  ts_gap: tsGap,
  tz_specified: tzSpecified,
  date_ambiguous: dateAmbiguous,
  flatline,
  spike,
  geometry_valid: geometryValid,
  coord_range: coordRange,
  latlon_swapped: latlonSwapped,
  within_area: withinArea,
  crs_wgs84: crsWgs84,
  geometry_present: geometryPresent,
  import_note: importNote,
  system: systemOnly,
};
