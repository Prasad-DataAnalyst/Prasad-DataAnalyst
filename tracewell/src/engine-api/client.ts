/** EngineClient: the typed face of the engine protocol that the UI holds. */
import {
  EngineError,
  type AuditEntry,
  type AuditQuery,
  type CellLineage,
  type ChainReport,
  type ColumnId,
  type ColumnStats,
  type DatasetHealth,
  type DatasetId,
  type Decision,
  type ExportProfileStatus,
  type ExportRequest,
  type FileInput,
  type FileTarget,
  type FormatOptions,
  type ImportPreview,
  type ImportRequestOptions,
  type Issue,
  type IssueId,
  type IssueOccurrence,
  type IssueQuery,
  type JobHandle,
  type JobId,
  type JobOutcome,
  type JobProgress,
  type MappingTemplate,
  type Page,
  type PageRequest,
  type ProjectSummary,
  type QuantityKind,
  type RowId,
  type RowWindow,
  type RowWindowRequest,
  type RulePack,
  type StepId,
  type StepInput,
  type StepPreview,
  type TableSchema,
  type TemplateId,
  type UnitInfo,
  type UserProfile,
} from '@tw/model';
import { jobClosedError, reportAsync, unexpectedOutcomeError } from './messages';
import type { EngineApi, EngineEvent, EngineInfo, Transport } from './protocol';

export class EngineClient implements EngineApi {
  /** Jobs being awaited; close() settles them, since no event or answer will reach them afterwards. */
  private readonly waiters = new Set<{ abandon(): void }>();

  constructor(private readonly t: Transport) {}

  onEvent(cb: (e: EngineEvent) => void): () => void {
    return this.t.onEvent(cb);
  }

  /**
   * Waits for a job and returns its result. Rejects with the job's EngineError when it fails and
   * with CANCELLED when it is cancelled. Aborting `signal` asks the engine to cancel; the promise
   * then settles with the engine's verdict, because a job that finished before the cancel arrived
   * has changed the project, and reporting it as cancelled would hide that. close() rejects it
   * with PROTOCOL_MISMATCH, as it does every pending call.
   */
  awaitJob<T>(h: JobHandle, onProgress?: (p: JobProgress) => void, signal?: AbortSignal): Promise<T> {
    const waiter = new JobWaiter<T>(this, h.jobId, onProgress, signal, (w) => this.waiters.delete(w));
    this.waiters.add(waiter);
    return waiter.promise;
  }

  close(): void {
    this.t.close();
    for (const w of [...this.waiters]) w.abandon();
  }

  hello(): Promise<EngineInfo> {
    return this.invoke('hello');
  }

  newProject(o: { name: string; profile: UserProfile; unitSystem?: 'SI' | 'Oilfield' }): Promise<ProjectSummary> {
    return this.invoke('newProject', o);
  }

  getProject(): Promise<ProjectSummary> {
    return this.invoke('getProject');
  }

  openProject(file: FileInput): Promise<JobHandle> {
    return this.invoke('openProject', file);
  }

  saveProject(target?: FileTarget): Promise<JobHandle> {
    return this.invoke('saveProject', target);
  }

  sniff(file: FileInput, o?: { options?: FormatOptions; template?: TemplateId | null }): Promise<ImportPreview> {
    return o === undefined ? this.invoke('sniff', file) : this.invoke('sniff', file, o);
  }

  importFile(file: FileInput, o?: ImportRequestOptions): Promise<JobHandle> {
    return this.invoke('importFile', file, o);
  }

  getSchema(datasetId: DatasetId, stage?: 'working' | 'output'): Promise<TableSchema> {
    return this.invoke('getSchema', datasetId, stage);
  }

  getRows(q: RowWindowRequest): Promise<RowWindow> {
    return this.invoke('getRows', q);
  }

  getColumnStats(datasetId: DatasetId, columnId: ColumnId): Promise<ColumnStats> {
    return this.invoke('getColumnStats', datasetId, columnId);
  }

  explainCell(datasetId: DatasetId, rowId: RowId, columnId: ColumnId): Promise<CellLineage> {
    return this.invoke('explainCell', datasetId, rowId, columnId);
  }

  runChecks(datasetId: DatasetId): Promise<JobHandle> {
    return this.invoke('runChecks', datasetId);
  }

  listIssues(q: IssueQuery): Promise<Page<Issue>> {
    return this.invoke('listIssues', q);
  }

  listOccurrences(issueId: IssueId, p: PageRequest): Promise<Page<IssueOccurrence>> {
    return this.invoke('listOccurrences', issueId, p);
  }

  getHealth(datasetId: DatasetId): Promise<DatasetHealth> {
    return this.invoke('getHealth', datasetId);
  }

  decide(d: Decision): Promise<AuditEntry[]> {
    return this.invoke('decide', d);
  }

  listAudit(q: AuditQuery): Promise<Page<AuditEntry>> {
    return this.invoke('listAudit', q);
  }

  verifyAudit(): Promise<ChainReport> {
    return this.invoke('verifyAudit');
  }

  previewStep(datasetId: DatasetId, s: StepInput): Promise<StepPreview> {
    return this.invoke('previewStep', datasetId, s);
  }

  applyStep(datasetId: DatasetId, s: StepInput, reason: string): Promise<JobHandle> {
    return this.invoke('applyStep', datasetId, s, reason);
  }

  removeStep(datasetId: DatasetId, stepId: StepId, reason: string): Promise<AuditEntry> {
    return this.invoke('removeStep', datasetId, stepId, reason);
  }

  listUnits(q?: { quantity?: QuantityKind; compatibleWith?: string }): Promise<UnitInfo[]> {
    return this.invoke('listUnits', q);
  }

  listRulePacks(): Promise<RulePack[]> {
    return this.invoke('listRulePacks');
  }

  listExportProfiles(datasetId: DatasetId): Promise<ExportProfileStatus[]> {
    return this.invoke('listExportProfiles', datasetId);
  }

  exportData(req: ExportRequest): Promise<JobHandle> {
    return this.invoke('exportData', req);
  }

  cancelJob(jobId: JobId): Promise<void> {
    return this.invoke('cancelJob', jobId);
  }

  jobOutcome(jobId: JobId): Promise<JobOutcome<unknown>> {
    return this.invoke('jobOutcome', jobId);
  }

  listMappingTemplates(): Promise<MappingTemplate[]> {
    return this.invoke('listMappingTemplates');
  }

  saveMappingTemplate(o: { datasetId: DatasetId; name: string }): Promise<MappingTemplate> {
    return this.invoke('saveMappingTemplate', o);
  }

  deleteMappingTemplate(id: TemplateId): Promise<void> {
    return this.invoke('deleteMappingTemplate', id);
  }

  /**
   * The public methods' signatures carry the types; this sends the call. Trailing omitted
   * arguments are dropped so the engine sees the same arity as a direct call.
   */
  private invoke<T>(method: keyof EngineApi, ...params: unknown[]): Promise<T> {
    let end = params.length;
    while (end > 0 && params[end - 1] === undefined) end--;
    return this.t.call(method, params.slice(0, end)) as Promise<T>;
  }
}

/** One awaitJob call: listens for the job's events and asks for its outcome when it is done. */
class JobWaiter<T> {
  readonly promise: Promise<T>;
  private resolve!: (value: T) => void;
  private reject!: (error: EngineError) => void;
  private settled = false;
  private polling = false;
  private pollAgain = false;
  private progressSeen = false;
  private readonly offEvents: () => void;

  constructor(
    private readonly client: EngineClient,
    private readonly jobId: JobId,
    private readonly onProgress: ((p: JobProgress) => void) | undefined,
    private readonly signal: AbortSignal | undefined,
    private readonly onSettled: (w: { abandon(): void }) => void,
  ) {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Subscribe before the first poll: a job can finish between starting and this call, and the
    // poll covers that case, while events cover everything after it.
    this.offEvents = client.onEvent(this.onEvent);
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted === true) this.onAbort();
    this.poll();
  }

  private readonly onEvent = (e: EngineEvent): void => {
    if (this.settled || !('jobId' in e) || e.jobId !== this.jobId) return;
    switch (e.type) {
      case 'job.progress':
        this.progressSeen = true;
        this.onProgress?.(e.progress);
        return;
      case 'job.done':
        this.poll();
        return;
      case 'job.failed':
        this.fail(EngineError.from(e.error));
        return;
      case 'job.cancelled':
        this.fail(cancelledError(this.jobId));
        return;
    }
  };

  private readonly onAbort = (): void => {
    // A failed cancel (the job already finished, or the engine went away) changes nothing here:
    // the job's own outcome, or the failing outcome request, settles this waiter.
    this.client.cancelJob(this.jobId).catch(() => undefined);
  };

  /** Asks for the outcome, one request at a time; a `job.done` during a request triggers one more. */
  private poll(): void {
    if (this.settled) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    this.client.jobOutcome(this.jobId).then(
      (outcome) => this.onOutcome(outcome),
      (e: unknown) => this.fail(EngineError.from(e)),
    );
  }

  private onOutcome(outcome: unknown): void {
    this.polling = false;
    if (this.settled) return;
    if (!isJobOutcome(outcome)) {
      this.fail(unexpectedOutcomeError(this.jobId));
      return;
    }
    switch (outcome.state) {
      case 'done':
        this.finish(() => this.resolve(outcome.result as T));
        return;
      case 'failed':
        this.fail(EngineError.from(outcome.error));
        return;
      case 'cancelled':
        this.fail(cancelledError(this.jobId));
        return;
      case 'running':
        this.reportPolledProgress(outcome.progress);
        if (this.pollAgain) {
          this.pollAgain = false;
          this.poll();
        }
        return;
    }
  }

  /** Progress from a poll matters only until the first progress event, which is always newer. */
  private reportPolledProgress(progress: JobProgress | null): void {
    if (progress === null || this.progressSeen || this.onProgress === undefined) return;
    try {
      this.onProgress(progress);
    } catch (e) {
      reportAsync(e);
    }
  }

  /** The connection closed while waiting: nothing will ever settle this waiter otherwise. */
  abandon(): void {
    this.fail(jobClosedError(this.jobId));
  }

  private fail(error: EngineError): void {
    this.finish(() => this.reject(error));
  }

  private finish(settle: () => void): void {
    if (this.settled) return;
    this.settled = true;
    this.offEvents();
    this.signal?.removeEventListener('abort', this.onAbort);
    this.onSettled(this);
    settle();
  }
}

const OUTCOME_STATES: ReadonlySet<unknown> = new Set<JobOutcome<unknown>['state']>([
  'running',
  'done',
  'failed',
  'cancelled',
]);

/** The answer comes from another program; a state outside the protocol would otherwise leave the waiter hanging. */
function isJobOutcome(v: unknown): v is JobOutcome<unknown> {
  return typeof v === 'object' && v !== null && OUTCOME_STATES.has((v as { state?: unknown }).state);
}

function cancelledError(jobId: JobId): EngineError {
  return new EngineError('CANCELLED', `Job ${jobId} was cancelled.`, 'Start the operation again when you are ready.');
}
