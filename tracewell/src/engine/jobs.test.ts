/** Jobs report throttled progress, can be cancelled without a trace, and keep their outcomes. */
import { describe, expect, it } from 'vitest';
import { fixtureBytes } from '@tw/fixtures';
import type { EngineEvent } from '@tw/engine-api';
import type { DatasetSummary, JobProgress } from '@tw/model';
import { JobManager } from './jobs';
import { fixedClock } from './testing';
import { START, awaitJob, withProject } from './__fixtures__/session';

describe('jobs', () => {
  it('throttles progress events to at most 11 per simulated second', async () => {
    const events: EngineEvent[] = [];
    // Every clock reading moves time on by 10 ms, so 1,000 progress calls span 10 simulated seconds.
    const jobs = new JobManager(fixedClock(START, 10), 100, (e) => events.push(e));
    const handle = jobs.start('check', async (ctx) => {
      for (let i = 0; i < 1000; i++) ctx.progress({ phase: 'Counting', done: i, total: 1000, unit: 'items' });
      return 'counted';
    });
    while (jobs.outcome(handle.jobId).state === 'running') await new Promise((r) => setTimeout(r, 0));
    const done = events.flatMap((e) => (e.type === 'job.progress' ? [e.progress.done] : []));
    expect(done.length).toBeGreaterThan(50);
    for (const start of done) {
      // done i was reported at simulated time i * 10 ms, so one second spans 100 calls.
      expect(done.filter((d) => d >= start && d < start + 100).length).toBeLessThanOrEqual(11);
    }
    expect(jobs.outcome(handle.jobId)).toEqual({ state: 'done', result: 'counted' });
    expect(events.at(-1)).toEqual({ type: 'job.done', jobId: handle.jobId });
  });

  it('cancelling an import gives job.cancelled and adds no dataset', async () => {
    const engine = await withProject();
    const before = await engine.getProject();
    const events: EngineEvent[] = [];
    let jobId = '';
    engine.on((e) => {
      events.push(e);
      if (e.type === 'job.progress' && e.jobId === jobId) void engine.cancelJob(jobId);
    });
    const handle = await engine.importFile({
      kind: 'bytes',
      bytes: fixtureBytes('csv_timeseries_gaps_dups_flatline_spike.csv'),
      name: 'series.csv',
    });
    jobId = handle.jobId;
    await expect(awaitJob(engine, handle)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(events.some((e) => e.type === 'job.cancelled' && e.jobId === jobId)).toBe(true);
    const after = await engine.getProject();
    expect(after.datasets).toEqual([]);
    expect(after.originals).toEqual([]);
    expect(after.auditHead).toEqual(before.auditHead);
    expect(await engine.jobOutcome(jobId)).toEqual({ state: 'cancelled' });
  });

  it('keeps the result of a finished job for jobOutcome', async () => {
    const engine = await withProject();
    const handle = await engine.importFile({
      kind: 'bytes',
      bytes: fixtureBytes('csv_pipe_delimited.csv'),
      name: 'pipe.csv',
    });
    const result = await awaitJob<DatasetSummary>(engine, handle);
    const outcome = await engine.jobOutcome(handle.jobId);
    expect(outcome).toEqual({ state: 'done', result });
    expect(result).toMatchObject({ id: 'd1', name: 'pipe' });
    // Cancelling a finished job changes nothing.
    await engine.cancelJob(handle.jobId);
    expect(await engine.jobOutcome(handle.jobId)).toEqual(outcome);
    await expect(engine.jobOutcome('j999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports a failed job with its error', async () => {
    const jobs = new JobManager(fixedClock(START), 100, () => undefined);
    const handle = jobs.start('export', async () => {
      throw new Error('disk full');
    });
    while (jobs.outcome(handle.jobId).state === 'running') await new Promise((r) => setTimeout(r, 0));
    expect(jobs.outcome(handle.jobId)).toMatchObject({ state: 'failed', error: { code: 'INTERNAL' } });
  });

  it('keeps the latest progress in the running outcome', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = new JobManager(fixedClock(START), 100, () => undefined);
    const p: JobProgress = { phase: 'Halfway', done: 5, total: 10, unit: 'rows' };
    const handle = jobs.start('step', async (ctx) => {
      ctx.progress(p);
      await gate;
      return null;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(jobs.outcome(handle.jobId)).toEqual({ state: 'running', progress: p });
    release();
  });
});
