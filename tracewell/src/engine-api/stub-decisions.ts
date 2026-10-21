/**
 * The stub's review decisions. Each is validated first, then appended to the audit log, then
 * applied, the order the real engine uses (SAD section 8.1), so a refused decision leaves no entry.
 */
import {
  canonicalCell,
  EngineError,
  MIN_REASON_LENGTH,
  schemas,
  type AuditAction,
  type AuditEntry,
  type AuditTarget,
  type CellInput,
  type CellValue,
  type ColumnSchema,
  type DatasetId,
  type Decision,
  type RowId,
} from '@tw/model';
import type { EngineEvent } from './protocol';
import { sourceLine } from './stub-data';
import { openRows } from './stub-issues';
import { planOverride } from './stub-overrides';
import { asJson, type StubProject } from './stub-project';
import { cellKey, currentValue, fitsType, parseText, rootColumn, type StubDataset } from './stub-view';

export type ProjectChange = Extract<EngineEvent, { type: 'project.changed' }>['what'][number];

/** What a decision did, so the engine can announce it. */
export interface Applied {
  entries: AuditEntry[];
  changed: ProjectChange[];
  datasetId?: DatasetId;
}

type DecisionOf<K extends Decision['kind']> = Extract<Decision, { kind: K }>;

const REVERTIBLE: ReadonlySet<AuditAction> = new Set([
  'cell.edit',
  'issue.accept',
  'rows.exclude',
  'step.apply',
  'detection.override',
  'project.area',
]);

const MAX_COMMENT_LENGTH = 5000;

function invalid(message: string, fix: string): EngineError {
  return new EngineError('INVALID_INPUT', message, fix);
}

/**
 * Returns the trimmed reason, or throws REASON_REQUIRED (SAD section 9.2). Characters are counted
 * as code points, and invisible format characters such as a zero-width space count as space, so
 * a reason nobody can read never passes.
 */
export function requireReason(reason: string, action: string): string {
  if ([...reason.replace(/[\s\p{Cf}]/gu, '')].length < MIN_REASON_LENGTH) {
    throw new EngineError(
      'REASON_REQUIRED',
      `A reason is required to ${action}.`,
      `Write why you are making this change, in at least ${MIN_REASON_LENGTH} characters.`,
    );
  }
  return reason.trim();
}

/** Checks the shape of a decision received over the protocol. */
function parseDecision(d: unknown): Decision {
  const parsed = schemas.decision.safeParse(d);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const where = first === undefined || first.path.length === 0 ? '' : ` (at ${first.path.join('.')})`;
  throw invalid(
    `The decision is not valid${where}: ${first?.message ?? 'unknown problem'}.`,
    'Send a decision in the form the engine protocol defines.',
  );
}

export function decide(project: StubProject, input: unknown): Applied {
  project.assertWritable();
  const d = parseDecision(input);
  switch (d.kind) {
    case 'edit_cell':
      return editCell(project, d);
    case 'accept_issue':
      return acceptIssue(project, d);
    case 'exclude_rows':
      return excludeRows(project, d);
    case 'comment_issue':
      return commentIssue(project, d);
    case 'override_detection':
      return overrideDetection(project, d);
    case 'set_project_area':
      return setProjectArea(project, d);
    case 'revert':
      return revert(project, d);
  }
}

function sameCell(a: CellValue, b: CellValue): boolean {
  return canonicalCell(a) === canonicalCell(b);
}

function editableColumn(ds: StubDataset, columnId: string): ColumnSchema {
  const column = ds.columns.find((c) => c.id === columnId);
  if (column !== undefined) return column;
  if (columnId.includes('~')) {
    throw invalid(
      `The column ${columnId} is computed by a step, so its cells cannot be edited.`,
      `Edit the source column ${rootColumn(columnId)}; the step recomputes this column.`,
    );
  }
  throw new EngineError(
    'NOT_FOUND',
    `There is no column ${columnId} in dataset ${ds.id}.`,
    'Choose a column shown in the grid.',
  );
}

function editCell(project: StubProject, d: DecisionOf<'edit_cell'>): Applied {
  const ds = project.dataset(d.datasetId);
  project.checkRow(d.rowId);
  const column = editableColumn(ds, d.columnId);
  if (ds.excluded.has(d.rowId)) {
    throw invalid(`Row ${d.rowId} is excluded.`, 'Revert the exclusion first if the row should be kept and corrected.');
  }
  if (d.issueId !== undefined && project.issue(d.issueId).datasetId !== ds.id) {
    throw invalid(`Issue ${d.issueId} belongs to another dataset.`, 'Choose an issue of this dataset.');
  }
  const reason = requireReason(d.reason, 'edit a cell');
  const value = cellFromInput(column, d.value);
  const old = currentValue(ds, column, d.rowId);
  if (sameCell(old, value)) throw invalid('The cell already holds this value.', 'Enter a different value.');

  const target: AuditTarget = {
    datasetId: ds.id,
    rowId: d.rowId,
    columnId: column.id,
    locator: `line ${sourceLine(d.rowId)}, field ${column.sourceIndex + 1}`,
  };
  if (d.issueId !== undefined) target.issueId = d.issueId;
  const entry = project.append({ action: 'cell.edit', target, old: asJson(old), new: asJson(value), reason });

  const key = cellKey(d.rowId, column.id);
  const hadEdit = ds.edits.has(key);
  const previous = ds.edits.get(key) ?? null;
  ds.edits.set(key, value);
  project.undo.set(entry.seq, {
    // Undo restores the value before this edit, so it is safe only while no later edit of the cell
    // is in effect; comparing values would let a later edit back to the same value be discarded.
    check: () => {
      if (laterEditInEffect(project, target, entry.seq)) {
        throw invalid(
          `A later edit changed this cell after entry ${entry.seq}.`,
          'Revert the later edit first, then this one.',
        );
      }
    },
    apply: () => {
      if (hadEdit) ds.edits.set(key, previous);
      else ds.edits.delete(key);
    },
  });
  project.afterChange(ds, entry.seq);
  return { entries: [entry], changed: ['datasets', 'issues', 'audit'], datasetId: ds.id };
}

/** Whether a cell.edit after `seq` of the same cell has not been reverted. */
function laterEditInEffect(project: StubProject, cell: AuditTarget, seq: number): boolean {
  return project.audit.some(
    (e) =>
      e.seq > seq &&
      e.action === 'cell.edit' &&
      e.target.datasetId === cell.datasetId &&
      e.target.rowId === cell.rowId &&
      e.target.columnId === cell.columnId &&
      project.undo.has(e.seq),
  );
}

const TYPE_HINTS: Record<string, string> = {
  number: 'Type a number with a decimal point, such as 151.2.',
  integer: 'Type a whole number, such as 42.',
  boolean: 'Type true or false.',
  date: 'Type a date as YYYY-MM-DD, such as 2026-01-31.',
  datetime: 'Type a UTC date-time as YYYY-MM-DDTHH:mm:ss.sssZ.',
};

/** Text is parsed as the import would; a typed value must already fit the column type. */
function cellFromInput(column: ColumnSchema, input: CellInput): CellValue {
  const type = column.type.value;
  if ('text' in input) {
    const text = input.text.trim();
    const value = parseText(type === 'string' ? input.text : text, column);
    if (value === null && text !== '' && !column.nullMarkers.value.includes(text)) {
      throw invalid(
        `"${input.text}" is not a valid ${type} for ${column.name}.`,
        TYPE_HINTS[type] ?? 'Enter a value of the column type.',
      );
    }
    return value;
  }
  if (!fitsType(input.value, type)) {
    throw invalid(
      `The value does not fit the ${type} column ${column.name}.`,
      TYPE_HINTS[type] ?? 'Enter a value of the column type.',
    );
  }
  return input.value;
}

function uniqueSorted(rows: RowId[]): RowId[] {
  return [...new Set(rows)].sort((a, b) => a - b);
}

function acceptIssue(project: StubProject, d: DecisionOf<'accept_issue'>): Applied {
  const issue = project.issue(d.issueId);
  const reason = requireReason(d.reason, 'accept an issue');
  const open = openRows(issue);
  const rows = d.rows === 'all' ? open : uniqueSorted(d.rows);
  if (rows.length === 0)
    throw invalid(`Issue ${issue.id} has no open rows to accept.`, 'Choose an issue that is still open.');
  const openSet = new Set(open);
  const notOpen = rows.filter((r) => !openSet.has(r));
  if (notOpen.length > 0) {
    throw invalid(
      `Rows ${notOpen.join(', ')} are not open in issue ${issue.id}.`,
      'Accept only rows listed as open for the issue.',
    );
  }
  const entry = project.append({
    action: 'issue.accept',
    target: { datasetId: issue.datasetId, issueId: issue.id },
    new: { rows },
    reason,
    rule: { id: issue.rule.id, version: issue.rule.version },
  });
  for (const r of rows) issue.accepted.set(r, entry.seq);
  project.undo.set(entry.seq, {
    check: () => undefined,
    apply: () => {
      for (const r of rows) if (issue.accepted.get(r) === entry.seq) issue.accepted.delete(r);
    },
  });
  return { entries: [entry], changed: ['issues', 'audit'], datasetId: issue.datasetId };
}

function excludeRows(project: StubProject, d: DecisionOf<'exclude_rows'>): Applied {
  const ds = project.dataset(d.datasetId);
  const reason = requireReason(d.reason, 'exclude rows');
  const target: AuditTarget = { datasetId: ds.id };
  let rows: RowId[];
  if (Array.isArray(d.rows)) {
    rows = uniqueSorted(d.rows);
    for (const r of rows) project.checkRow(r);
  } else {
    const issue = project.issue(d.rows.issueId);
    if (issue.datasetId !== ds.id)
      throw invalid(`Issue ${issue.id} belongs to another dataset.`, 'Choose an issue of this dataset.');
    rows = openRows(issue);
    target.issueId = issue.id;
    if (rows.length === 0) {
      throw invalid(
        `Issue ${issue.id} has no open rows to exclude.`,
        'Choose an issue that still has open rows, or choose the rows themselves.',
      );
    }
  }
  const fresh = rows.filter((r) => !ds.excluded.has(r));
  if (fresh.length === 0)
    throw invalid('Every chosen row is already excluded.', 'Choose rows that are still in the dataset.');

  const entry = project.append({
    action: 'rows.exclude',
    target,
    new: { rows: fresh },
    reason,
    payload: { count: fresh.length },
  });
  for (const r of fresh) ds.excluded.set(r, entry.seq);
  project.undo.set(entry.seq, {
    check: () => undefined,
    apply: () => {
      for (const r of fresh) if (ds.excluded.get(r) === entry.seq) ds.excluded.delete(r);
    },
  });
  project.afterChange(ds, entry.seq);
  return { entries: [entry], changed: ['datasets', 'issues', 'audit'], datasetId: ds.id };
}

function commentIssue(project: StubProject, d: DecisionOf<'comment_issue'>): Applied {
  const issue = project.issue(d.issueId);
  const text = d.text.trim();
  if (text === '' || text.length > MAX_COMMENT_LENGTH) {
    throw invalid(`A comment needs 1 to ${MAX_COMMENT_LENGTH} characters of text.`, 'Type the comment, then add it.');
  }
  const entry = project.append({
    action: 'issue.comment',
    target: { datasetId: issue.datasetId, issueId: issue.id },
    new: { text },
  });
  issue.comments.push({ seq: entry.seq, at: entry.at, by: project.profile.name, text });
  return { entries: [entry], changed: ['issues', 'audit'], datasetId: issue.datasetId };
}

function overrideDetection(project: StubProject, d: DecisionOf<'override_detection'>): Applied {
  const ds = project.dataset(d.datasetId);
  const reason = requireReason(d.reason, 'override a detection');
  const plan = planOverride(ds, d.columnId, d.property, d.value);
  const target: AuditTarget = { datasetId: ds.id };
  if (plan.columnId !== undefined) target.columnId = plan.columnId;
  const entry = project.append({
    action: 'detection.override',
    target,
    old: plan.old,
    new: plan.value,
    reason,
    payload: { property: plan.property },
  });
  project.undo.set(entry.seq, plan.apply(entry.seq));
  project.afterChange(ds, entry.seq);
  return { entries: [entry], changed: ['schema', 'datasets', 'issues', 'audit'], datasetId: ds.id };
}

function setProjectArea(project: StubProject, d: DecisionOf<'set_project_area'>): Applied {
  const reason = requireReason(d.reason, 'change the project area');
  const old = project.area;
  const next = d.bbox === null ? null : d.bbox;
  if (JSON.stringify(old) === JSON.stringify(next)) {
    throw invalid('The project area is already set to this box.', 'Draw or type a different box.');
  }
  const entry = project.append({ action: 'project.area', target: {}, old: asJson(old), new: asJson(next), reason });
  project.area = next;
  project.undo.set(entry.seq, {
    check: () => {
      if (JSON.stringify(project.area) !== JSON.stringify(next)) {
        throw invalid(
          `A later change replaced the project area set in entry ${entry.seq}.`,
          'Revert the later change first.',
        );
      }
    },
    apply: () => {
      project.area = old;
    },
  });
  return { entries: [entry], changed: ['project', 'issues', 'audit'] };
}

function revert(project: StubProject, d: DecisionOf<'revert'>): Applied {
  const reason = requireReason(d.reason, 'revert a change');
  const reverted = project.entry(d.seq);
  if (!REVERTIBLE.has(reverted.action)) {
    throw invalid(
      `Entry ${d.seq} (${reverted.action}) cannot be reverted.`,
      'Only edits, accepts, exclusions, steps, detection overrides and project-area changes can be reverted.',
    );
  }
  const undo = project.undo.get(d.seq);
  if (undo === undefined) {
    throw invalid(`Entry ${d.seq} has already been undone.`, 'Choose an entry whose change is still in effect.');
  }
  undo.check();
  const datasetId = reverted.target.datasetId;
  const target: AuditTarget = { seq: d.seq };
  if (datasetId !== undefined) target.datasetId = datasetId;
  const entry = project.append({ action: 'entry.revert', target, reason, payload: { action: reverted.action } });
  project.undo.delete(d.seq);
  undo.apply();
  if (datasetId === undefined) return { entries: [entry], changed: ['project', 'issues', 'audit'] };
  project.afterChange(project.dataset(datasetId), entry.seq);
  return { entries: [entry], changed: ['datasets', 'schema', 'steps', 'issues', 'audit'], datasetId };
}
