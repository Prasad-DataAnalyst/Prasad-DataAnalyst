/**
 * Issues (SAD section 7.7): grouped per (rule, dataset, columns) with the affected rows held as a
 * set, so a million missing values is one issue with drill-down.
 */
import type { AuditSeq, ColumnId, DatasetId, IsoUtc, IssueId, JsonValue, RowId } from './ids';
import type { RuleCategory, Severity } from './rules';
import type { CellValue } from './values';

/** What a check primitive reports, before the engine merges it into issue state. */
export interface IssueDraft {
  ruleId: string;
  ruleVersion: string;
  packId: string;
  severity: Severity;
  category: RuleCategory;
  datasetId: DatasetId;
  columns: ColumnId[];
  scope: 'rows' | 'column' | 'dataset';
  /** Sorted and unique. */
  rows: RowId[];
  message: string;
  detail?: Record<string, JsonValue>;
}

/** A compact row set for transport. */
export interface RowRanges {
  count: number;
  /** Inclusive ranges, capped at 1,000; `count` is always exact. */
  ranges: [RowId, RowId][];
}

export interface IssueComment {
  seq: AuditSeq;
  at: IsoUtc;
  by: string;
  text: string;
}

export interface Issue {
  id: IssueId;
  ruleId: string;
  ruleVersion: string;
  packId: string;
  severity: Severity;
  category: RuleCategory;
  datasetId: DatasetId;
  columns: ColumnId[];
  scope: 'rows' | 'column' | 'dataset';
  title: string;
  message: string;
  explanation: string;
  source: string;
  /** 'resolved' when nothing is open; 'open' when nothing is decided or fixed; otherwise 'partly_resolved'. */
  status: 'open' | 'partly_resolved' | 'resolved';
  counts: { flagged: number; open: number; accepted: number; excluded: number; fixed: number };
  openRows: RowRanges;
  comments: IssueComment[];
  firstSeenSeq: AuditSeq;
  lastCheckedSeq: AuditSeq;
}

/** One flagged cell or row of an issue, for drill-down. */
export interface IssueOccurrence {
  issueId: IssueId;
  rowId: RowId;
  columnId: ColumnId | null;
  value: CellValue;
  raw: string | null;
  /** Source locator, e.g. 'line 1042', 'Sheet1!C17' or 'feature 12'. */
  locator: string;
  state: 'open' | 'accepted' | 'excluded' | 'fixed';
  decidedBy: AuditSeq | null;
}

export interface IssueQuery {
  datasetId?: DatasetId;
  severity?: Severity[];
  status?: Issue['status'][];
  ruleId?: string;
  columnId?: ColumnId;
  text?: string;
  sort?: 'severity' | 'rule' | 'count' | 'column';
  offset?: number;
  limit?: number;
}
