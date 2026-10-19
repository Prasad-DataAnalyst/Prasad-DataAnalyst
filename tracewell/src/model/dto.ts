/**
 * Data transfer objects of the engine protocol: windows, statistics, lineage, previews and jobs.
 * Everything here is structured-clone safe.
 */
import type { AuditAction, AuditEntry } from './audit';
import type { Assumption, Detection } from './detection';
import type { EngineErrorData } from './errors';
import type { FormatOptions, SniffResult } from './formats';
import type { AuditSeq, ColumnId, DatasetId, FileId, IsoUtc, JobId, JsonValue, RowId } from './ids';
import type { RulePackRef, Severity } from './rules';
import type { ColumnPlan, ColumnRole, CrsRef, DateFormat, TimezoneMode } from './schema';
import type { Step } from './steps';
import type { ConversionMethod } from './units';
import type { CellValue, LogicalType } from './values';

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
}

export interface RowWindowRequest {
  datasetId: DatasetId;
  stage: 'working' | 'output';
  offset: number;
  /** At most ROW_WINDOW_MAX. */
  limit: number;
  columns?: ColumnId[];
}

export interface RowWindowColumn {
  id: ColumnId;
  name: string;
  unit: string | null;
  type: LogicalType;
  assumed: boolean;
  derived: boolean;
}

export interface RowWindow {
  datasetId: DatasetId;
  stage: 'working' | 'output';
  offset: number;
  totalRows: number;
  columns: RowWindowColumn[];
  /** `cells`, `edited` and `issue` are parallel to `columns`; `issue` is the worst open severity. */
  rows: { rowId: RowId; locator: string; cells: CellValue[]; edited: boolean[]; issue: (Severity | null)[] }[];
}

export interface ColumnStats {
  columnId: ColumnId;
  count: number;
  nulls: number;
  /** Values whose raw text did not parse into the column type. */
  rawRejected: number;
  distinct: number;
  distinctCapped: boolean;
  min: CellValue;
  max: CellValue;
  mean: number | null;
  topValues: { value: CellValue; count: number }[];
}

/** The answer to "where did this value come from?" (SAD section 9.3). */
export interface CellLineage {
  datasetId: DatasetId;
  rowId: RowId;
  columnId: ColumnId;
  source: { fileId: FileId; fileName: string; locator: string; rawText: string | null };
  parse: { type: LogicalType; method: string; nullMarker: string | null; ok: boolean };
  history: {
    seq: AuditSeq;
    at: IsoUtc;
    actor: string;
    action: AuditAction;
    old: JsonValue | undefined;
    new: JsonValue | undefined;
    reason: string | undefined;
    method?: ConversionMethod;
  }[];
  current: CellValue;
}

export interface ColumnOverride {
  columnId: ColumnId;
  name?: string;
  type?: LogicalType;
  unit?: string | null;
  role?: ColumnRole;
  nullMarkers?: string[];
  dateFormat?: DateFormat;
  timezone?: TimezoneMode;
}

export interface ImportPreview {
  previewId: string;
  fileName: string;
  size: number;
  sniff: SniffResult;
  columns: ColumnPlan[];
  /** At most 200 parsed rows. */
  rows: CellValue[][];
  crs: Detection<CrsRef> | null;
  assumptions: Assumption[];
  estimatedRows: number | null;
  exceedsBudget: boolean;
}

export interface ImportRequestOptions {
  name?: string;
  options?: FormatOptions;
  columnOverrides?: ColumnOverride[];
  overrideReason?: string;
}

export interface CheckSummary {
  datasetId: DatasetId;
  packs: RulePackRef[];
  issues: number;
  bySeverity: Record<Severity, number>;
  byRule: Record<string, number>;
  durationMs: number;
}

export interface StepPreview {
  ok: boolean;
  error?: EngineErrorData;
  method?: ConversionMethod;
  description: string;
  sample: { rowId: RowId; before: CellValue; after: CellValue }[];
  resultingRows?: number;
}

export interface StepResult {
  step: Step;
  audit: AuditEntry;
  description: string;
  method?: ConversionMethod;
  converted?: number;
  nullsSkipped?: number;
  outputRows: number;
}

export interface JobHandle {
  jobId: JobId;
  kind: 'import' | 'check' | 'step' | 'export' | 'save' | 'open';
}

export interface JobProgress {
  phase: string;
  done: number;
  total?: number;
  unit: 'bytes' | 'rows' | 'items';
}

export type JobOutcome<T> =
  | { state: 'running'; progress: JobProgress | null }
  | { state: 'done'; result: T }
  | { state: 'failed'; error: EngineErrorData }
  | { state: 'cancelled' };
