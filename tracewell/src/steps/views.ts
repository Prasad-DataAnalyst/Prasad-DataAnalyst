/**
 * Process and Extract (SAD section 7.7): the working view holds the overlay, exclusions and unit
 * conversions, and is what checks run on; the output view adds filters and column selection, in
 * step order, and is what exports write. Steps never change the dataset; they build views over it.
 */
import {
  EngineError,
  userDetection,
  type ColumnId,
  type ColumnSchema,
  type ConversionMethod,
  type EngineErrorData,
  type Step,
  type StepInput,
  type StepPreview,
  type TableSchema,
} from '@tw/model';
import { CRS_REGISTRY_SOURCE, CRS_REGISTRY_VERSION, crsTransformer, type CrsTransformer } from '@tw/geo';
import { RowSet, View, type Dataset, type DerivedColumn, type Overlay } from '@tw/table';
import { applyConversion, checkConvertible, conversionMethod, getUnit } from '@tw/units';
import { compilePredicate, describePredicate } from './predicate';
import { transformGeometry } from './places';

export interface StepState {
  overlay: Overlay;
  excluded: RowSet;
  steps: Step[];
}

type ConvertStep = Extract<StepInput, { kind: 'convert_unit' }>;
type CrsStep = Extract<StepInput, { kind: 'transform_crs' }>;

/** Steps that read and change the working view: every column, before any filter or selection. */
export function isWorkingStep(s: StepInput): s is ConvertStep | CrsStep {
  return s.kind === 'convert_unit' || s.kind === 'transform_crs';
}

export function derivedColumnId(columnId: ColumnId, toUnit: string): ColumnId {
  return `${columnId}~${toUnit.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function toErrorData(e: unknown): EngineErrorData {
  const err = EngineError.from(e);
  return err.detail === undefined
    ? { code: err.code, message: err.message, fix: err.fix }
    : { code: err.code, message: err.message, fix: err.fix, detail: err.detail };
}

function findColumn(schema: TableSchema, id: ColumnId): ColumnSchema {
  const c = schema.columns.find((x) => x.id === id);
  if (c === undefined) {
    throw new EngineError('NOT_FOUND', `There is no column ${id} at this step.`, 'Choose a listed column.', {
      column: id,
    });
  }
  return c;
}

export function conversionFor(s: ConvertStep, schema: TableSchema): ConversionMethod {
  const c = findColumn(schema, s.columnId);
  if (c.type.value !== 'number' && c.type.value !== 'integer') {
    throw new EngineError(
      'INVALID_INPUT',
      `${c.name} holds ${c.type.value} values; only number columns can be converted.`,
      'Choose a numeric column, or change the column type first.',
      { column: c.id },
    );
  }
  const from = c.unit.value;
  if (from === null) {
    throw new EngineError(
      'UNIT_UNKNOWN',
      `${c.name} has no unit, so it cannot be converted.`,
      'Set the column unit first.',
      {
        column: c.id,
      },
    );
  }
  const check = checkConvertible(from, s.toUnit);
  if (!check.ok) throw new EngineError(check.code, check.message, check.fix, { from, to: s.toUnit });
  return conversionMethod(from, s.toUnit);
}

/** What a coordinate transformation reads: the geometry column, or the x and y columns. */
export interface CrsPlan {
  transformer: CrsTransformer;
  geometry: ColumnSchema | null;
  /** Longitude or easting. */
  x: ColumnSchema | null;
  /** Latitude or northing. */
  y: ColumnSchema | null;
}

function numericWithRole(schema: TableSchema, role: ColumnSchema['role']['value']): ColumnSchema | undefined {
  return schema.columns.find((c) => c.role.value === role && (c.type.value === 'number' || c.type.value === 'integer'));
}

export function crsPlanFor(s: CrsStep, schema: TableSchema): CrsPlan {
  const from = schema.crs?.value.code;
  if (from === undefined || from === 'unknown') {
    throw new EngineError(
      'INVALID_INPUT',
      'The coordinate reference system of the data is not known, so its coordinates cannot be transformed.',
      'Set the coordinate reference system of the dataset first.',
    );
  }
  if (from === s.toCrs) {
    throw new EngineError(
      'INVALID_INPUT',
      `The coordinates are already in ${from}.`,
      'Choose another coordinate reference system.',
    );
  }
  const transformer = crsTransformer(from, s.toCrs);
  const g = schema.geometryColumn === null ? undefined : schema.columns.find((c) => c.id === schema.geometryColumn);
  if (g !== undefined && g.type.value === 'geometry') return { transformer, geometry: g, x: null, y: null };
  const geographic = transformer.from.kind === 'geographic';
  const x = numericWithRole(schema, geographic ? 'longitude' : 'easting');
  const y = numericWithRole(schema, geographic ? 'latitude' : 'northing');
  if (x === undefined || y === undefined) {
    const pair = geographic ? 'latitude and longitude' : 'easting and northing';
    throw new EngineError(
      'INVALID_INPUT',
      `The data has no geometry column and no numeric ${pair} columns to transform from ${from}.`,
      `Set the ${pair} roles on the coordinate columns first.`,
    );
  }
  return { transformer, geometry: null, x, y };
}

export function validateStep(s: StepInput, schema: TableSchema): { ok: true } | { ok: false; error: EngineErrorData } {
  try {
    switch (s.kind) {
      case 'transform_crs':
        crsPlanFor(s, schema);
        break;
      case 'convert_unit': {
        conversionFor(s, schema);
        const id = derivedColumnId(s.columnId, s.toUnit);
        if (schema.columns.some((c) => c.id === id)) {
          throw new EngineError(
            'INVALID_INPUT',
            `The column is already converted to ${s.toUnit}.`,
            'Remove the earlier conversion first.',
            {
              column: id,
            },
          );
        }
        break;
      }
      case 'filter':
        compilePredicate(s.predicate, schema);
        break;
      case 'select_columns': {
        if (s.columnIds.length === 0) {
          throw new EngineError('INVALID_INPUT', 'Select at least one column to keep.', 'Tick the columns to keep.');
        }
        if (new Set(s.columnIds).size !== s.columnIds.length) {
          throw new EngineError('INVALID_INPUT', 'A column is selected twice.', 'Select each column once.');
        }
        for (const id of s.columnIds) findColumn(schema, id);
        break;
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toErrorData(e) };
  }
}

function derivedFor(
  step: ConvertStep & { id: Step['id']; seq: Step['seq'] },
  source: ColumnSchema,
  method: ConversionMethod,
): DerivedColumn {
  const unit = getUnit(method.to);
  const schema: ColumnSchema = {
    ...source,
    id: derivedColumnId(step.columnId, step.toUnit),
    name: step.mode === 'replace' ? source.name : `${source.name} (${method.to})`,
    type: { ...source.type, value: 'number' },
    unit: userDetection<string | null>(method.to, step.seq),
    quantity: unit?.quantity ?? source.quantity,
    derivedFrom: { column: step.columnId, step: step.id },
  };
  return {
    schema,
    compute: (get, r) => {
      const v = get(step.columnId, r);
      return typeof v === 'number' ? applyConversion(method, v) : null;
    },
  };
}

/** The column ID a transformation gives the column it transforms. */
export function transformedColumnId(columnId: ColumnId, toCrs: string): ColumnId {
  return `${columnId}~${toCrs.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** The transformed columns of a coordinate transformation, each replacing its source column. */
function crsDerived(step: CrsStep & { id: Step['id']; seq: Step['seq'] }, plan: CrsPlan): DerivedColumn[] {
  const t = plan.transformer;
  const from = { column: '', step: step.id };
  if (plan.geometry !== null) {
    const g = plan.geometry;
    return [
      {
        schema: { ...g, id: transformedColumnId(g.id, step.toCrs), derivedFrom: { ...from, column: g.id } },
        compute: (get, r) => transformGeometry(get(g.id, r), t),
      },
    ];
  }
  const x = plan.x as ColumnSchema;
  const y = plan.y as ColumnSchema;
  const geographic = t.to.kind === 'geographic';
  const sameKind = t.from.kind === t.to.kind;
  const unit = (c: ColumnSchema) =>
    sameKind
      ? c.unit
      : { ...c.unit, value: geographic ? null : 'm', source: 'user' as const, evidence: `Set by step ${step.id}.` };
  const column = (c: ColumnSchema, axis: 0 | 1): DerivedColumn => {
    const role = geographic ? (axis === 0 ? 'longitude' : 'latitude') : axis === 0 ? 'easting' : 'northing';
    const name = sameKind
      ? c.name
      : geographic
        ? axis === 0
          ? 'Longitude'
          : 'Latitude'
        : axis === 0
          ? 'Easting'
          : 'Northing';
    return {
      schema: {
        ...c,
        id: transformedColumnId(c.id, step.toCrs),
        name,
        type: { ...c.type, value: 'number' },
        role: sameKind ? c.role : { ...c.role, value: role, source: 'user', evidence: `Set by step ${step.id}.` },
        unit: unit(c),
        quantity: sameKind ? c.quantity : geographic ? null : 'length',
        derivedFrom: { ...from, column: c.id },
      },
      compute: (get, r) => {
        const vx = get(x.id, r);
        const vy = get(y.id, r);
        if (typeof vx !== 'number' || typeof vy !== 'number') return null;
        const p = t.forward(vx, vy);
        return p === null ? null : p[axis];
      },
    };
  };
  return [column(x, 0), column(y, 1)];
}

type ViewPlaces = NonNullable<ConstructorParameters<typeof View>[1]['places']>;
type CrsCode = NonNullable<TableSchema['crs']>['value']['code'];

interface Built {
  view: View;
  order: ColumnId[];
  derived: DerivedColumn[];
  hidden: ColumnId[];
  places?: ViewPlaces;
}

function buildWorking(ds: Dataset, st: StepState): Built {
  const derived: DerivedColumn[] = [];
  const hidden = new Set<ColumnId>();
  let order = ds.schema.columns.map((c) => c.id);
  let current = new View(ds, {
    overlay: st.overlay,
    excluded: st.excluded,
    derived: [],
    hidden: [],
    rowFilter: null,
    columnOrder: null,
  });
  let places: ViewPlaces | undefined;
  for (const step of st.steps) {
    if (step.kind === 'convert_unit') {
      const source = findColumn(current.schema, step.columnId);
      const method = conversionFor(step, current.schema);
      const d = derivedFor(step, source, method);
      derived.push(d);
      const at = order.indexOf(step.columnId);
      if (step.mode === 'replace') {
        hidden.add(step.columnId);
        order = [...order.slice(0, at), d.schema.id, ...order.slice(at + 1)];
      } else {
        order = [...order.slice(0, at + 1), d.schema.id, ...order.slice(at + 1)];
      }
    } else if (step.kind === 'transform_crs') {
      const plan = crsPlanFor(step, current.schema);
      for (const d of crsDerived(step, plan)) {
        derived.push(d);
        const source = d.schema.derivedFrom?.column as ColumnId;
        hidden.add(source);
        order = order.map((c) => (c === source ? d.schema.id : c));
      }
      places = {
        crs: {
          value: { code: plan.transformer.to.code as CrsCode, source: 'user' },
          confidence: 'high',
          assumed: false,
          source: 'user',
          method: 'transform',
          evidence: `Transformed from ${plan.transformer.from.code} by step ${step.id}.`,
        },
        geometryColumn:
          plan.geometry === null ? current.schema.geometryColumn : transformedColumnId(plan.geometry.id, step.toCrs),
      };
    } else continue;
    current = new View(ds, {
      overlay: st.overlay,
      excluded: st.excluded,
      derived: [...derived],
      hidden: [...hidden],
      rowFilter: null,
      columnOrder: order,
      ...(places === undefined ? {} : { places }),
    });
  }
  return { view: current, order, derived, hidden: [...hidden], ...(places === undefined ? {} : { places }) };
}

export function buildWorkingView(ds: Dataset, st: StepState): View {
  return buildWorking(ds, st).view;
}

export function buildOutputView(ds: Dataset, st: StepState): View {
  const working = buildWorking(ds, st);
  const all = new Set(working.view.schema.columns.map((c) => c.id));
  let columns = working.order.filter((c) => all.has(c));
  let rows: RowSet | null = null;
  let schema = working.view.schema;
  for (const step of st.steps) {
    if (step.kind === 'filter') {
      const test = compilePredicate(step.predicate, schema);
      const keep = new RowSet(ds.rowCount);
      for (let i = 0; i < working.view.rowCount; i++) {
        const r = working.view.rowIdAt(i);
        if (rows !== null && !rows.has(r)) continue;
        if (test((c) => working.view.value(r, c))) keep.add(r);
      }
      rows = keep;
    } else if (step.kind === 'select_columns') {
      for (const id of step.columnIds) findColumn(schema, id);
      columns = [...step.columnIds];
      schema = { ...schema, columns: columns.map((id) => findColumn(working.view.schema, id)) };
    }
  }
  const unselected = [...all].filter((c) => !columns.includes(c));
  return new View(ds, {
    overlay: st.overlay,
    excluded: st.excluded,
    derived: working.derived,
    hidden: [...working.hidden, ...unselected],
    rowFilter: rows,
    columnOrder: columns,
    ...(working.places === undefined ? {} : { places: working.places }),
  });
}

/** What the audit log records of a transformation: the systems, the operations and the accuracy. */
export function crsTransformationOf(
  s: CrsStep,
  schema: TableSchema,
): {
  from: string;
  to: string;
  operations: { code: string; name: string; method: string; accuracy: number | null }[];
  accuracy: number;
  registryVersion: string;
  source: string;
} {
  const t = crsPlanFor(s, schema).transformer;
  return {
    from: t.from.code,
    to: t.to.code,
    operations: t.operations.map((o) => ({ ...o })),
    accuracy: t.accuracy,
    registryVersion: CRS_REGISTRY_VERSION,
    source: CRS_REGISTRY_SOURCE,
  };
}

export function describeStep(s: StepInput, schema: TableSchema): string {
  switch (s.kind) {
    case 'transform_crs': {
      try {
        const t = crsPlanFor(s, schema).transformer;
        const datum = t.operations.filter((o) => o.accuracy !== null).map((o) => `${o.name} (${o.code})`);
        const via = datum.length === 0 ? '' : `, through ${datum.join(' and ')}, accurate to ${t.accuracy} m`;
        return `Transform coordinates from ${t.from.code} (${t.from.name}) to ${t.to.code} (${t.to.name})${via}`;
      } catch {
        return `Transform coordinates to ${s.toCrs}`;
      }
    }
    case 'convert_unit': {
      const c = schema.columns.find((x) => x.id === s.columnId);
      const name = c?.name ?? s.columnId;
      try {
        const m = conversionFor(s, schema);
        const linear = m.fromOffset === 0 && m.toOffset === 0;
        const how = linear ? `×${m.fromFactor / m.toFactor}` : m.formula;
        const mode = s.mode === 'add_column' ? ', as a new column' : '';
        return `Convert ${name} from ${m.from} to ${m.to} (${how}, ${m.source})${mode}`;
      } catch {
        return `Convert ${name} to ${s.toUnit}`;
      }
    }
    case 'filter':
      return s.label ?? `Keep rows where ${describePredicate(s.predicate, schema)}`;
    case 'select_columns':
      return `Keep columns ${s.columnIds.map((id) => schema.columns.find((c) => c.id === id)?.name ?? id).join(', ')}`;
  }
}

export function previewStep(ds: Dataset, st: StepState, s: StepInput, sampleSize = 20): StepPreview {
  const outputBefore = buildOutputView(ds, st);
  const schema = isWorkingStep(s) ? buildWorkingView(ds, st).schema : outputBefore.schema;
  const valid = validateStep(s, schema);
  if (!valid.ok) return { ok: false, error: valid.error, description: '', sample: [] };
  const description = describeStep(s, schema);
  const nextStep = { ...s, id: `s${st.steps.length + 1}`, seq: Number.MAX_SAFE_INTEGER } as Step;
  const next: StepState = { ...st, steps: [...st.steps, nextStep] };
  const after = buildOutputView(ds, next);
  const sample: StepPreview['sample'] = [];
  if (s.kind === 'convert_unit') {
    const working = buildWorkingView(ds, next);
    const id = derivedColumnId(s.columnId, s.toUnit);
    const before = buildWorkingView(ds, st);
    for (let i = 0; i < Math.min(sampleSize, working.rowCount); i++) {
      const r = working.rowIdAt(i);
      sample.push({ rowId: r, before: before.value(r, s.columnId), after: working.value(r, id) });
    }
    return { ok: true, method: conversionFor(s, schema), description, sample, resultingRows: after.rowCount };
  }
  if (s.kind === 'transform_crs') {
    // The first coordinate a transformation changes: the geometry, or the longitude or easting.
    const plan = crsPlanFor(s, schema);
    const source = (plan.geometry ?? plan.x) as ColumnSchema;
    const working = buildWorkingView(ds, next);
    const before = buildWorkingView(ds, st);
    const id = transformedColumnId(source.id, s.toCrs);
    for (let i = 0; i < Math.min(sampleSize, working.rowCount); i++) {
      const r = working.rowIdAt(i);
      sample.push({ rowId: r, before: before.value(r, source.id), after: working.value(r, id) });
    }
  }
  return { ok: true, description, sample, resultingRows: after.rowCount };
}
