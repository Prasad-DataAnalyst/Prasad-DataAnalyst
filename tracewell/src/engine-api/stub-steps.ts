/**
 * The stub's processing and extraction steps: preview, apply (as a job) and remove. Steps build
 * views over the data and never change it, so removing one restores the earlier view exactly.
 */
import {
  canonicalNumber,
  EngineError,
  schemas,
  type AuditDraft,
  type AuditEntry,
  type CellValue,
  type ConversionMethod,
  type Predicate,
  type PredicateValue,
  type Step,
  type StepId,
  type StepInput,
  type StepPreview,
  type StepResult,
} from '@tw/model';
import { requireReason } from './stub-decisions';
import { asJson, type StubProject } from './stub-project';
import {
  conversionMethod,
  convertValue,
  derivedId,
  findColumn,
  outputView,
  stepColumns,
  validateStep,
  workingView,
  type StubDataset,
  type StubView,
} from './stub-view';

const SAMPLE_ROWS = 5;

export function parseStep(input: unknown): StepInput {
  const parsed = schemas.stepInput.safeParse(input);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw new EngineError(
    'INVALID_INPUT',
    `The step is not valid: ${first?.message ?? 'unknown problem'}.`,
    'Build the step with the Convert units, Filter or Columns dialog.',
  );
}

function columnName(view: StubView, columnId: string): string {
  return view.columns.find((c) => c.schema.id === columnId)?.schema.name ?? columnId;
}

function valueText(v: PredicateValue): string {
  if (typeof v === 'number') return canonicalNumber(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return 'date' in v ? v.date : v.datetime;
}

const OPS: Record<'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge', string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
};

function describePredicate(p: Predicate, view: StubView): string {
  if ('all' in p) return p.all.map((q) => describePredicate(q, view)).join(' and ');
  if ('any' in p) return `(${p.any.map((q) => describePredicate(q, view)).join(' or ')})`;
  if ('not' in p) return `not (${describePredicate(p.not, view)})`;
  if ('bbox' in p) return `inside the box ${p.bbox.join(', ')}`;
  const name = columnName(view, p.column);
  switch (p.op) {
    case 'is_null':
      return `${name} is empty`;
    case 'not_null':
      return `${name} is not empty`;
    case 'contains':
      return `${name} contains ${JSON.stringify(p.text)}`;
    case 'in':
      return `${name} is one of ${p.values.map(valueText).join(', ')}`;
    case 'between':
      return `${name} is between ${valueText(p.low)} and ${valueText(p.high)}`;
    default:
      return `${name} ${OPS[p.op]} ${valueText(p.value)}`;
  }
}

export function describeStep(ds: StubDataset, s: StepInput): string {
  const view = workingView(ds);
  switch (s.kind) {
    case 'convert_unit': {
      const column = view.columns.find((c) => c.schema.id === s.columnId)?.schema;
      const how = s.mode === 'replace' ? 'replacing the column' : 'as a new column';
      return `Convert ${column?.name ?? s.columnId} from ${column?.unit.value ?? '?'} to ${s.toUnit}, ${how}`;
    }
    case 'filter':
      return s.label ?? `Keep rows where ${describePredicate(s.predicate, view)}`;
    case 'select_columns':
      return `Keep ${s.columnIds.length} of ${view.columns.length} columns: ${s.columnIds.map((id) => columnName(view, id)).join(', ')}`;
  }
}

/** The output row count with `s` added, computed on a copy so the dataset is not touched. */
function rowsWith(ds: StubDataset, s: StepInput): number {
  const trial: StubDataset = { ...ds, steps: [...ds.steps, { ...s, id: 'preview', seq: 0 }] };
  return outputView(trial).rows.length;
}

export function previewStep(ds: StubDataset, input: unknown): StepPreview {
  const s = parseStep(input);
  const description = describeStep(ds, s);
  try {
    validateStep(ds, s);
  } catch (e) {
    return { ok: false, error: EngineError.from(e).toData(), description, sample: [] };
  }
  if (s.kind !== 'convert_unit') return { ok: true, description, sample: [], resultingRows: rowsWith(ds, s) };
  const view = workingView(ds);
  const column = findColumn(view, s.columnId);
  const method = conversionMethod(column.schema, s.toUnit);
  const sample = view.rows
    .map((rowId) => ({ rowId, before: column.value(rowId) }))
    .filter((r) => r.before !== null)
    .slice(0, SAMPLE_ROWS)
    .map((r) => ({ ...r, after: convertValue(r.before, method) }));
  return { ok: true, method, description, sample, resultingRows: outputView(ds).rows.length };
}

/** Later steps that read a column this step makes; removing it would leave them dangling. */
function dependents(ds: StubDataset, step: Step): Step[] {
  if (step.kind !== 'convert_unit') return [];
  const made = derivedId(step.columnId, step.toUnit);
  return ds.steps.filter((s) => s.seq > step.seq && stepColumns(s).some((c) => c === made || c.startsWith(`${made}~`)));
}

function guardDependents(ds: StubDataset, step: Step): void {
  const later = dependents(ds, step);
  if (later.length > 0) {
    const ids = later.map((s) => s.id).join(', ');
    throw new EngineError(
      'INVALID_INPUT',
      `Step ${step.id} makes a column that step ${ids} uses.`,
      `Remove step ${ids} first, then step ${step.id}.`,
    );
  }
}

interface Counts {
  method: ConversionMethod;
  converted: number;
  nullsSkipped: number;
}

function conversionCounts(ds: StubDataset, s: StepInput & { kind: 'convert_unit' }): Counts {
  const view = workingView(ds);
  const column = findColumn(view, s.columnId);
  const values: CellValue[] = view.rows.map((r) => column.value(r));
  const converted = values.filter((v) => typeof v === 'number').length;
  return { method: conversionMethod(column.schema, s.toUnit), converted, nullsSkipped: values.length - converted };
}

/**
 * Validates a step now, so the caller hears about a bad step before any job starts, and returns
 * the job body that applies it. The body validates again: the data may change while it waits.
 */
export function planStep(project: StubProject, ds: StubDataset, input: unknown, reason: string): () => StepResult {
  const s = parseStep(input);
  const why = requireReason(reason, 'apply a step');
  validateStep(ds, s);
  return () => {
    validateStep(ds, s);
    // Described before it is applied: a replacing conversion removes the column it names.
    const description = describeStep(ds, s);
    const counts = s.kind === 'convert_unit' ? conversionCounts(ds, s) : undefined;
    const step: Step = { ...s, id: project.nextStepId(), seq: project.head().seq + 1 };
    const draft: AuditDraft = {
      action: 'step.apply',
      target: { datasetId: ds.id, stepId: step.id },
      new: asJson(step),
      reason: why,
    };
    if (s.kind === 'convert_unit') draft.target.columnId = s.columnId;
    if (counts !== undefined) {
      draft.method = counts.method;
      draft.payload = { converted: counts.converted, nullsSkipped: counts.nullsSkipped };
    }
    const entry = project.append(draft);
    ds.steps.push(step);
    project.undo.set(entry.seq, {
      check: () => guardDependents(ds, step),
      apply: () => {
        ds.steps = ds.steps.filter((x) => x.id !== step.id);
      },
    });
    project.afterChange(ds, entry.seq);
    return stepResult(ds, step, entry, description, counts);
  };
}

function stepResult(
  ds: StubDataset,
  step: Step,
  entry: AuditEntry,
  description: string,
  counts: Counts | undefined,
): StepResult {
  const result: StepResult = {
    step: structuredClone(step),
    audit: structuredClone(entry),
    description,
    outputRows: outputView(ds).rows.length,
  };
  if (counts !== undefined) Object.assign(result, counts);
  return result;
}

export function removeStep(project: StubProject, ds: StubDataset, stepId: StepId, reason: string): AuditEntry {
  const why = requireReason(reason, 'remove a step');
  const step = ds.steps.find((s) => s.id === stepId);
  if (step === undefined) {
    throw new EngineError(
      'NOT_FOUND',
      `There is no step ${stepId} in dataset ${ds.id}.`,
      'Choose a step from the dataset steps list.',
    );
  }
  guardDependents(ds, step);
  const entry = project.append({
    action: 'step.remove',
    target: { datasetId: ds.id, stepId },
    old: asJson(step),
    reason: why,
  });
  ds.steps = ds.steps.filter((s) => s.id !== stepId);
  // The step.apply entry no longer has an effect to undo.
  project.undo.delete(step.seq);
  project.afterChange(ds, entry.seq);
  return structuredClone(entry);
}
