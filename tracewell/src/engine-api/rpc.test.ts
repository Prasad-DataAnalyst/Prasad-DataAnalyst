import { EngineError, type JobOutcome } from '@tw/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, fakeEngine, settle, type FakeEngine } from './__fixtures__/fake-engine';
import { EngineClient } from './client';
import type { EngineEvent, EngineInfo, MessagePortLike, Transport } from './protocol';
import { serve } from './serve';
import { createStubEngine } from './stub';
import { inProcessTransport, portTransport, workerTransport } from './transport';

const INFO: EngineInfo = {
  name: 'fake',
  version: '1.0.0',
  protocol: '0.1.0',
  capabilities: {
    formats: ['csv'],
    exportProfiles: ['csv'],
    memoryBudgetBytes: 1,
    spillToDisk: false,
    crsTransform: false,
  },
};

const open: { close(): void }[] = [];

afterEach(() => {
  for (const x of open.splice(0)) x.close();
});

/** serve() on one end of a Node MessageChannel, an EngineClient over portTransport on the other. */
function connect(impl: FakeEngine | ReturnType<typeof createStubEngine>): {
  client: EngineClient;
  transport: Transport;
  stop(): void;
} {
  const channel = new MessageChannel();
  const stop = serve(impl, channel.port1);
  const transport = portTransport(channel.port2);
  open.push(channel.port1, channel.port2, transport);
  return { client: new EngineClient(transport), transport, stop };
}

async function rejection(p: Promise<unknown>): Promise<EngineError> {
  const e: unknown = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

describe('serve() and portTransport over a MessageChannel', () => {
  it('resolves calls with the values the implementation returns', async () => {
    const impl = fakeEngine({ hello: async () => INFO, getSchema: async (id, stage) => ({ id, stage }) as never });
    const { client } = connect(impl);
    await expect(client.hello()).resolves.toEqual(INFO);
    await expect(client.getSchema('d1', 'output')).resolves.toEqual({ id: 'd1', stage: 'output' });
    expect(impl.calls.map((c) => [c.method, c.params])).toEqual([
      ['hello', []],
      ['getSchema', ['d1', 'output']],
    ]);
  });

  it('delivers an EngineError thrown by the implementation with its code, message, fix and detail', async () => {
    const thrown = new EngineError(
      'UNIT_DIMENSION',
      'psia and m3/d measure different things.',
      'Choose a pressure unit.',
      { from: 'psia' },
    );
    const { client } = connect(fakeEngine({ verifyAudit: () => Promise.reject(thrown) }));
    const e = await rejection(client.verifyAudit());
    expect(e.code).toBe('UNIT_DIMENSION');
    expect(e.message).toBe(thrown.message);
    expect(e.fix).toBe(thrown.fix);
    expect(e.detail).toEqual({ from: 'psia' });
  });

  it('turns any other thrown value into an INTERNAL EngineError with a fix', async () => {
    const { client } = connect(
      fakeEngine({
        verifyAudit: () => {
          throw new TypeError('x is undefined');
        },
      }),
    );
    const e = await rejection(client.verifyAudit());
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toContain('x is undefined');
    expect(e.fix.length).toBeGreaterThan(0);
  });

  it('delivers events in the order the implementation emits them', async () => {
    const impl = fakeEngine({});
    const { client } = connect(impl);
    const seen: EngineEvent[] = [];
    client.onEvent((e) => seen.push(e));
    const events: EngineEvent[] = [
      { type: 'job.progress', jobId: 'j1', progress: { phase: 'read', done: 1, total: 3, unit: 'rows' } },
      { type: 'job.progress', jobId: 'j1', progress: { phase: 'read', done: 2, total: 3, unit: 'rows' } },
      { type: 'project.changed', what: ['issues', 'audit'], datasetId: 'd1' },
      { type: 'log', level: 'warn', message: 'careful', at: '2026-10-19T08:00:00.000Z' },
      { type: 'job.done', jobId: 'j1' },
    ];
    for (const e of events) impl.emit(e);
    await vi.waitFor(() => expect(seen).toHaveLength(events.length));
    expect(seen).toEqual(events);
  });

  it('transfers a Uint8Array result, detaching the source buffer', async () => {
    const source = new Uint8Array([7, 8, 9]);
    const outcome: JobOutcome<unknown> = {
      state: 'done',
      result: { fileName: 'a.twp', size: 3, sha256: 'x', bytes: source },
    };
    const { client } = connect(fakeEngine({ jobOutcome: async () => outcome }));
    const received = await client.jobOutcome('j1');
    expect(source.buffer.byteLength).toBe(0);
    expect(received).toMatchObject({ state: 'done', result: { bytes: new Uint8Array([7, 8, 9]) } });
  });

  it('copies rather than transfers a view onto part of a larger buffer', async () => {
    const whole = new Uint8Array([1, 2, 3, 4]);
    const { client } = connect(
      fakeEngine({ jobOutcome: async () => ({ state: 'done', result: whole.subarray(1, 3) }) }),
    );
    await expect(client.jobOutcome('j1')).resolves.toEqual({ state: 'done', result: new Uint8Array([2, 3]) });
    expect(whole.buffer.byteLength).toBe(4);
  });

  it('matches concurrent calls to their answers by id, whatever order the answers come in', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<JobOutcome<unknown>>>>();
    const impl = fakeEngine({
      jobOutcome: (jobId) => {
        const d = deferred<JobOutcome<unknown>>();
        pending.set(jobId, d);
        return d.promise;
      },
    });
    const { client } = connect(impl);
    const calls = ['j1', 'j2', 'j3'].map((id) => client.jobOutcome(id));
    await vi.waitFor(() => expect(pending.size).toBe(3));
    for (const id of ['j3', 'j1', 'j2']) pending.get(id)?.resolve({ state: 'done', result: id });
    await expect(Promise.all(calls)).resolves.toEqual(['j1', 'j2', 'j3'].map((id) => ({ state: 'done', result: id })));
  });

  it('rejects pending calls with PROTOCOL_MISMATCH on close(), and refuses later calls', async () => {
    const impl = fakeEngine({ verifyAudit: () => new Promise(() => undefined) });
    const { client } = connect(impl);
    const call = client.verifyAudit();
    await vi.waitFor(() => expect(impl.calls).toHaveLength(1));
    client.close();
    const e = await rejection(call);
    expect(e.code).toBe('PROTOCOL_MISMATCH');
    expect(e.message).toContain('verifyAudit');
    expect((await rejection(client.hello())).code).toBe('PROTOCOL_MISMATCH');
  });

  it('answers a call to a name outside the protocol with PROTOCOL_MISMATCH', async () => {
    const impl = fakeEngine({});
    const channel = new MessageChannel();
    open.push(channel.port1, channel.port2);
    serve(impl, channel.port1);
    const answer = new Promise<unknown>((resolve) =>
      channel.port2.addEventListener('message', (e) => resolve(e.data), { once: true }),
    );
    channel.port2.start();
    channel.port2.postMessage({ kind: 'call', id: 41, method: 'on', params: [] });
    await expect(answer).resolves.toMatchObject({
      kind: 'result',
      id: 41,
      ok: false,
      error: { code: 'PROTOCOL_MISMATCH' },
    });
    expect(impl.calls).toHaveLength(0);
  });

  it('refuses parameters that cannot cross the boundary, without sending them', async () => {
    const impl = fakeEngine({ getRows: async () => ({}) as never });
    const { client } = connect(impl);
    const e = await rejection(
      client.getRows({ datasetId: 'd1', stage: 'working', offset: 0, limit: 1, columns: [(() => 'c0') as never] }),
    );
    expect(e.code).toBe('INVALID_INPUT');
    expect(impl.calls).toHaveLength(0);
  });

  it('stops forwarding events and answering calls once serve() is stopped', async () => {
    const impl = fakeEngine({ hello: async () => INFO });
    const { client, stop } = connect(impl);
    await expect(client.hello()).resolves.toEqual(INFO);
    stop();
    expect(impl.listenerCount).toBe(0);
    const seen: EngineEvent[] = [];
    client.onEvent((e) => seen.push(e));
    impl.emit({ type: 'job.done', jobId: 'j1' });
    let answered = false;
    // close() in afterEach rejects this call; only an answer before then would be a failure.
    void client.hello().then(
      () => (answered = true),
      () => undefined,
    );
    await settle();
    await settle();
    expect(seen).toEqual([]);
    expect(answered).toBe(false);
  });

  it('carries the stub engine end to end', async () => {
    const { client } = connect(createStubEngine());
    const project = await client.getProject();
    expect(project.datasets).toHaveLength(1);
    const handle = await client.runChecks('d1');
    await expect(client.awaitJob(handle)).resolves.toMatchObject({ datasetId: 'd1', issues: 3 });
  });
});

/** The part of a Worker that workerTransport uses, driven by the test. */
class FakeWorker extends EventTarget {
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  answer(msg: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: msg }));
  }
}

describe('workerTransport', () => {
  it('sends requests to the worker and resolves them from its answers', async () => {
    const worker = new FakeWorker();
    const transport = workerTransport(worker as unknown as Worker);
    const call = transport.call('hello', []);
    expect(worker.posted).toEqual([{ kind: 'call', id: 1, method: 'hello', params: [] }]);
    worker.answer({ kind: 'result', id: 1, ok: true, value: INFO });
    await expect(call).resolves.toEqual(INFO);
    transport.close();
  });

  it('rejects waiting calls when the worker reports an error, and stays usable', async () => {
    const worker = new FakeWorker();
    const transport = workerTransport(worker as unknown as Worker);
    const call = transport.call('hello', []);
    // Node has no ErrorEvent; workerTransport reads only its message.
    worker.dispatchEvent(Object.assign(new Event('error'), { message: 'script failed to load' }));
    const e = await rejection(call);
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toContain('script failed to load');
    const next = transport.call('hello', []);
    worker.answer({ kind: 'result', id: 2, ok: true, value: INFO });
    await expect(next).resolves.toEqual(INFO);
    transport.close();
  });

  it('terminates the worker on close() and rejects what is still waiting', async () => {
    const worker = new FakeWorker();
    const transport = workerTransport(worker as unknown as Worker);
    const call = transport.call('verifyAudit', []);
    transport.close();
    expect(worker.terminated).toBe(true);
    expect((await rejection(call)).code).toBe('PROTOCOL_MISMATCH');
  });
});

describe('inProcessTransport', () => {
  it('reports errors and events as a worker boundary would', async () => {
    const impl = fakeEngine({
      cancelJob: async () => {
        impl.emit({ type: 'job.cancelled', jobId: 'j9' });
        throw new EngineError('NOT_FOUND', 'There is no job j9.', 'Choose a job from the Jobs panel.');
      },
    });
    const transport = inProcessTransport(impl);
    const seen: EngineEvent[] = [];
    transport.onEvent((e) => seen.push(e));
    const e = await rejection(transport.call('cancelJob', ['j9']));
    expect(e).toMatchObject({ code: 'NOT_FOUND', fix: 'Choose a job from the Jobs panel.' });
    expect(seen).toEqual([{ type: 'job.cancelled', jobId: 'j9' }]);
    transport.close();
    expect(impl.listenerCount).toBe(0);
  });

  it('answers a name outside the protocol with PROTOCOL_MISMATCH without touching the engine, as serve() does', async () => {
    const impl = fakeEngine({});
    const transport = inProcessTransport(impl);
    for (const name of ['on', 'constructor', 'toString']) {
      const e = await rejection(transport.call(name as never, []));
      expect(e.code).toBe('PROTOCOL_MISMATCH');
      expect(e.message).toContain(name);
    }
    // Only the transport's own subscription: `on` was not called with a missing callback.
    expect(impl.listenerCount).toBe(1);
    transport.close();
  });

  it('rejects pending calls with PROTOCOL_MISMATCH on close()', async () => {
    const transport = inProcessTransport(fakeEngine({ verifyAudit: () => new Promise(() => undefined) }));
    const call = transport.call('verifyAudit', []);
    transport.close();
    expect((await rejection(call)).code).toBe('PROTOCOL_MISMATCH');
  });

  it('transfers byte arrays in results, as postMessage would', async () => {
    const source = new Uint8Array([1, 2]);
    const transport = inProcessTransport(fakeEngine({ jobOutcome: async () => ({ state: 'done', result: source }) }));
    await expect(transport.call('jobOutcome', ['j1'])).resolves.toEqual({
      state: 'done',
      result: new Uint8Array([1, 2]),
    });
    expect(source.buffer.byteLength).toBe(0);
    transport.close();
  });
});

// The MessagePortLike contract is what Worker, MessagePort and the worker global scope share.
const _portsFit: MessagePortLike[] = [new MessageChannel().port1];
void _portsFit;
