import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineError } from '@tw/model';
import { nodeFileSource, nodeFs } from './node';
import { sha256Hex, sha256OfSource } from './sha256';

const dir = mkdtempSync(join(tmpdir(), 'tracewell-io-node-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DATA = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) % 256);
const FILE = join(dir, 'wells daily.csv');
writeFileSync(FILE, DATA);

async function failure(promise: Promise<unknown>): Promise<EngineError> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

describe('nodeFileSource', () => {
  it('reports the file name and size', async () => {
    const src = await nodeFileSource(FILE);
    expect(src.name).toBe('wells daily.csv');
    expect(src.size).toBe(DATA.length);
  });

  it('slices byte ranges, clamped to the file', async () => {
    const src = await nodeFileSource(FILE);
    expect(await src.slice(100, 200)).toEqual(DATA.slice(100, 200));
    expect(await src.slice(DATA.length - 10, DATA.length + 10)).toEqual(DATA.slice(DATA.length - 10));
    expect(await src.slice(-1, 0)).toEqual(new Uint8Array(0));
  });

  it('streams the whole file as plain Uint8Array chunks', async () => {
    const src = await nodeFileSource(FILE);
    const chunks: Uint8Array[] = [];
    for await (const chunk of src.stream()) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(Object.getPrototypeOf(chunk)).toBe(Uint8Array.prototype);
    expect(await sha256OfSource(src)).toBe(sha256Hex(DATA));
  });

  it('can be cancelled part-way through a stream', async () => {
    const reader = (await nodeFileSource(FILE)).stream().getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
  });

  it('reports a missing file or a directory as NOT_FOUND', async () => {
    expect((await failure(nodeFileSource(join(dir, 'missing.csv')))).code).toBe('NOT_FOUND');
    expect((await failure(nodeFileSource(dir))).code).toBe('NOT_FOUND');
  });
});

describe('nodeFs', () => {
  it('writes and reads back whole files as plain Uint8Arrays', async () => {
    const fs = nodeFs();
    const path = join(dir, 'out.bin');
    await fs.writeFile(path, DATA);
    const back = await fs.readFile(path);
    expect(Object.getPrototypeOf(back)).toBe(Uint8Array.prototype);
    expect(back).toEqual(DATA);
  });

  it('reads small files as arrays that own their memory', async () => {
    const path = join(dir, 'small.txt');
    writeFileSync(path, 'abc');
    const back = await nodeFs().readFile(path);
    expect(back.byteOffset).toBe(0);
    expect(back.buffer.byteLength).toBe(3);
  });

  it('reports a missing file as NOT_FOUND', async () => {
    expect((await failure(nodeFs().readFile(join(dir, 'missing.bin')))).code).toBe('NOT_FOUND');
  });
});
