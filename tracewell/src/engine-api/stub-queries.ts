/** The stub's read-only answers: row windows, lineage, the issue register, the audit log and units. */
import {
  detection,
  EngineError,
  ROW_WINDOW_MAX,
  type AuditEntry,
  type AuditQuery,
  type CellLineage,
  type ColumnId,
  type ColumnSchema,
  type DatasetId,
  type ImportPreview,
  type Issue,
  type IssueOccurrence,
  type IssueQuery,
  type Page,
  type PageRequest,
  type QuantityKind,
  type RowId,
  type RowWindow,
  type RowWindowRequest,
  type Severity,
  type Step,
  type UnitInfo,
} from '@tw/model';
import {
  ENCODING_ASSUMPTION,
  findUnit,
  SOURCE_CSV_OPTIONS,
  SOURCE_FILE,
  SOURCE_HEADER,
  SOURCE_ROWS,
  sourceLine,
  STUB_UNITS,
} from './stub-data';
import { occurrences, openRows, SEVERITY_ORDER, toIssue, type StubIssue } from './stub-issues';
import { actorName, type StubProject } from './stub-project';
import { findColumn, parseText, rootColumn, viewOf, workingView, type StubDataset, type ViewColumn } from './stub-view';

const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;

function invalid(message: string, fix: string): EngineError {
  return new EngineError('INVALID_INPUT', message, fix);
}

function requireCount(v: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) {
    throw invalid(`${name} must be a whole number from 0 to ${max}; it was ${String(v)}.`, `Pass a valid ${name}.`);
  }
  return v;
}

/** Validated paging with the protocol's defaults. */
function window(offset: number | undefined, limit: number | undefined): { offset: number; limit: number } {
  return { offset: requireCount(offset ?? 0, 'offset'), limit: requireCount(limit ?? DEFAULT_PAGE, 'limit', MAX_PAGE) };
}

function page<T>(items: T[], offset: number, limit: number): Page<T> {
  return { items: items.slice(offset, offset + limit), total: items.length, offset };
}

function isAssumed(c: ColumnSchema): boolean {
  return c.type.assumed || c.role.assumed || c.unit.assumed || c.nullMarkers.assumed;
}

/** Worst open severity per row and source column: the cell markers of the grid. */
function cellSeverities(issues: StubIssue[]): Map<string, Severity> {
  const worst = new Map<string, Severity>();
  for (const issue of issues) {
    for (const rowId of openRows(issue)) {
      for (const column of issue.columns) {
        const key = `${rowId}:${column}`;
        const current = worst.get(key);
        if (current === undefined || SEVERITY_ORDER[issue.rule.severity] < SEVERITY_ORDER[current])
          worst.set(key, issue.rule.severity);
      }
    }
  }
  return worst;
}

function windowColumns(all: ViewColumn[], wanted: ColumnId[] | undefined): ViewColumn[] {
  if (wanted === undefined) return all;
  return wanted.map((id) => findColumn({ columns: all, rows: [] }, id));
}

export function rowWindow(project: StubProject, q: RowWindowRequest): RowWindow {
  const ds = project.dataset(q.datasetId);
  const offset = requireCount(q.offset, 'offset');
  const limit = requireCount(q.limit, 'limit', ROW_WINDOW_MAX);
  const view = viewOf(ds, q.stage);
  const columns = windowColumns(view.columns, q.columns);
  const worst = cellSeverities(project.issuesOf(ds.id));
  return {
    datasetId: ds.id,
    stage: q.stage,
    offset,
    totalRows: view.rows.length,
    columns: columns.map((c) => ({
      id: c.schema.id,
      name: c.schema.name,
      unit: c.schema.unit.value,
      type: c.schema.type.value,
      assumed: isAssumed(c.schema),
      derived: c.derived,
    })),
    rows: view.rows.slice(offset, offset + limit).map((rowId) => ({
      rowId,
      locator: `line ${sourceLine(rowId)}`,
      cells: columns.map((c) => structuredClone(c.value(rowId))),
      edited: columns.map((c) => c.edited(rowId)),
      issue: columns.map((c) => worst.get(`${rowId}:${rootColumn(c.schema.id)}`) ?? null),
    })),
  };
}

function parseMethod(c: ColumnSchema): string {
  switch (c.type.value) {
    case 'number':
    case 'integer':
      return `${c.type.value}, decimal separator '${c.decimalSeparator?.value ?? '.'}'`;
    case 'date':
      return `date, ${c.dateFormat?.value ?? 'iso'} format`;
    case 'datetime':
      return `datetime, ${c.timezone?.value ?? 'naive-assumed-utc'}`;
    case 'boolean':
      return 'boolean, true/false';
    default:
      return 'text as written';
  }
}

/** Steps that converted the cell's column, by step ID. */
function conversionsOf(ds: StubDataset, root: ColumnId): Set<string> {
  return new Set(
    ds.steps
      .filter((s): s is Step & { kind: 'convert_unit' } => s.kind === 'convert_unit' && rootColumn(s.columnId) === root)
      .map((s) => s.id),
  );
}

/** Entries that changed the cell, its column or its row, plus the reverts of those entries. */
function touchesCell(e: AuditEntry, ds: StubDataset, rowId: RowId, root: ColumnId, steps: Set<string>): boolean {
  const t = e.target;
  if (t.datasetId !== ds.id) return false;
  switch (e.action) {
    case 'cell.edit':
      return t.rowId === rowId && t.columnId === root;
    case 'detection.override':
      return t.columnId === root;
    case 'step.apply':
    case 'step.remove':
      return (
        (t.columnId !== undefined && rootColumn(t.columnId) === root) || (t.stepId !== undefined && steps.has(t.stepId))
      );
    case 'rows.exclude': {
      const rows = (e.new as { rows?: unknown } | undefined)?.rows;
      return Array.isArray(rows) && rows.includes(rowId);
    }
    default:
      return false;
  }
}

function history(project: StubProject, ds: StubDataset, rowId: RowId, root: ColumnId): CellLineage['history'] {
  const steps = conversionsOf(ds, root);
  const touched = new Set<number>();
  const items: CellLineage['history'] = [];
  for (const e of project.audit) {
    const isRevert = e.action === 'entry.revert' && e.target.seq !== undefined && touched.has(e.target.seq);
    if (!isRevert && !touchesCell(e, ds, rowId, root, steps)) continue;
    touched.add(e.seq);
    const item: CellLineage['history'][number] = {
      seq: e.seq,
      at: e.at,
      actor: actorName(e.actor),
      action: e.action,
      old: structuredClone(e.old),
      new: structuredClone(e.new),
      reason: e.reason,
    };
    if (e.method !== undefined) item.method = { ...e.method };
    items.push(item);
  }
  return items;
}

export function lineage(project: StubProject, datasetId: DatasetId, rowId: RowId, columnId: ColumnId): CellLineage {
  const ds = project.dataset(datasetId);
  project.checkRow(rowId);
  const column = findColumn(workingView(ds), columnId);
  const root = rootColumn(columnId);
  const source = ds.columns.find((c) => c.id === root) ?? column.schema;
  const raw = column.raw(rowId);
  const marker = raw !== null && source.nullMarkers.value.includes(raw) ? raw : null;
  const parsedOk = raw === null || raw === '' || marker !== null || parseText(raw, source) !== null;
  return {
    datasetId: ds.id,
    rowId,
    columnId,
    source: {
      fileId: SOURCE_FILE.fileId,
      fileName: SOURCE_FILE.name,
      locator: `line ${sourceLine(rowId)}, field ${source.sourceIndex + 1}`,
      rawText: raw,
    },
    parse: { type: source.type.value, method: parseMethod(source), nullMarker: marker, ok: parsedOk },
    history: history(project, ds, rowId, root),
    current: structuredClone(column.value(rowId)),
  };
}

function matchesQuery(issue: Issue, q: IssueQuery, names: string): boolean {
  if (q.severity !== undefined && !q.severity.includes(issue.severity)) return false;
  if (q.status !== undefined && !q.status.includes(issue.status)) return false;
  if (q.ruleId !== undefined && issue.ruleId !== q.ruleId) return false;
  if (q.columnId !== undefined && !issue.columns.includes(rootColumn(q.columnId))) return false;
  if (q.text === undefined || q.text.trim() === '') return true;
  const text = q.text.trim().toLowerCase();
  return [issue.title, issue.message, issue.ruleId, names].some((s) => s.toLowerCase().includes(text));
}

type IssueRow = { issue: Issue; names: string };

/** Code-unit order: the same on every machine, unlike a locale-aware comparison. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const ORDERS: Record<NonNullable<IssueQuery['sort']>, (a: IssueRow, b: IssueRow) => number> = {
  severity: (a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity],
  rule: (a, b) => byText(a.issue.ruleId, b.issue.ruleId),
  count: (a, b) => b.issue.counts.open - a.issue.counts.open,
  column: (a, b) => byText(a.names, b.names),
};

/** Ties fall back to severity, rule and ID, so every sort is a total order. */
function compareIssues(sort: NonNullable<IssueQuery['sort']>): (a: IssueRow, b: IssueRow) => number {
  return (a, b) => ORDERS[sort](a, b) || ORDERS.severity(a, b) || ORDERS.rule(a, b) || byText(a.issue.id, b.issue.id);
}

/** The requested order; checked as an own key, so a name every object inherits is not mistaken for one. */
function issueOrder(sort: IssueQuery['sort']): NonNullable<IssueQuery['sort']> {
  if (sort === undefined) return 'severity';
  if (Object.hasOwn(ORDERS, sort)) return sort;
  throw invalid(
    `The issue sort ${JSON.stringify(sort)} does not exist.`,
    `Sort by one of: ${Object.keys(ORDERS).join(', ')}.`,
  );
}

export function listIssues(project: StubProject, q: IssueQuery): Page<Issue> {
  const { offset, limit } = window(q.offset, q.limit);
  const order = compareIssues(issueOrder(q.sort));
  if (q.datasetId !== undefined) project.dataset(q.datasetId);
  const rows: IssueRow[] = [];
  for (const stub of project.issues.values()) {
    if (q.datasetId !== undefined && stub.datasetId !== q.datasetId) continue;
    const ds = project.dataset(stub.datasetId);
    const name = (id: ColumnId): string => project.columnName(ds, id);
    const issue = toIssue(stub, ds, name);
    const names = issue.columns.map(name).join(', ');
    if (matchesQuery(issue, q, names)) rows.push({ issue, names });
  }
  rows.sort(order);
  return page(
    rows.map((r) => r.issue),
    offset,
    limit,
  );
}

export function listOccurrences(project: StubProject, issueId: string, p: PageRequest): Page<IssueOccurrence> {
  const { offset, limit } = window(p.offset, p.limit);
  const issue = project.issue(issueId);
  const ds = project.dataset(issue.datasetId);
  const root = issue.columns[0];
  const columns = workingView(ds).columns;
  // The source column when it is still in the view; after a replacing conversion, its converted column.
  const column =
    columns.find((c) => c.schema.id === root) ??
    columns.find((c) => root !== undefined && rootColumn(c.schema.id) === root);
  return page(occurrences(issue, ds, column), offset, limit);
}

function auditMatches(e: AuditEntry, q: AuditQuery): boolean {
  const t = e.target;
  if (q.datasetId !== undefined && t.datasetId !== q.datasetId) return false;
  if (q.action !== undefined && !q.action.includes(e.action)) return false;
  if (q.rowId !== undefined && t.rowId !== q.rowId) return false;
  if (q.columnId !== undefined && (t.columnId === undefined || rootColumn(t.columnId) !== rootColumn(q.columnId)))
    return false;
  return q.fromSeq === undefined || e.seq >= q.fromSeq;
}

export function listAudit(project: StubProject, q: AuditQuery): Page<AuditEntry> {
  const { offset, limit } = window(q.offset, q.limit);
  const matching = project.audit.filter((e) => auditMatches(e, q));
  if (q.order === 'desc') matching.reverse();
  return page(
    matching.map((e) => structuredClone(e)),
    offset,
    limit,
  );
}

/** Units of a quantity, or the units a code converts to without crossing a convention. */
export function listUnits(q: { quantity?: QuantityKind; compatibleWith?: string } | undefined): UnitInfo[] {
  let units = [...STUB_UNITS];
  if (q?.quantity !== undefined) units = units.filter((u) => u.quantity === q.quantity);
  if (q?.compatibleWith !== undefined) {
    const base = findUnit(q.compatibleWith);
    if (base === undefined) {
      throw new EngineError(
        'UNIT_UNKNOWN',
        `The unit '${q.compatibleWith}' is not in the unit registry.`,
        'Choose a unit from the list.',
      );
    }
    units = units.filter((u) => u.quantity === base.quantity && u.convention === base.convention);
  }
  return units.map(({ code, label, quantity, convention }) => ({ code, label, quantity, convention }));
}

/** The preview of the canned file, under the name of whatever file was given. */
export function importPreview(project: StubProject, fileName: string, previewId: string): ImportPreview {
  const draft = project.draftDataset(fileName);
  const { evidence, confidence } = ENCODING_ASSUMPTION;
  return {
    previewId,
    fileName,
    size: SOURCE_FILE.size,
    sniff: {
      format: 'csv',
      options: { format: 'csv', csv: { ...SOURCE_CSV_OPTIONS } },
      detections: {
        encoding: detection('utf-8', confidence, 'utf8-validity', evidence),
        delimiter: detection(',', 'high', 'delimiter-consistency', 'Every line has the same number of commas.'),
        headerRows: detection(1, 'high', 'header-text', 'The first line is text above rows of numbers.'),
        decimalSeparator: detection(
          '.',
          'high',
          'decimal-scan',
          'Numbers use decimal points and no thousands separators.',
        ),
      },
      header: [[...SOURCE_HEADER]],
      sampleRows: SOURCE_ROWS.map((fields, i) => ({ srcLoc: sourceLine(i), fields: [...fields] })),
      notes: [],
    },
    columns: draft.columns,
    rows: SOURCE_ROWS.map((fields) => draft.columns.map((c) => parseText(fields[c.sourceIndex] ?? '', c))),
    crs: null,
    assumptions: project.assumptions(draft),
    estimatedRows: SOURCE_ROWS.length,
    exceedsBudget: false,
  };
}
