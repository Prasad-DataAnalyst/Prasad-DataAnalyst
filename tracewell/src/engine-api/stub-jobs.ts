/**
 * The stub's jobs: each one reports a few progress steps on later tasks, then applies its whole
 * effect at once, so a cancelled job leaves no trace, as SAD section 8.2 requires of real jobs.
 */
import { EngineError, type JobHandle, type JobId, type JobOutcome, type JobProgress } from '@tw/model';
import type { EngineEvent } from './protocol';

/** Progress events per job: enough for a progress bar to move, few enough to stay quick. */
const PROGRESS_STEPS = 3;

export interface JobSpec<T> {
  kind: JobHandle['kind'];
  phase: string;
  unit: JobProgress['unit'];
  total: number;
  /** Applies the job's effect and returns its result; runs only if the job was not cancelled. */
  run(): T;
}

/** A macrotask, so calls and cancels sent meanwhile are handled between progress steps. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class StubJobs {
  private nextId = 1;
  private readonly outcomes = new Map<JobId, JobOutcome<unknown>>();

  constructor(private readonly emit: (e: EngineEvent) => void) {}

  start<T>(spec: JobSpec<T>): JobHandle {
    const jobId = `j${this.nextId++}`;
    this.outcomes.set(jobId, { state: 'running', progress: null });
    void this.drive(jobId, spec);
    return { jobId, kind: spec.kind };
  }

  /** Cancelling a job that has already ended changes nothing, as with the real engine. */
  cancel(jobId: JobId): void {
    if (this.get(jobId).state !== 'running') return;
    this.outcomes.set(jobId, { state: 'cancelled' });
    this.emit({ type: 'job.cancelled', jobId });
  }

  /** A copy, so a caller in the same thread cannot change the stored result. */
  outcome(jobId: JobId): JobOutcome<unknown> {
    return structuredClone(this.get(jobId));
  }

  private get(jobId: JobId): JobOutcome<unknown> {
    const outcome = this.outcomes.get(jobId);
    if (outcome === undefined) {
      throw new EngineError('NOT_FOUND', `There is no job ${jobId}.`, 'Choose a job from the Jobs panel.');
    }
    return outcome;
  }

  private running(jobId: JobId): boolean {
    return this.outcomes.get(jobId)?.state === 'running';
  }

  private async drive<T>(jobId: JobId, spec: JobSpec<T>): Promise<void> {
    for (let step = 1; step <= PROGRESS_STEPS; step++) {
      await nextTask();
      if (!this.running(jobId)) return;
      const progress: JobProgress = {
        phase: spec.phase,
        done: Math.round((spec.total * step) / PROGRESS_STEPS),
        total: spec.total,
        unit: spec.unit,
      };
      this.outcomes.set(jobId, { state: 'running', progress });
      this.emit({ type: 'job.progress', jobId, progress });
    }
    await nextTask();
    if (this.running(jobId)) this.finish(jobId, spec);
  }

  private finish<T>(jobId: JobId, spec: JobSpec<T>): void {
    try {
      const result = spec.run();
      this.outcomes.set(jobId, { state: 'done', result });
      this.emit({ type: 'job.done', jobId });
    } catch (e) {
      const error = EngineError.from(e).toData();
      this.outcomes.set(jobId, { state: 'failed', error });
      this.emit({ type: 'job.failed', jobId, error });
    }
  }
}
