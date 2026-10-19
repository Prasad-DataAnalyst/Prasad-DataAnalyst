/**
 * The audit log (SAD section 9): append-only, SHA-256 hash-chained, and the single source of truth
 * from which project state is rebuilt.
 */
import type { AuditSeq, ColumnId, DatasetId, FileId, IsoUtc, IssueId, JsonValue, RowId, Sha256Hex, StepId } from './ids';
import type { ConversionMethod } from './units';

export type AuditAction =
  | 'project.create'
  | 'source.add'
  | 'detection.assume'
  | 'detection.override'
  | 'check.run'
  | 'cell.edit'
  | 'issue.accept'
  | 'issue.comment'
  | 'rows.exclude'
  | 'step.apply'
  | 'step.remove'
  | 'entry.revert'
  | 'project.area'
  | 'export.create'
  | 'project.save';

export type Actor =
  | { kind: 'user'; profileId: string; name: string; role: 'Analyst' }
  | { kind: 'system'; component: 'detector' | 'engine' };

export interface AuditTarget {
  datasetId?: DatasetId;
  rowId?: RowId;
  columnId?: ColumnId;
  issueId?: IssueId;
  stepId?: StepId;
  seq?: AuditSeq;
  fileId?: FileId;
  locator?: string;
}

/** What the engine asks the log to append; the log adds seq, time, actor and the chain hashes. */
export interface AuditDraft {
  action: AuditAction;
  target: AuditTarget;
  old?: JsonValue;
  new?: JsonValue;
  reason?: string;
  method?: ConversionMethod;
  rule?: { id: string; version: string };
  payload?: JsonValue;
}

/**
 * `prev` is the previous entry's hash (the genesis value is SHA-256(AUDIT_GENESIS_PREFIX + projectId));
 * `hash` is SHA-256(utf8(canonicalJson(entry without hash))).
 */
export interface AuditEntry extends AuditDraft {
  seq: AuditSeq;
  at: IsoUtc;
  actor: Actor;
  prev: Sha256Hex;
  hash: Sha256Hex;
}

export interface AuditQuery {
  datasetId?: DatasetId;
  action?: AuditAction[];
  rowId?: RowId;
  columnId?: ColumnId;
  fromSeq?: AuditSeq;
  offset?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

/** Result of verifying the chain; tamper-evident, not tamper-proof (SAD section 9.2). */
export interface ChainReport {
  ok: boolean;
  entries: number;
  brokenAt?: AuditSeq;
  reason?: string;
}
