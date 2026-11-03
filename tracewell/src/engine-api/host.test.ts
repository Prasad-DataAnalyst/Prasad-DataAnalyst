import { describe, expect, it } from 'vitest';
import { EngineClient } from './client';
import { hostTransport, type EngineHost } from './host';
import { serveStdio } from './serve';
import type { EngineImpl } from './protocol';
import { createStubEngine } from './stub';
import { stdioTransport } from './transport';

/**
 * A container serving the stub engine over a pipe, as the test harness serves the native engine:
 * what the engine writes reaches the page `piece` bytes at a time, however it was written.
 */
function servedHost(piece = Number.POSITIVE_INFINITY): EngineHost {
  const toEngine = new TransformStream<Uint8Array, Uint8Array>();
  const toPage = new TransformStream<Uint8Array, Uint8Array>();
  const engineWriter = toPage.writable.getWriter();
  const pageWriter = toEngine.writable.getWriter();
  serveStdio(createStubEngine(), { readable: toEngine.readable, write: (b) => engineWriter.write(b) });
  const reader = toPage.readable.getReader();
  let held: Uint8Array = new Uint8Array(0);
  return {
    open: () => Promise.resolve(),
    write: (bytes) => pageWriter.write(bytes),
    read: async () => {
      if (held.byteLength === 0) {
        const r = await reader.read();
        if (r.done) return null;
        held = r.value;
      }
      const out = held.subarray(0, Math.min(piece, held.byteLength));
      held = held.subarray(out.byteLength);
      return out;
    },
  };
}

const tiny = () => ({ kind: 'blob' as const, blob: new Blob(['a,b\n1,2\n']), name: 'tiny.csv' });

describe('hostTransport', () => {
  it('drives an engine its container serves, jobs and events included', async () => {
    const client = new EngineClient(hostTransport(servedHost()));
    expect((await client.hello()).protocol).toMatch(/^0\./);
    const events: string[] = [];
    client.onEvent((e) => events.push(e.type));
    const summary = await client.awaitJob<{ id: string }>(await client.importFile(tiny()));
    expect(summary.id).toMatch(/^d\d+$/);
    expect(events).toContain('job.done');
    await expect(client.getSchema('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    client.close();
  });

  it('sends a file the page holds as a Blob as its bytes, which a pipe can carry', async () => {
    // An engine that records what it is given.
    const seen: unknown[] = [];
    const recorder = {
      on: () => () => undefined,
      sniff: (file: unknown) => {
        seen.push(file);
        return Promise.resolve({ fileName: 'tiny.csv' });
      },
    } as unknown as EngineImpl;
    const toEngine = new TransformStream<Uint8Array, Uint8Array>();
    const toPage = new TransformStream<Uint8Array, Uint8Array>();
    const engineWriter = toPage.writable.getWriter();
    const pageWriter = toEngine.writable.getWriter();
    serveStdio(recorder, { readable: toEngine.readable, write: (b) => engineWriter.write(b) });
    const reader = toPage.readable.getReader();
    const host: EngineHost = {
      open: () => Promise.resolve(),
      write: (bytes) => pageWriter.write(bytes),
      read: async () => {
        const r = await reader.read();
        return r.done ? null : r.value;
      },
    };
    await new EngineClient(hostTransport(host)).sniff(tiny());
    expect(seen).toEqual([{ kind: 'bytes', name: 'tiny.csv', bytes: new TextEncoder().encode('a,b\n1,2\n') }]);
    // Over a bare pipe the Blob itself cannot be sent.
    const bare = { readable: new ReadableStream<Uint8Array>(), write: () => undefined };
    await expect(new EngineClient(stdioTransport(bare)).sniff(tiny())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('reads answers that arrive in pieces of any size', async () => {
    for (const piece of [1, 3, 64]) {
      const client = new EngineClient(hostTransport(servedHost(piece)));
      expect((await client.sniff(tiny())).fileName, `pieces of ${piece}`).toBe('tiny.csv');
      client.close();
    }
  });

  it('rejects waiting calls when the engine stops', async () => {
    let end: (v: null) => void = () => undefined;
    const host: EngineHost = {
      open: () => Promise.resolve(),
      write: () => Promise.resolve(),
      read: () =>
        new Promise((resolve) => {
          end = resolve;
        }),
    };
    const client = new EngineClient(hostTransport(host));
    const waiting = client.hello();
    await Promise.resolve();
    end(null);
    await expect(waiting).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('stopped') });
  });
});
