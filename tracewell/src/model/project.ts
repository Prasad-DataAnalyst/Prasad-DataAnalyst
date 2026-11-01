/** Project vocabulary: the `.twp` manifest (SAD section 11) and the summaries the UI shows. */
import type { ExportRecord, OriginalFileInfo } from './export';
import type { AuditSeq, BBox, DatasetId, IsoUtc, ProjectId, Sha256Hex, UserProfile } from './ids';
import type { RulePackRef } from './rules';
import type { TableSchema } from './schema';
import type { Step } from './steps';

export type IntegrityCheckId =
  | 'zip'
  | 'mimetype'
  | 'format-version'
  | 'manifest-schema'
  | 'entry-checksum'
  | 'original-checksum'
  | 'audit-chain'
  | 'replay-digest';

/** One open-time check; any failure opens the project read-only, never blocked and never silently repaired. */
export interface IntegrityCheck {
  id: IntegrityCheckId;
  ok: boolean;
  target?: string;
  detail: string;
  ruleId?: 'TW-PRJ-001' | 'TW-PRJ-002' | 'TW-PRJ-003' | 'TW-PRJ-004';
}

/**
 * A saved copy of what replaying part of the audit log gave (format 0.2, SAD decision D-13), so a
 * large project opens without importing its originals or running its checks again. A reader may
 * ignore it and replay; one that uses it still verifies its SHA-256 and the dataset digests after
 * replay.
 */
export interface ProjectCache {
  datasetId: DatasetId;
  /** The dataset's `source.add` entry. */
  sourceSeq: AuditSeq;
  /**
   * 'issues' only: the entry after which the dataset's issues are as the cache holds them, the last
   * before the save that could change them (its own entries, or a change of the project area).
   */
  afterSeq?: AuditSeq;
  /**
   * 'rows': the typed values with their row IDs (Parquet); 'exceptions': the source text of values
   * that did not parse (Parquet); 'notes': what the reader noticed in the file (JSON); 'issues': the
   * dataset's issues as they stood after that entry, with their rows and decisions (JSON).
   */
  kind: 'rows' | 'exceptions' | 'notes' | 'issues';
  path: string;
}

export interface ProjectManifest {
  format: 'tracewell-project';
  /** '0.2' adds `caches`. */
  formatVersion: '0.1' | '0.2';
  appVersion: string;
  projectId: ProjectId;
  name: string;
  createdAt: IsoUtc;
  savedAt: IsoUtc;
  savedBy: string;
  unitSystem: 'SI' | 'Oilfield';
  projectArea: BBox | null;
  unitRegistry: { version: string; sha256: Sha256Hex };
  rulePacks: RulePackRef[];
  originals: (OriginalFileInfo & { path: string })[];
  /** Digests of the working and output views, compared after replay (TW-PRJ-003). */
  datasets: { id: DatasetId; name: string; rowCount: number; workingDigest: Sha256Hex; outputDigest: Sha256Hex }[];
  auditHead: { seq: AuditSeq; hash: Sha256Hex };
  entries: { path: string; size: number; sha256: Sha256Hex }[];
  caches?: ProjectCache[];
}

export interface DatasetSummary {
  id: DatasetId;
  name: string;
  source: TableSchema['source'];
  rowCount: number;
  outputRowCount: number;
  columnCount: number;
  assumptions: number;
  partial: boolean;
  steps: Step[];
}

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  createdAt: IsoUtc;
  profile: UserProfile;
  unitSystem: 'SI' | 'Oilfield';
  projectArea: BBox | null;
  readOnly: boolean;
  dirty: boolean;
  lastSavedAt: IsoUtc | null;
  originals: OriginalFileInfo[];
  datasets: DatasetSummary[];
  exports: ExportRecord[];
  rulePacks: RulePackRef[];
  auditHead: { seq: AuditSeq; hash: Sha256Hex };
}

export interface ProjectOpenReport {
  project: ProjectSummary;
  readOnly: boolean;
  checks: IntegrityCheck[];
}

export interface SaveResult {
  fileName: string;
  size: number;
  sha256: Sha256Hex;
  bytes?: Uint8Array;
}

/**
 * Work an earlier session left unsaved (FR-PRJ-03): the session's journal holds its original files
 * and audit log, so the project can be rebuilt as it was when that session ended.
 */
export interface RecoveryInfo {
  projectId: ProjectId;
  name: string;
  /** When the journal was last written: the last change the session recorded. */
  updatedAt: IsoUtc;
  /** Audit entries in the journal, and how many came after the project was last saved. */
  entries: number;
  unsaved: number;
}
