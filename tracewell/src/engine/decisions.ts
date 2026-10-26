/**
 * Decision validation: every review action is checked here before anything is written. A valid
 * decision becomes one audit draft (bulk actions are one entry, never one per row).
 */
import { cellParser } from '@tw/ingest';
import {
  EngineError,
  MIN_REASON_LENGTH,
  isDateCell,
  isDateTimeCell,
  isGeometryCell,
  type AuditDraft,
  type AuditEntry,
  type BBox,
  type CellValue,
  type Decision,
  type JsonValue,
  type LogicalType,
  type OverridableProperty,
} from '@tw/model';
import { buildOutputView } from '@tw/steps';
import { locator } from '@tw/table';
import { getUnit } from '@tw/units';
import { COLUMN_PROPERTIES, changesRows, withOption } from './reducer';
import type { DatasetState, IssueState, ProjectState } from './state';
import { workingView } from './views';

const REVERTIBLE = new Set([
  'cell.edit',
  'issue.accept',
  'rows.exclude',
  'step.apply',
  'detection.override',
  'project.area',
]);
const LOGICAL_TYPES = new Set<LogicalType>(['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'geometry']);
const ROLES = new Set([
  'measure',
  'id',
  'time',
  'latitude',
  'longitude',
  'easting',
  'northing',
  'geometry',
  'unit',
  'text',
]);

export function reasonLength(text: string): number {
  return text.replace(/\s/g, '').length;
}

export function requireReason(reason: string | undefined): string {
  const text = (reason ?? '').trim();
  if (reasonLength(text) < MIN_REASON_LENGTH) {
    throw new EngineError(
      'REASON_REQUIRED',
      `A reason of at least ${MIN_REASON_LENGTH} characters is required; it is recorded in the audit log.`,
      'Say briefly why, for example "Re-sent value; the field sheet confirms 1205.3".',
    );
  }
  return text;
}

export function datasetOf(state: ProjectState, id: string): DatasetState {
  const ds = state.datasets.get(id);
  if (ds === undefined)
    throw new EngineError('NOT_FOUND', `There is no dataset ${id} in this project.`, 'Choose a listed dataset.', {
      datasetId: id,
    });
  return ds;
}

export function issueOf(state: ProjectState, issueId: string): { ds: DatasetState; st: IssueState } {
  for (const ds of state.datasets.values()) {
    const st = ds.issues.get(issueId);
    if (st !== undefined) return { ds, st };
  }
  throw new EngineError(
    'NOT_FOUND',
    `There is no issue ${issueId}.`,
    'Refresh the issues list and choose a listed issue.',
    { issueId },
  );
}

function fits(v: CellValue, type: LogicalType): boolean {
  if (v === null) return true;
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return isDateCell(v);
    case 'datetime':
      return isDateTimeCell(v);
    case 'geometry':
      return isGeometryCell(v);
  }
}

const EXAMPLES: Record<LogicalType, string> = {
  string: 'any text',
  integer: 'a whole number such as 42',
  number: 'a number such as 1205.3',
  boolean: 'true or false',
  date: 'a date such as 2026-01-31',
  datetime: 'a date and time such as 2026-01-31T06:00:00Z',
  geometry: 'a GeoJSON geometry',
};

function editDraft(state: ProjectState, d: Extract<Decision, { kind: 'edit_cell' }>): AuditDraft {
  const reason = requireReason(d.reason);
  const ds = datasetOf(state, d.datasetId);
  if (!Number.isSafeInteger(d.rowId) || d.rowId < 0 || d.rowId >= ds.dataset.rowCount) {
    throw new EngineError(
      'NOT_FOUND',
      `Dataset ${ds.id} has no row ${d.rowId}.`,
      'Choose a row shown in the data grid.',
      { rowId: d.rowId },
    );
  }
  const plan = ds.spec.columns.find((c) => c.id === d.columnId);
  if (plan === undefined) {
    const derived = workingView(ds).schema.columns.some((c) => c.id === d.columnId);
    throw derived
      ? new EngineError(
          'INVALID_INPUT',
          'A converted column is calculated from its source and cannot be edited.',
          'Edit the value in the source column instead.',
          { columnId: d.columnId },
        )
      : new EngineError('NOT_FOUND', `Dataset ${ds.id} has no column ${d.columnId}.`, 'Choose a listed column.', {
          columnId: d.columnId,
        });
  }
  const type = plan.type.value;
  let value: CellValue;
  if ('text' in d.value) {
    const parsed = cellParser(plan, ds.spec.options)(d.value.text);
    if (!parsed.ok) {
      throw new EngineError(
        'INVALID_INPUT',
        `"${d.value.text}" is not a valid ${type} value for ${plan.name}.`,
        `Enter ${EXAMPLES[type]}.`,
        {
          columnId: plan.id,
        },
      );
    }
    value = parsed.value;
  } else {
    value = d.value.value;
    if (!fits(value, type)) {
      throw new EngineError(
        'INVALID_INPUT',
        `The value does not fit ${plan.name}, which holds ${type} values.`,
        `Enter ${EXAMPLES[type]}.`,
        { columnId: plan.id },
      );
    }
  }
  const view = workingView(ds);
  const old = view.value(d.rowId, d.columnId);
  const previous = ds.overlay.get(d.rowId, d.columnId);
  return {
    action: 'cell.edit',
    target: {
      datasetId: ds.id,
      rowId: d.rowId,
      columnId: d.columnId,
      locator: locator(ds.dataset.schema, ds.dataset.srcLoc(d.rowId), plan),
      ...(d.issueId === undefined ? {} : { issueId: d.issueId }),
    },
    old: old as JsonValue,
    new: value as JsonValue,
    reason,
    payload: { previousEditSeq: previous?.seq ?? null },
  };
}

function openRows(st: IssueState, ds: DatasetState): number[] {
  return st.current.minus(ds.excluded).minus(st.accepted).toArray();
}

function acceptDraft(state: ProjectState, d: Extract<Decision, { kind: 'accept_issue' }>): AuditDraft {
  const reason = requireReason(d.reason);
  const { ds, st } = issueOf(state, d.issueId);
  let rows: number[] | 'all';
  if (st.draft.scope !== 'rows') {
    if (!st.present || st.acceptedWhole)
      throw new EngineError('INVALID_INPUT', 'This issue is not open.', 'Choose an open issue.');
    rows = 'all';
  } else {
    const open = new Set(openRows(st, ds));
    rows = d.rows === 'all' ? [...open] : [...new Set(d.rows)].sort((a, b) => a - b);
    const notOpen = rows.filter((r) => !open.has(r));
    if (notOpen.length > 0) {
      throw new EngineError(
        'INVALID_INPUT',
        `Rows ${notOpen.slice(0, 5).join(', ')} are not open in this issue.`,
        'Choose rows the issue currently flags.',
        { rows: notOpen.slice(0, 20) },
      );
    }
    if (rows.length === 0)
      throw new EngineError(
        'INVALID_INPUT',
        'The issue has no open rows to accept.',
        'Choose an issue with open rows.',
      );
  }
  return { action: 'issue.accept', target: { datasetId: ds.id, issueId: d.issueId }, reason, payload: { rows } };
}

function excludeDraft(state: ProjectState, d: Extract<Decision, { kind: 'exclude_rows' }>): AuditDraft {
  const reason = requireReason(d.reason);
  const ds = datasetOf(state, d.datasetId);
  let rows: number[];
  if (Array.isArray(d.rows)) {
    rows = [...new Set(d.rows)].sort((a, b) => a - b);
    const bad = rows.filter((r) => !Number.isSafeInteger(r) || r < 0 || r >= ds.dataset.rowCount);
    if (bad.length > 0)
      throw new EngineError(
        'NOT_FOUND',
        `Dataset ${ds.id} has no row ${bad[0]}.`,
        'Choose rows shown in the data grid.',
        { rows: bad.slice(0, 20) },
      );
  } else {
    const { ds: owner, st } = issueOf(state, d.rows.issueId);
    if (owner.id !== ds.id)
      throw new EngineError(
        'INVALID_INPUT',
        'The issue belongs to another dataset.',
        'Choose an issue of this dataset.',
      );
    rows = openRows(st, ds);
  }
  rows = rows.filter((r) => !ds.excluded.has(r));
  if (rows.length === 0)
    throw new EngineError(
      'INVALID_INPUT',
      'Every chosen row is already excluded.',
      'Choose rows that are still included.',
    );
  return { action: 'rows.exclude', target: { datasetId: ds.id }, reason, payload: { rows, count: rows.length } };
}

function commentDraft(state: ProjectState, d: Extract<Decision, { kind: 'comment_issue' }>): AuditDraft {
  const { ds } = issueOf(state, d.issueId);
  const text = d.text.trim();
  if (text === '') throw new EngineError('INVALID_INPUT', 'The comment is empty.', 'Type a comment.');
  return { action: 'issue.comment', target: { datasetId: ds.id, issueId: d.issueId }, new: text };
}

export function checkOverrideValue(property: OverridableProperty, value: JsonValue): void {
  const bad = (what: string) =>
    new EngineError('INVALID_INPUT', `${JSON.stringify(value)} is not a valid ${what}.`, `Choose a valid ${what}.`, {
      property,
    });
  switch (property) {
    case 'name':
      if (typeof value !== 'string' || value.trim() === '') throw bad('column name');
      return;
    case 'type':
      if (typeof value !== 'string' || !LOGICAL_TYPES.has(value as LogicalType)) throw bad('column type');
      return;
    case 'unit':
      if (value !== null && (typeof value !== 'string' || getUnit(value) === undefined)) {
        throw new EngineError(
          'UNIT_UNKNOWN',
          `The unit ${JSON.stringify(value)} is not in the unit registry.`,
          'Choose a unit from the list.',
          { unit: value },
        );
      }
      return;
    case 'role':
      if (typeof value !== 'string' || !ROLES.has(value)) throw bad('column role');
      return;
    case 'nullMarkers':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw bad('list of null markers');
      return;
    case 'dateFormat':
      if (!['iso', 'dmy', 'mdy', 'ymd-slash', 'excel-serial'].includes(value as string)) throw bad('date format');
      return;
    case 'timezone':
      if (!['utc', 'offset', 'naive-assumed-utc'].includes(value as string)) throw bad('time zone setting');
      return;
    case 'crs':
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        typeof (value as { code?: unknown }).code !== 'string'
      )
        throw bad('coordinate reference system');
      return;
    default:
      return;
  }
}

function overrideDraft(state: ProjectState, d: Extract<Decision, { kind: 'override_detection' }>): AuditDraft {
  const reason = requireReason(d.reason);
  const ds = datasetOf(state, d.datasetId);
  checkOverrideValue(d.property, d.value);
  let old: JsonValue;
  if (COLUMN_PROPERTIES.has(d.property)) {
    const plan = ds.spec.columns.find((c) => c.id === d.columnId);
    if (plan === undefined)
      throw new EngineError(
        'NOT_FOUND',
        `Dataset ${ds.id} has no column ${String(d.columnId)}.`,
        'Choose a listed column.',
      );
    old = (
      d.property === 'name'
        ? plan.name
        : ((plan as unknown as Record<string, { value: JsonValue } | undefined>)[d.property]?.value ?? null)
    ) as JsonValue;
  } else if (d.property === 'crs') {
    old = (ds.spec.crs?.value ?? null) as JsonValue;
  } else {
    requireNoWork(ds, d.property);
    withOption(ds.spec.options, d.property, d.value);
    old = current(ds, d.property);
  }
  return {
    action: 'detection.override',
    target: { datasetId: ds.id, ...(d.columnId === undefined ? {} : { columnId: d.columnId }) },
    old,
    new: d.value,
    reason,
    payload: { property: d.property },
  };
}

/** True when the dataset has edits, exclusions or steps that a re-read into new rows would lose. */
export function hasWork(ds: DatasetState): boolean {
  return !ds.overlay.entries().next().done || ds.excluded.size > 0 || ds.steps.length > 0;
}

function requireNoWork(ds: DatasetState, property: OverridableProperty): void {
  if (!hasWork(ds)) return;
  throw new EngineError(
    'INVALID_INPUT',
    `Changing the ${property} reads the file into different rows, and this dataset already has edits, exclusions or steps.`,
    'Import the file again as a new dataset with this setting, so the existing work is kept.',
    { property },
  );
}

/** Refuses a step list that no longer builds, such as a filter on a column a removed step created. */
export function requireStepsBuild(ds: DatasetState, steps: DatasetState['steps'], what: string): void {
  try {
    buildOutputView(ds.dataset, { overlay: ds.overlay, excluded: ds.excluded, steps });
  } catch (e) {
    const later = steps.find((s) => {
      try {
        buildOutputView(ds.dataset, {
          overlay: ds.overlay,
          excluded: ds.excluded,
          steps: steps.slice(0, steps.indexOf(s) + 1),
        });
        return false;
      } catch {
        return true;
      }
    });
    throw new EngineError(
      'INVALID_INPUT',
      `${what} would break step ${later?.id ?? 'a later step'}, which uses a column it creates.`,
      `Remove step ${later?.id ?? 'the later step'} first.`,
      { step: later?.id ?? null, cause: e instanceof Error ? e.message : String(e) },
    );
  }
}

function current(ds: DatasetState, property: OverridableProperty): JsonValue {
  const o = ds.spec.options;
  if (o.format === 'csv' || o.format === 'tsv')
    return (o.csv as unknown as Record<string, JsonValue>)[property] ?? null;
  if (o.format === 'xlsx') return (o.xlsx as unknown as Record<string, JsonValue>)[property] ?? null;
  return null;
}

function areaDraft(state: ProjectState, d: Extract<Decision, { kind: 'set_project_area' }>): AuditDraft {
  const reason = requireReason(d.reason);
  const b = d.bbox;
  if (b !== null) {
    const [w, s, e, n] = b as BBox;
    const valid =
      [w, s, e, n].every(Number.isFinite) && Math.abs(w) <= 180 && Math.abs(e) <= 180 && s >= -90 && n <= 90 && s <= n;
    if (!valid)
      throw new EngineError(
        'INVALID_INPUT',
        'The project area is not a valid longitude/latitude box.',
        'Enter west, south, east and north in degrees (south ≤ north).',
      );
  }
  return { action: 'project.area', target: {}, old: state.projectArea, new: b, reason };
}

function revertDraft(state: ProjectState, d: Extract<Decision, { kind: 'revert' }>): AuditDraft {
  const reason = requireReason(d.reason);
  const target = state.log.get(d.seq);
  if (target === undefined)
    throw new EngineError('NOT_FOUND', `There is no audit entry ${d.seq}.`, 'Choose an entry from the log.');
  if (!REVERTIBLE.has(target.action)) {
    throw new EngineError(
      'INVALID_INPUT',
      `A ${target.action} entry cannot be reverted.`,
      'Revert an edit, acceptance, exclusion, step, override or project-area change.',
      { seq: d.seq },
    );
  }
  if (state.reverted.has(d.seq))
    throw new EngineError('INVALID_INPUT', `Entry ${d.seq} is already reverted.`, 'Choose another entry.');
  requireRevertible(state, target);
  return {
    action: 'entry.revert',
    target: { seq: d.seq, ...(target.target.datasetId === undefined ? {} : { datasetId: target.target.datasetId }) },
    reason,
  };
}

/** Refuses a revert that would undo more than its own entry, or that no longer has anything to undo. */
function requireRevertible(state: ProjectState, target: AuditEntry): void {
  const ds = target.target.datasetId === undefined ? undefined : state.datasets.get(target.target.datasetId);
  if (target.action === 'project.area') return;
  if (ds === undefined)
    throw new EngineError(
      'NOT_FOUND',
      `The dataset of entry ${target.seq} is no longer in the project.`,
      'Choose another entry.',
    );
  switch (target.action) {
    case 'cell.edit': {
      const edit = ds.overlay.get(target.target.rowId as number, target.target.columnId as string);
      if (edit?.seq !== target.seq) {
        throw new EngineError(
          'INVALID_INPUT',
          `A later change (entry ${edit?.seq ?? 'unknown'}) replaced the value entry ${target.seq} wrote.`,
          'Revert the later change first, or edit the cell again.',
          { seq: target.seq, current: edit?.seq ?? null },
        );
      }
      return;
    }
    case 'step.apply': {
      if (!ds.steps.some((s) => s.id === target.target.stepId)) {
        throw new EngineError(
          'INVALID_INPUT',
          `Step ${String(target.target.stepId)} has already been removed.`,
          'Choose another entry.',
        );
      }
      requireStepsBuild(
        ds,
        ds.steps.filter((s) => s.id !== target.target.stepId),
        `Reverting step ${String(target.target.stepId)}`,
      );
      return;
    }
    case 'detection.override': {
      const { property } = target.payload as { property: OverridableProperty };
      if (changesRows(property)) requireNoWork(ds, property);
      return;
    }
    default:
      return;
  }
}

export function decisionDraft(state: ProjectState, d: Decision): AuditDraft {
  switch (d.kind) {
    case 'edit_cell':
      return editDraft(state, d);
    case 'accept_issue':
      return acceptDraft(state, d);
    case 'exclude_rows':
      return excludeDraft(state, d);
    case 'comment_issue':
      return commentDraft(state, d);
    case 'override_detection':
      return overrideDraft(state, d);
    case 'set_project_area':
      return areaDraft(state, d);
    case 'revert':
      return revertDraft(state, d);
  }
}
