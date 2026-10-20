/**
 * The stub's three rules and its issue state: rows flagged now and ever, accepted rows and
 * comments, with counts and status computed as SAD section 7.7 defines them.
 */
import {
  type AuditSeq,
  type ColumnId,
  type DatasetId,
  type Issue,
  type IssueComment,
  type IssueId,
  type IssueOccurrence,
  type RowId,
  type RowRanges,
  type RuleDef,
  type Severity,
} from '@tw/model';
import { findUnit, RULE_NOT_NULL, RULE_NULL_MARKER, RULE_PHYSICAL_RANGE, SI_LIMITS, sourceLine, stubHex } from './stub-data';
import { rootColumn, type StubDataset, type StubView, type ViewColumn } from './stub-view';

export interface StubIssue {
  id: IssueId;
  rule: RuleDef;
  datasetId: DatasetId;
  columns: ColumnId[];
  flagged: Set<RowId>;
  everFlagged: Set<RowId>;
  /** Accepted rows and the audit entry that accepted each. */
  accepted: Map<RowId, AuditSeq>;
  comments: IssueComment[];
  firstSeenSeq: AuditSeq;
  lastCheckedSeq: AuditSeq;
}

interface Finding {
  rule: RuleDef;
  column: ViewColumn;
  rows: RowId[];
}

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

export function issueId(ruleId: string, datasetId: DatasetId, columns: ColumnId[]): IssueId {
  return `I-${stubHex(`${ruleId}|${datasetId}|${[...columns].sort().join(',')}`, 12)}`;
}

function flaggedRows(view: StubView, test: (rowId: RowId) => boolean): RowId[] {
  return view.rows.filter(test);
}

function outOfRange(column: ViewColumn, rowId: RowId): boolean {
  const unit = findUnit(column.schema.unit.value);
  const limits = column.schema.quantity === null ? undefined : SI_LIMITS[column.schema.quantity];
  const v = column.value(rowId);
  if (unit === undefined || limits === undefined || typeof v !== 'number') return false;
  const si = v * unit.toSI.factor + unit.toSI.offset;
  return si < limits.min || si > limits.max;
}

function isNullMarker(column: ViewColumn, rowId: RowId): boolean {
  const raw = column.raw(rowId);
  return !column.edited(rowId) && raw !== null && column.schema.nullMarkers.value.includes(raw);
}

/** Runs the stub's rules over a working view. */
export function runRules(view: StubView): Finding[] {
  const findings: Finding[] = [];
  for (const column of view.columns) {
    const isMeasure = column.schema.role.value === 'measure';
    if (isMeasure) {
      findings.push({ rule: RULE_NOT_NULL, column, rows: flaggedRows(view, (r) => column.value(r) === null) });
      findings.push({ rule: RULE_PHYSICAL_RANGE, column, rows: flaggedRows(view, (r) => outOfRange(column, r)) });
    }
    findings.push({ rule: RULE_NULL_MARKER, column, rows: flaggedRows(view, (r) => isNullMarker(column, r)) });
  }
  return findings.filter((f) => f.rows.length > 0);
}

/**
 * Merges a check run into the issue state: new issues are created, every issue of the dataset gets
 * its current rows, and rows flagged once stay in `everFlagged` so fixes can be counted. Issues are
 * keyed by the source column, so converting a column keeps its issues rather than "fixing" them.
 */
export function mergeFindings(
  issues: Map<IssueId, StubIssue>,
  ds: StubDataset,
  findings: Finding[],
  seq: AuditSeq,
): void {
  const current = new Map<IssueId, Set<RowId>>();
  for (const f of findings) {
    const column = rootColumn(f.column.schema.id);
    const id = issueId(f.rule.id, ds.id, [column]);
    const rows = current.get(id) ?? new Set<RowId>();
    for (const r of f.rows) rows.add(r);
    current.set(id, rows);
    if (!issues.has(id)) issues.set(id, newIssue(id, f.rule, column, ds.id, seq));
  }
  for (const issue of issues.values()) {
    if (issue.datasetId !== ds.id) continue;
    issue.flagged = current.get(issue.id) ?? new Set();
    for (const r of issue.flagged) issue.everFlagged.add(r);
    issue.lastCheckedSeq = seq;
  }
}

function newIssue(id: IssueId, rule: RuleDef, column: ColumnId, datasetId: DatasetId, seq: AuditSeq): StubIssue {
  return {
    id,
    rule,
    datasetId,
    columns: [column],
    flagged: new Set(),
    everFlagged: new Set(),
    accepted: new Map(),
    comments: [],
    firstSeenSeq: seq,
    lastCheckedSeq: seq,
  };
}

export function openRows(issue: StubIssue): RowId[] {
  return [...issue.flagged].filter((r) => !issue.accepted.has(r)).sort((a, b) => a - b);
}

function counts(issue: StubIssue, ds: StubDataset): Issue['counts'] {
  const ever = [...issue.everFlagged];
  return {
    flagged: ever.length,
    open: openRows(issue).length,
    accepted: [...issue.flagged].filter((r) => issue.accepted.has(r)).length,
    excluded: ever.filter((r) => ds.excluded.has(r)).length,
    fixed: ever.filter((r) => !issue.flagged.has(r) && !ds.excluded.has(r)).length,
  };
}

function status(c: Issue['counts']): Issue['status'] {
  if (c.open === 0) return 'resolved';
  return c.accepted + c.excluded + c.fixed === 0 ? 'open' : 'partly_resolved';
}

export function rowRanges(rows: RowId[]): RowRanges {
  const ranges: [RowId, RowId][] = [];
  for (const r of rows) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] === r - 1) last[1] = r;
    else if (ranges.length < 1000) ranges.push([r, r]);
  }
  return { count: rows.length, ranges };
}

export function toIssue(issue: StubIssue, ds: StubDataset, columnName: (id: ColumnId) => string): Issue {
  const c = counts(issue, ds);
  const names = issue.columns.map(columnName).join(', ');
  return {
    id: issue.id,
    ruleId: issue.rule.id,
    ruleVersion: issue.rule.version,
    packId: 'tracewell.generic-dq',
    severity: issue.rule.severity,
    category: issue.rule.category,
    datasetId: issue.datasetId,
    columns: [...issue.columns],
    scope: 'rows',
    title: issue.rule.title,
    message: issue.rule.message.replace('{count}', String(issue.flagged.size)).replace('{column}', names),
    explanation: issue.rule.explanation,
    source: issue.rule.source,
    status: status(c),
    counts: c,
    openRows: rowRanges(openRows(issue)),
    comments: issue.comments.map((x) => ({ ...x })),
    firstSeenSeq: issue.firstSeenSeq,
    lastCheckedSeq: issue.lastCheckedSeq,
  };
}

/** Every row the issue ever flagged, with its state, for drill-down. */
export function occurrences(issue: StubIssue, ds: StubDataset, column: ViewColumn | undefined): IssueOccurrence[] {
  return [...issue.everFlagged]
    .sort((a, b) => a - b)
    .map((rowId) => {
      const excludedBy = ds.excluded.get(rowId);
      const acceptedBy = issue.accepted.get(rowId);
      const state: IssueOccurrence['state'] =
        excludedBy !== undefined
          ? 'excluded'
          : !issue.flagged.has(rowId)
            ? 'fixed'
            : acceptedBy !== undefined
              ? 'accepted'
              : 'open';
      return {
        issueId: issue.id,
        rowId,
        columnId: issue.columns[0] ?? null,
        value: column?.value(rowId) ?? null,
        raw: column?.raw(rowId) ?? null,
        locator: `line ${sourceLine(rowId)}`,
        state,
        decidedBy: state === 'excluded' ? (excludedBy ?? null) : state === 'accepted' ? (acceptedBy ?? null) : null,
      };
    });
}
