/** The issues register as the UI reads it: filtered, sorted and paged issues, and their occurrences. */
import { findRule, issueId } from '@tw/rules';
import {
  EngineError,
  type ColumnId,
  type DatasetHealth,
  type DatasetId,
  type Issue,
  type IssueDraft,
  type IssueOccurrence,
  type IssueQuery,
  type Page,
  type PageRequest,
  type QuantityKind,
  type RuleCategory,
  type UnitInfo,
} from '@tw/model';
import { locator, RowSet } from '@tw/table';
import { allUnits, compatibleUnits, getUnit, unitInfo } from '@tw/units';
import { datasetOf } from './decisions';
import { issueCounts, occurrenceState, severityRank, toIssue } from './issues-state';
import { CHECK_PACKS } from './reducer';
import type { DatasetState, IssueState, ProjectState } from './state';
import { workingView } from './views';
import { invalid, requireCount, rootColumn } from './windows';

const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;

function paging(offset: unknown, limit: unknown): { offset: number; limit: number } {
  return { offset: requireCount(offset ?? 0, 'offset'), limit: requireCount(limit ?? DEFAULT_PAGE, 'limit', MAX_PAGE) };
}

function page<T>(items: T[], offset: number, limit: number): Page<T> {
  return { items: items.slice(offset, offset + limit), total: items.length, offset };
}

/** A finding about the project file: open until the project is opened from an intact file. */
function systemToIssue(d: IssueDraft, seq: number): Issue {
  const rule = findRule(CHECK_PACKS, d.ruleId)?.rule;
  return {
    id: issueId(d),
    ruleId: d.ruleId,
    ruleVersion: d.ruleVersion,
    packId: d.packId,
    severity: d.severity,
    category: d.category,
    datasetId: d.datasetId,
    columns: [...d.columns],
    scope: d.scope,
    title: rule?.title ?? d.ruleId,
    message: d.message,
    explanation: rule?.explanation ?? '',
    source: rule?.source ?? '',
    status: 'open',
    counts: { flagged: 1, open: 1, accepted: 0, excluded: 0, fixed: 0 },
    openRows: { count: 0, ranges: [] },
    comments: [],
    firstSeenSeq: seq,
    lastCheckedSeq: seq,
  };
}

type Row = { issue: Issue; names: string };

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const ORDERS: Record<NonNullable<IssueQuery['sort']>, (a: Row, b: Row) => number> = {
  severity: (a, b) => severityRank(b.issue.severity) - severityRank(a.issue.severity),
  rule: (a, b) => byText(a.issue.ruleId, b.issue.ruleId),
  count: (a, b) => b.issue.counts.open - a.issue.counts.open,
  column: (a, b) => byText(a.names, b.names),
};

function issueOrder(sort: IssueQuery['sort']): (a: Row, b: Row) => number {
  const key = sort ?? 'severity';
  if (!Object.hasOwn(ORDERS, key)) {
    throw invalid(
      `The issue sort ${JSON.stringify(sort)} does not exist.`,
      `Sort by one of: ${Object.keys(ORDERS).join(', ')}.`,
    );
  }
  // Ties fall back to severity, rule and ID, so every sort is a total order.
  return (a, b) => ORDERS[key](a, b) || ORDERS.severity(a, b) || ORDERS.rule(a, b) || byText(a.issue.id, b.issue.id);
}

function columnNames(ds: DatasetState | undefined): (id: ColumnId) => string {
  if (ds === undefined) return (id) => id;
  const view = workingView(ds);
  return (id) => {
    try {
      return view.columnSchema(id).name;
    } catch {
      return id;
    }
  };
}

function matches(issue: Issue, q: IssueQuery, names: string, root: (c: ColumnId) => ColumnId): boolean {
  if (q.severity !== undefined && q.severity.length > 0 && !q.severity.includes(issue.severity)) return false;
  if (q.status !== undefined && q.status.length > 0 && !q.status.includes(issue.status)) return false;
  if (q.ruleId !== undefined && issue.ruleId !== q.ruleId) return false;
  if (q.columnId !== undefined) {
    const wanted = root(q.columnId);
    if (!issue.columns.some((c) => c === q.columnId || root(c) === wanted)) return false;
  }
  const text = q.text?.trim().toLowerCase() ?? '';
  if (text === '') return true;
  return [issue.title, issue.message, issue.ruleId, names].some((s) => s.toLowerCase().includes(text));
}

function rootOf(ds: DatasetState | undefined): (c: ColumnId) => ColumnId {
  if (ds === undefined) return (c) => c;
  const view = workingView(ds);
  return (c) => {
    try {
      return rootColumn(view, c);
    } catch {
      return c;
    }
  };
}

export function listIssues(state: ProjectState, q: IssueQuery): Page<Issue> {
  const { offset, limit } = paging(q.offset, q.limit);
  const order = issueOrder(q.sort);
  if (q.datasetId !== undefined && !state.datasets.has(q.datasetId)) {
    throw new EngineError(
      'NOT_FOUND',
      `There is no dataset ${q.datasetId} in this project.`,
      'Choose a listed dataset.',
    );
  }
  const rows: Row[] = [];
  const add = (issue: Issue, ds: DatasetState | undefined): void => {
    const name = columnNames(ds);
    const names = issue.columns.map(name).join(', ');
    if (matches(issue, q, names, rootOf(ds))) rows.push({ issue, names });
  };
  for (const ds of state.datasets.values()) {
    if (q.datasetId !== undefined && ds.id !== q.datasetId) continue;
    for (const [id, st] of ds.issues) add(toIssue(id, st, ds), ds);
  }
  // Findings about the project file concern every dataset, so they are listed whatever the filter.
  for (const d of state.systemIssues) {
    if (q.datasetId === undefined || d.datasetId === '' || d.datasetId === q.datasetId) {
      add(systemToIssue(d, state.log.head.seq), state.datasets.get(d.datasetId));
    }
  }
  rows.sort(order);
  return page(
    rows.map((r) => r.issue),
    offset,
    limit,
  );
}

export function listOccurrences(state: ProjectState, id: string, p: PageRequest): Page<IssueOccurrence> {
  const { offset, limit } = paging(p?.offset, p?.limit);
  let found: { ds: DatasetState; st: NonNullable<ReturnType<DatasetState['issues']['get']>> } | undefined;
  for (const ds of state.datasets.values()) {
    const st = ds.issues.get(id);
    if (st !== undefined) found = { ds, st };
  }
  if (found === undefined) {
    if (state.systemIssues.some((d) => issueId(d) === id)) return { items: [], total: 0, offset };
    throw new EngineError(
      'NOT_FOUND',
      `There is no issue ${id}.`,
      'Refresh the issues list and choose a listed issue.',
    );
  }
  const { ds, st } = found;
  const view = workingView(ds);
  const first = st.draft.columns[0];
  // The issue's column when it is still in the view; after a replacing conversion, its converted column.
  const column =
    first === undefined
      ? undefined
      : (view.schema.columns.find((c) => c.id === first) ??
        view.schema.columns.find((c) => rootColumn(view, c.id) === rootColumn(view, first)));
  const plan =
    first === undefined ? undefined : ds.dataset.schema.columns.find((c) => c.id === rootColumn(view, first));
  const rows = st.flagged.toArray();
  const items = rows.slice(offset, offset + limit).map((rowId): IssueOccurrence => {
    const state = occurrenceState(st, ds.excluded, rowId);
    const decidedBy =
      state === 'excluded'
        ? (ds.excludedBy.get(rowId) ?? null)
        : state === 'accepted'
          ? (st.decidedBy.get(rowId) ?? null)
          : null;
    return {
      issueId: id,
      rowId,
      columnId: first ?? null,
      value: column === undefined ? null : view.value(rowId, column.id),
      raw: column === undefined ? null : (view.raw(rowId, column.id) ?? null),
      locator: locator(ds.dataset.schema, ds.dataset.srcLoc(rowId), plan),
      state,
      decidedBy,
    };
  });
  return { items, total: rows.length, offset };
}

/** Units of a quantity, or the units a code converts to without crossing a convention. */
export function listUnits(q: { quantity?: QuantityKind; compatibleWith?: string } | undefined): UnitInfo[] {
  let units = allUnits().map(unitInfo);
  if (q?.compatibleWith !== undefined) {
    if (getUnit(q.compatibleWith) === undefined) {
      throw new EngineError(
        'UNIT_UNKNOWN',
        `The unit '${q.compatibleWith}' is not in the unit registry.`,
        'Choose a unit from the list.',
      );
    }
    const allowed = new Set(compatibleUnits(q.compatibleWith).map((u) => u.code));
    units = units.filter((u) => allowed.has(u.code));
  }
  if (q?.quantity !== undefined) units = units.filter((u) => u.quantity === q.quantity);
  return units;
}

/** The categories of data findings, in the order the health breakdown lists them. */
const DATA_CATEGORIES: RuleCategory[] = [
  'completeness',
  'uniqueness',
  'validity',
  'range',
  'units',
  'time',
  'spatial',
  'import',
];

/** 100 × (rows − affected) / rows, rounded down to one decimal, in integers so it is exact. */
export function healthScore(rows: number, affected: number): number {
  return rows === 0 ? 100 : Math.floor((1000 * (rows - affected)) / rows) / 10;
}

/** The data health score of a dataset (FR-VAL-05). */
export function datasetHealth(state: ProjectState, datasetId: DatasetId): DatasetHealth {
  const ds = datasetOf(state, datasetId);
  const n = ds.dataset.rowCount;
  const rows = n - ds.excluded.size;
  const counted = [...ds.issues.values()].filter((st) => st.draft.severity !== 'note');
  const affected = (sts: IssueState[]): RowSet =>
    sts
      .filter((st) => st.draft.scope === 'rows')
      .reduce((all, st) => all.union(st.current.minus(ds.excluded).minus(st.accepted)), new RowSet(n));
  const open = (sts: IssueState[]) => sts.filter((st) => issueCounts(st, ds.excluded).open > 0).length;
  const all = affected(counted).size;
  return {
    datasetId,
    checked: ds.checked,
    rows,
    affectedRows: all,
    score: ds.checked ? healthScore(rows, all) : null,
    categories: DATA_CATEGORIES.map((category) => {
      const sts = counted.filter((st) => st.draft.category === category);
      const hit = affected(sts).size;
      return { category, score: ds.checked ? healthScore(rows, hit) : null, affectedRows: hit, openIssues: open(sts) };
    }),
  };
}
