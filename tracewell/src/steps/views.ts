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
import { RowSet, View, type Dataset, type DerivedColumn, type Overlay } from '@tw/table';
import { applyConversion, checkConvertible, conversionMethod, getUnit } from '@tw/units';
import { compilePredicate, describePredicate } from './predicate';

export interface StepState {
  overlay: Overlay;
  excluded: RowSet;
  steps: Step[];
}

type ConvertStep = Extract<StepInput, { kind: 'convert_unit' }>;

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

export function validateStep(s: StepInput, schema: TableSchema): { ok: true } | { ok: false; error: EngineErrorData } {
  try {
    switch (s.kind) {
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

interface Built {
  view: View;
  order: ColumnId[];
  derived: DerivedColumn[];
  hidden: ColumnId[];
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
  for (const step of st.steps) {
    if (step.kind !== 'convert_unit') continue;
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
    current = new View(ds, {
      overlay: st.overlay,
      excluded: st.excluded,
      derived: [...derived],
      hidden: [...hidden],
      rowFilter: null,
      columnOrder: order,
    });
  }
  return { view: current, order, derived, hidden: [...hidden] };
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
  });
}

export function describeStep(s: StepInput, schema: TableSchema): string {
  switch (s.kind) {
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
  const schema = s.kind === 'convert_unit' ? buildWorkingView(ds, st).schema : outputBefore.schema;
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
  return { ok: true, description, sample, resultingRows: after.rowCount };
}
