import { EngineError, type JobHandle, type JobOutcome, type JobProgress } from '@tw/model';
import { describe, expect, it } from 'vitest';
import { fakeEngine, settle, type FakeEngine } from './__fixtures__/fake-engine';
import { EngineClient } from './client';
import type { EngineApi, Transport } from './protocol';
import { inProcessTransport } from './transport';

const JOB: JobHandle = { jobId: 'j1', kind: 'check' };
const PROGRESS: JobProgress = { phase: 'Running checks', done: 5, total: 10, unit: 'rows' };

/** A fake engine whose job state the test sets, behind a transport that counts subscriptions. */
function setup(extra: Partial<EngineApi> = {}): {
  client: EngineClient;
  impl: FakeEngine;
  setOutcome(o: JobOutcome<unknown>): void;
  subscriptions(): number;
} {
  let outcome: JobOutcome<unknown> = { state: 'running', progress: null };
  const impl = fakeEngine({ jobOutcome: async () => outcome, ...extra });
  const inner = inProcessTransport(impl);
  let active = 0;
  const counting: Transport = {
    call: (m, p) => inner.call(m, p),
    onEvent: (cb) => {
      active++;
      const off = inner.onEvent(cb);
      return () => {
        active--;
        off();
      };
    },
    close: () => inner.close(),
  };
  return {
    client: new EngineClient(counting),
    impl,
    setOutcome: (o) => (outcome = o),
    subscriptions: () => active,
  };
}

function callsOf(impl: FakeEngine, method: keyof EngineApi): unknown[][] {
  return impl.calls.filter((c) => c.method === method).map((c) => c.params);
}

async function rejection(p: Promise<unknown>): Promise<EngineError> {
  const e: unknown = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

describe('EngineClient.awaitJob', () => {
  it('resolves on job.done by asking jobOutcome for the result', async () => {
    const { client, impl, setOutcome, subscriptions } = setup();
    const result = client.awaitJob<{ issues: number }>(JOB);
    await settle();
    expect(callsOf(impl, 'jobOutcome')).toEqual([['j1']]);
    setOutcome({ state: 'done', result: { issues: 3 } });
    impl.emit({ type: 'job.done', jobId: 'j1' });
    await expect(result).resolves.toEqual({ issues: 3 });
    expect(callsOf(impl, 'jobOutcome')).toHaveLength(2);
    expect(subscriptions()).toBe(0);
  });

  it('resolves at once for a job that finished before awaitJob was called', async () => {
    const { client, setOutcome } = setup();
    setOutcome({ state: 'done', result: 'early' });
    await expect(client.awaitJob(JOB)).resolves.toBe('early');
  });

  it('rejects with the job error on job.failed', async () => {
    const { client, impl } = setup();
    const result = client.awaitJob(JOB);
    await settle();
    impl.emit({
      type: 'job.failed',
      jobId: 'j1',
      error: { code: 'PARSE_FAILED', message: 'Line 7 is broken.', fix: 'Fix line 7.' },
    });
    const e = await rejection(result);
    expect(e).toMatchObject({ code: 'PARSE_FAILED', message: 'Line 7 is broken.', fix: 'Fix line 7.' });
  });

  it('rejects with CANCELLED on job.cancelled', async () => {
    const { client, impl, subscriptions } = setup();
    const result = client.awaitJob(JOB);
    await settle();
    impl.emit({ type: 'job.cancelled', jobId: 'j1' });
    expect((await rejection(result)).code).toBe('CANCELLED');
    expect(subscriptions()).toBe(0);
  });

  it('rejects when the polled outcome is failed or cancelled', async () => {
    const failed = setup();
    failed.setOutcome({
      state: 'failed',
      error: { code: 'EXPORT_REFUSED', message: 'No geometry.', fix: 'Export as CSV.' },
    });
    expect((await rejection(failed.client.awaitJob(JOB))).code).toBe('EXPORT_REFUSED');
    const cancelled = setup();
    cancelled.setOutcome({ state: 'cancelled' });
    expect((await rejection(cancelled.client.awaitJob(JOB))).code).toBe('CANCELLED');
  });

  it('rejects when the engine does not know the job', async () => {
    const { client } = setup({
      jobOutcome: () =>
        Promise.reject(new EngineError('NOT_FOUND', 'There is no job j1.', 'Choose a job from the Jobs panel.')),
    });
    expect((await rejection(client.awaitJob(JOB))).code).toBe('NOT_FOUND');
  });

  it('passes progress events of its own job to onProgress', async () => {
    const { client, impl, setOutcome } = setup();
    const seen: JobProgress[] = [];
    const result = client.awaitJob(JOB, (p) => seen.push(p));
    await settle();
    impl.emit({ type: 'job.progress', jobId: 'j2', progress: { ...PROGRESS, done: 99 } });
    impl.emit({ type: 'job.progress', jobId: 'j1', progress: PROGRESS });
    impl.emit({ type: 'job.progress', jobId: 'j1', progress: { ...PROGRESS, done: 10 } });
    setOutcome({ state: 'done', result: null });
    impl.emit({ type: 'job.done', jobId: 'j1' });
    await result;
    expect(seen).toEqual([PROGRESS, { ...PROGRESS, done: 10 }]);
  });

  it('reports the progress of the first poll when no progress event has arrived yet', async () => {
    const { client, impl, setOutcome } = setup();
    setOutcome({ state: 'running', progress: PROGRESS });
    const seen: JobProgress[] = [];
    const result = client.awaitJob(JOB, (p) => seen.push(p));
    await settle();
    expect(seen).toEqual([PROGRESS]);
    setOutcome({ state: 'done', result: 1 });
    impl.emit({ type: 'job.done', jobId: 'j1' });
    await expect(result).resolves.toBe(1);
  });

  it('calls cancelJob when the signal is aborted, then settles with the engine verdict', async () => {
    const { client, impl } = setup({
      cancelJob: async (jobId) => {
        impl.emit({ type: 'job.cancelled', jobId });
      },
    });
    const controller = new AbortController();
    const result = client.awaitJob(JOB, undefined, controller.signal);
    await settle();
    expect(callsOf(impl, 'cancelJob')).toEqual([]);
    controller.abort();
    expect((await rejection(result)).code).toBe('CANCELLED');
    expect(callsOf(impl, 'cancelJob')).toEqual([['j1']]);
  });

  it('calls cancelJob at once for a signal that is already aborted', async () => {
    // The first poll goes out after the cancel, so it already sees the cancelled outcome.
    const { client, impl, setOutcome } = setup({
      cancelJob: async () => {
        setOutcome({ state: 'cancelled' });
      },
    });
    const result = rejection(client.awaitJob(JOB, undefined, AbortSignal.abort()));
    expect(callsOf(impl, 'cancelJob')).toEqual([['j1']]);
    expect((await result).code).toBe('CANCELLED');
  });

  it('rejects with PROTOCOL_MISMATCH when the client is closed while it waits, instead of hanging', async () => {
    const { client, subscriptions } = setup();
    const result = rejection(client.awaitJob(JOB));
    // The first poll has answered 'running': no call is in flight, only the event subscription.
    await settle();
    client.close();
    const e = await result;
    expect(e.code).toBe('PROTOCOL_MISMATCH');
    expect(e.message).toContain('j1');
    expect(subscriptions()).toBe(0);
  });

  it('rejects at once when awaitJob is called on a closed client', async () => {
    const { client } = setup();
    client.close();
    expect((await rejection(client.awaitJob(JOB))).code).toBe('PROTOCOL_MISMATCH');
  });

  it('resolves with the result when the job finished before the cancel arrived', async () => {
    const { client, impl, setOutcome } = setup({ cancelJob: async () => undefined });
    const controller = new AbortController();
    const result = client.awaitJob(JOB, undefined, controller.signal);
    await settle();
    setOutcome({ state: 'done', result: 'finished first' });
    controller.abort();
    impl.emit({ type: 'job.done', jobId: 'j1' });
    await expect(result).resolves.toBe('finished first');
  });
});

describe('EngineClient methods', () => {
  it('send the arguments given, leaving out trailing omitted ones', async () => {
    const { client, impl } = setup({ getSchema: async () => ({}) as never, saveProject: async () => JOB });
    await client.getSchema('d1');
    await client.getSchema('d1', 'output');
    await client.saveProject();
    expect(callsOf(impl, 'getSchema')).toEqual([['d1'], ['d1', 'output']]);
    expect(callsOf(impl, 'saveProject')).toEqual([[]]);
  });

  it('close() closes the transport, so later calls are refused', async () => {
    const { client } = setup({ hello: async () => ({}) as never });
    client.close();
    expect((await rejection(client.hello())).code).toBe('PROTOCOL_MISMATCH');
  });
});
