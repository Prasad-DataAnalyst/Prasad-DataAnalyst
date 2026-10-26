/**
 * The engine protocol (SAD section 4.1): the only engine dependency of the UI. Every method takes
 * and returns structured-clone-safe data, long operations are jobs, and data is read in windows,
 * so a native engine can implement the same interface behind another transport.
 */
import type {
  AuditEntry,
  AuditQuery,
  CellLineage,
  ChainReport,
  ColumnId,
  ColumnStats,
  DatasetId,
  Decision,
  EngineErrorData,
  ExportProfileId,
  ExportProfileStatus,
  ExportRequest,
  FileInput,
  FileTarget,
  FormatOptions,
  ImportPreview,
  ImportRequestOptions,
  IsoUtc,
  Issue,
  IssueId,
  IssueOccurrence,
  IssueQuery,
  JobHandle,
  JobId,
  JobOutcome,
  JobProgress,
  Page,
  PageRequest,
  ProjectSummary,
  QuantityKind,
  RowId,
  RowWindow,
  RowWindowRequest,
  RulePack,
  SourceFormat,
  StepId,
  StepInput,
  StepPreview,
  TableSchema,
  UnitInfo,
  UserProfile,
} from '@tw/model';

/** Semantic version of this protocol; a major mismatch between UI and engine is refused (SAD section 4.2). */
export const PROTOCOL_VERSION = '0.1.0';

/** What an engine is and can do; the UI adapts to the capabilities rather than assuming them. */
export interface EngineInfo {
  name: string;
  version: string;
  protocol: string;
  capabilities: {
    formats: SourceFormat[];
    exportProfiles: ExportProfileId[];
    memoryBudgetBytes: number;
    spillToDisk: boolean;
    crsTransform: boolean;
  };
}

/**
 * The engine's methods. Methods that return a JobHandle start a job; its result (named in the
 * comment) is fetched with jobOutcome once a `job.done` event arrives, or with EngineClient.awaitJob.
 * There is deliberately no method that updates or deletes audit entries (FR-AUD-02).
 */
export interface EngineApi {
  hello(): Promise<EngineInfo>;
  newProject(o: { name: string; profile: UserProfile; unitSystem?: 'SI' | 'Oilfield' }): Promise<ProjectSummary>;
  getProject(): Promise<ProjectSummary>;
  /** Result: ProjectOpenReport. */
  openProject(file: FileInput): Promise<JobHandle>;
  /** Result: SaveResult. */
  saveProject(target?: FileTarget): Promise<JobHandle>;
  /**
   * Reads at most PREVIEW_MAX_BYTES. With `options`, the preview reads the file with those settings
   * (a delimiter, encoding or header rows the user chose) instead of the detected ones.
   */
  sniff(file: FileInput, o?: { options?: FormatOptions }): Promise<ImportPreview>;
  /** Result: DatasetSummary. */
  importFile(file: FileInput, o?: ImportRequestOptions): Promise<JobHandle>;
  getSchema(datasetId: DatasetId, stage?: 'working' | 'output'): Promise<TableSchema>;
  getRows(q: RowWindowRequest): Promise<RowWindow>;
  getColumnStats(datasetId: DatasetId, columnId: ColumnId): Promise<ColumnStats>;
  explainCell(datasetId: DatasetId, rowId: RowId, columnId: ColumnId): Promise<CellLineage>;
  /** Result: CheckSummary. */
  runChecks(datasetId: DatasetId): Promise<JobHandle>;
  listIssues(q: IssueQuery): Promise<Page<Issue>>;
  listOccurrences(issueId: IssueId, p: PageRequest): Promise<Page<IssueOccurrence>>;
  decide(d: Decision): Promise<AuditEntry[]>;
  listAudit(q: AuditQuery): Promise<Page<AuditEntry>>;
  verifyAudit(): Promise<ChainReport>;
  previewStep(datasetId: DatasetId, s: StepInput): Promise<StepPreview>;
  /** Result: StepResult. */
  applyStep(datasetId: DatasetId, s: StepInput, reason: string): Promise<JobHandle>;
  removeStep(datasetId: DatasetId, stepId: StepId, reason: string): Promise<AuditEntry>;
  listUnits(q?: { quantity?: QuantityKind; compatibleWith?: string }): Promise<UnitInfo[]>;
  listRulePacks(): Promise<RulePack[]>;
  listExportProfiles(datasetId: DatasetId): Promise<ExportProfileStatus[]>;
  /** Result: ExportResult. */
  exportData(req: ExportRequest): Promise<JobHandle>;
  cancelJob(jobId: JobId): Promise<void>;
  jobOutcome(jobId: JobId): Promise<JobOutcome<unknown>>;
}

/** What the engine tells the UI without being asked. */
export type EngineEvent =
  | { type: 'job.progress'; jobId: JobId; progress: JobProgress }
  | { type: 'job.done'; jobId: JobId }
  | { type: 'job.failed'; jobId: JobId; error: EngineErrorData }
  | { type: 'job.cancelled'; jobId: JobId }
  | {
      type: 'project.changed';
      what: ('project' | 'datasets' | 'schema' | 'issues' | 'audit' | 'steps' | 'exports')[];
      datasetId?: DatasetId;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: IsoUtc };

/** An engine implementation: the API plus a subscription to its events. */
export type EngineImpl = EngineApi & { on(cb: (e: EngineEvent) => void): () => void };

export type RpcRequest = { kind: 'call'; id: number; method: keyof EngineApi; params: unknown[] };
export type RpcResponse =
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: EngineErrorData };
export type RpcEvent = { kind: 'event'; event: EngineEvent };

/** The part of MessagePort, Worker and DedicatedWorkerGlobalScope that the RPC needs. */
export interface MessagePortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', l: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', l: (e: MessageEvent) => void): void;
  start?(): void;
}

/** Carries calls and events between an EngineClient and an engine, whatever lies in between. */
export interface Transport {
  call(method: keyof EngineApi, params: unknown[]): Promise<unknown>;
  onEvent(cb: (e: EngineEvent) => void): () => void;
  close(): void;
}

/**
 * Every EngineApi method, as a runtime list: serve() answers only these, so a message cannot reach
 * `on` or any other property of the implementation. The compiler proves the list complete.
 */
export const ENGINE_METHODS = [
  'hello',
  'newProject',
  'getProject',
  'openProject',
  'saveProject',
  'sniff',
  'importFile',
  'getSchema',
  'getRows',
  'getColumnStats',
  'explainCell',
  'runChecks',
  'listIssues',
  'listOccurrences',
  'decide',
  'listAudit',
  'verifyAudit',
  'previewStep',
  'applyStep',
  'removeStep',
  'listUnits',
  'listRulePacks',
  'listExportProfiles',
  'exportData',
  'cancelJob',
  'jobOutcome',
] as const satisfies readonly (keyof EngineApi)[];

type MissingMethod = Exclude<keyof EngineApi, (typeof ENGINE_METHODS)[number]>;
// Fails to compile, naming the method, when EngineApi gains a method the list above lacks.
const _everyMethodListed: [MissingMethod] extends [never] ? true : MissingMethod = true;
void _everyMethodListed;

const METHOD_NAMES: ReadonlySet<string> = new Set(ENGINE_METHODS);

export function isEngineMethod(v: unknown): v is keyof EngineApi {
  return typeof v === 'string' && METHOD_NAMES.has(v);
}
