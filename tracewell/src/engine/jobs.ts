/**
 * Jobs (SAD section 8.2): every long operation runs as a job with its own AbortController, reports
 * progress no more often than the progress interval by the injected clock, and keeps its outcome so
 * the UI can fetch the result after the `job.done` event. A job commits its effect only at its end,
 * so a cancelled job leaves no trace.
 */
import type { EngineEvent } from '@tw/engine-api';
import { EngineError, type Clock, type JobHandle, type JobId, type JobOutcome, type JobProgress } from '@tw/model';

export interface JobContext {
  signal: AbortSignal;
  progress(p: JobProgress): void;
  /** Throws CANCELLED when the job has been cancelled; call it before committing anything. */
  checkCancelled(): void;
}

interface Job {
  controller: AbortController;
  outcome: JobOutcome<unknown>;
  lastProgressAt: number | null;
}

export function cancelledError(what: string): EngineError {
  return new EngineError('CANCELLED', `The ${what} was cancelled.`, 'Run it again when you are ready.');
}

export class JobManager {
  private nextId = 1;
  private readonly jobs = new Map<JobId, Job>();

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly emit: (e: EngineEvent) => void,
  ) {}

  /** Starts `run` on a later task and returns its handle at once. */
  start<T>(kind: JobHandle['kind'], run: (ctx: JobContext) => Promise<T>): JobHandle {
    const jobId = `j${this.nextId++}`;
    const job: Job = {
      controller: new AbortController(),
      outcome: { state: 'running', progress: null },
      lastProgressAt: null,
    };
    this.jobs.set(jobId, job);
    void this.drive(jobId, job, kind, run);
    return { jobId, kind };
  }

  /** Asks a running job to stop; a job that has already ended is left as it is. */
  cancel(jobId: JobId): void {
    const job = this.get(jobId);
    if (job.outcome.state === 'running') job.controller.abort();
  }

  /** A copy, so a caller in the same thread cannot change the stored result. */
  outcome(jobId: JobId): JobOutcome<unknown> {
    return structuredClone(this.get(jobId).outcome);
  }

  private get(jobId: JobId): Job {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined;
    if (job === undefined) {
      throw new EngineError('NOT_FOUND', `There is no job ${String(jobId)}.`, 'Choose a job from the Jobs panel.');
    }
    return job;
  }

  private async drive<T>(
    jobId: JobId,
    job: Job,
    kind: JobHandle['kind'],
    run: (ctx: JobContext) => Promise<T>,
  ): Promise<void> {
    const signal = job.controller.signal;
    const ctx: JobContext = {
      signal,
      checkCancelled: () => {
        if (signal.aborted) throw cancelledError(WHAT[kind]);
      },
      progress: (p) => {
        if (job.outcome.state !== 'running') return;
        job.outcome = { state: 'running', progress: p };
        const now = this.clock.now().getTime();
        if (job.lastProgressAt !== null && now - job.lastProgressAt < this.intervalMs) return;
        job.lastProgressAt = now;
        this.emit({ type: 'job.progress', jobId, progress: { ...p } });
      },
    };
    await Promise.resolve();
    try {
      ctx.checkCancelled();
      const result = await run(ctx);
      job.outcome = { state: 'done', result };
      this.emit({ type: 'job.done', jobId });
    } catch (e) {
      const error = EngineError.from(e);
      if (error.code === 'CANCELLED' && signal.aborted) {
        job.outcome = { state: 'cancelled' };
        this.emit({ type: 'job.cancelled', jobId });
        return;
      }
      const data = error.toData();
      job.outcome = { state: 'failed', error: data };
      this.emit({ type: 'job.failed', jobId, error: data });
    }
  }
}

const WHAT: Record<JobHandle['kind'], string> = {
  import: 'import',
  check: 'check run',
  step: 'step',
  export: 'export',
  save: 'save',
  open: 'project opening',
  recipe: 'recipe run',
};
