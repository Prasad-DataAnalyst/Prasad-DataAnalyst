import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineClient } from './client';
import { FrameDecoder, encodeFrame, type ByteChannel } from './framing';
import { serveStdio } from './serve';
import { createStubEngine } from './stub';
import { stdioTransport } from './transport';

function roundTrip(message: unknown): unknown {
  const out = new FrameDecoder().push(encodeFrame(message));
  expect(out).toHaveLength(1);
  return out[0];
}

/** Two byte channels joined back to back, as a child process's pipes would be. */
function pipePair(): { client: ByteChannel; engine: ByteChannel; closeEngineSide(): Promise<void> } {
  const toEngine = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const clientWriter = toEngine.writable.getWriter();
  const engineWriter = toClient.writable.getWriter();
  return {
    client: { readable: toClient.readable, write: (b) => clientWriter.write(b) },
    engine: { readable: toEngine.readable, write: (b) => engineWriter.write(b) },
    closeEngineSide: () => engineWriter.close(),
  };
}

describe('framing', () => {
  it('round-trips byte arrays as binary frames after the JSON line', () => {
    const bytes = Uint8Array.from([0, 10, 13, 255, 10]);
    const msg = {
      kind: 'call',
      id: 7,
      params: [{ kind: 'bytes', bytes, name: 'a.csv' }, { nested: [new Uint8Array(0), bytes] }],
    };
    const frame = encodeFrame(msg);
    const newline = frame.indexOf(10);
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(0, newline)))).toMatchObject({ kind: 'call', id: 7 });
    expect(frame.byteLength).toBe(newline + 1 + 5 + 0 + 5);
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('keeps undefined inside arrays, drops undefined properties, and keeps text exactly', () => {
    expect(roundTrip({ params: ['d1', undefined, 3] })).toEqual({ params: ['d1', undefined, 3] });
    expect(roundTrip({ a: 1, b: undefined })).toEqual({ a: 1 });
    const text = 'émission ° Förderrate 🛢️ "q" \\ \n ';
    expect(roundTrip({ text })).toEqual({ text });
  });

  it('does not misread data that uses the marker key', () => {
    const tricky = { '\u0000tw': 'b', i: 0, n: 3, inner: { '\u0000tw': 'u' } };
    expect(roundTrip({ value: tricky })).toEqual({ value: tricky });
  });

  it('decodes messages split at any byte, and several in one chunk', () => {
    const a = { id: 1, bytes: Uint8Array.from([1, 2, 3, 10, 4]) };
    const b = { id: 2, text: 'second\nline' };
    const all = new Uint8Array([...encodeFrame(a), ...encodeFrame(b), ...encodeFrame(a)]);
    const byteByByte = new FrameDecoder();
    const got: unknown[] = [];
    for (const x of all) got.push(...byteByByte.push(Uint8Array.of(x)));
    expect(got).toEqual([a, b, a]);
    expect(byteByByte.idle).toBe(true);
    expect(new FrameDecoder().push(all)).toEqual([a, b, a]);
  });

  it('refuses values another process cannot receive', () => {
    expect(() => encodeFrame({ x: Number.NaN })).toThrow(/cannot be sent/);
    expect(() => encodeFrame({ b: new Blob(['x']) })).toThrow(/Blob/);
    expect(() => encodeFrame({ d: new Date(0) })).toThrow(/cannot be sent/);
    expect(() => encodeFrame({ f: new Float64Array(2) })).toThrow(/Uint8Array/);
  });

  it('round-trips any JSON-like value with byte arrays (property)', () => {
    const leaf = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
      fc.string(),
      fc.uint8Array({ maxLength: 40 }),
    );
    const value = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small' },
        leaf,
        fc.array(tie('node'), { maxLength: 4 }),
        fc.dictionary(fc.string(), tie('node'), { maxKeys: 4 }),
      ),
    })).node;
    fc.assert(
      fc.property(value, fc.integer({ min: 1, max: 7 }), (v, step) => {
        const frame = encodeFrame({ v });
        const d = new FrameDecoder();
        const out: unknown[] = [];
        for (let i = 0; i < frame.byteLength; i += step) out.push(...d.push(frame.subarray(i, i + step)));
        expect(out).toEqual([{ v }]);
      }),
      { numRuns: 300 },
    );
  });
});

describe('stdioTransport', () => {
  it('drives an engine served over a pipe, jobs and events included', async () => {
    const pipes = pipePair();
    serveStdio(createStubEngine(), pipes.engine);
    const client = new EngineClient(stdioTransport(pipes.client));
    const info = await client.hello();
    expect(info.protocol).toMatch(/^0\./);
    const events: string[] = [];
    client.onEvent((e) => events.push(e.type));
    const file = { kind: 'bytes' as const, bytes: new TextEncoder().encode('a,b\n1,2\n'), name: 'tiny.csv' };
    const preview = await client.sniff(file);
    expect(preview.fileName).toBe('tiny.csv');
    const summary = await client.awaitJob<{ id: string }>(await client.importFile(file));
    expect(summary.id).toMatch(/^d\d+$/);
    expect(events).toContain('job.done');
    await expect(client.getSchema('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    client.close();
  });

  it('rejects waiting calls when the engine side closes', async () => {
    const pipes = pipePair();
    const client = new EngineClient(stdioTransport(pipes.client));
    const waiting = client.hello();
    await pipes.closeEngineSide();
    await expect(waiting).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('stopped') });
  });
});
