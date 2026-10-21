import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { EngineError, utf8, type ByteSource } from '@tw/model';
import { sha256Hex } from './sha256';
import { blobSource, bytesSource, memorySink, STREAM_CHUNK_BYTES } from './source';

function sequence(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => i % 251);
}

async function chunksOf(src: ByteSource): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of src.stream()) chunks.push(chunk);
  return chunks;
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const DATA = sequence(3 * STREAM_CHUNK_BYTES + 123);

describe.each([
  ['bytesSource', (): ByteSource => bytesSource(DATA, 'wells.csv')],
  ['blobSource', (): ByteSource => blobSource(new Blob([DATA.slice()]), 'wells.csv')],
])('%s', (_label, make) => {
  it('reports its name and size', () => {
    const src = make();
    expect(src.name).toBe('wells.csv');
    expect(src.size).toBe(DATA.length);
  });

  it('slices exact byte ranges', async () => {
    const src = make();
    expect(await src.slice(10, 20)).toEqual(DATA.slice(10, 20));
    expect(await src.slice(0, src.size)).toEqual(DATA);
  });

  it.each([
    ['a negative start', -5, 4, 0, 4],
    ['an end past the size', DATA.length - 3, DATA.length + 100, DATA.length - 3, DATA.length],
    ['an infinite end', 7, Number.POSITIVE_INFINITY, 7, DATA.length],
    ['an end before the start', 20, 10, 20, 20],
    ['fractional offsets', 1.9, 4.2, 1, 4],
  ])('clamps %s', async (_case, start, end, from, to) => {
    expect(await make().slice(start, end)).toEqual(DATA.slice(from, to));
  });

  it('refuses NaN offsets', async () => {
    const error: unknown = await Promise.resolve()
      .then(() => make().slice(Number.NaN, 3))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('INVALID_INPUT');
  });

  it('streams every byte, and can be streamed more than once', async () => {
    const src = make();
    expect(join(await chunksOf(src))).toEqual(DATA);
    expect(join(await chunksOf(src))).toEqual(DATA);
  });
});

describe('bytesSource', () => {
  it('streams in chunks of at most 64 KiB', async () => {
    const chunks = await chunksOf(bytesSource(DATA, 'x'));
    expect(chunks.map((c) => c.length)).toEqual([STREAM_CHUNK_BYTES, STREAM_CHUNK_BYTES, STREAM_CHUNK_BYTES, 123]);
  });

  it('hands out copies, so a consumer that changes or transfers them leaves the source intact', async () => {
    const original = sequence(1000);
    const src = bytesSource(original, 'x');
    (await src.slice(0, 1000)).fill(0);
    const [chunk] = await chunksOf(src);
    chunk?.fill(0);
    expect(original).toEqual(sequence(1000));
  });

  it('hands out copies of a Node Buffer too, whose own slice() shares memory', async () => {
    const original = Buffer.from(sequence(1000));
    const src = bytesSource(original, 'x');
    (await src.slice(0, 1000)).fill(0);
    const [chunk] = await chunksOf(src);
    chunk?.fill(0);
    expect(new Uint8Array(original)).toEqual(sequence(1000));
  });

  it('streams an empty source as no chunks', async () => {
    expect(await chunksOf(bytesSource(new Uint8Array(0), 'empty'))).toEqual([]);
  });
});

describe('blobSource', () => {
  it("takes a File's name by default", () => {
    const file = new File(['a,b\n'], 'daily.csv');
    expect(blobSource(file).name).toBe('daily.csv');
    expect(blobSource(file, 'renamed.csv').name).toBe('renamed.csv');
  });

  it('names a plain Blob "untitled" when no name is given', () => {
    expect(blobSource(new Blob(['x'])).name).toBe('untitled');
  });
});

describe('memorySink', () => {
  it('collects what is written and reports its size and SHA-256 on close', async () => {
    const sink = memorySink();
    await sink.write(utf8('well,rate\n'));
    await sink.write(utf8('A-1,42\n'));
    const expected = utf8('well,rate\nA-1,42\n');
    expect(await sink.close()).toEqual({ size: expected.length, sha256: sha256Hex(expected) });
    expect(sink.bytes()).toEqual(expected);
  });

  it('copies each chunk, so a writer may reuse its buffer', async () => {
    const sink = memorySink();
    const buffer = utf8('aaaa');
    await sink.write(buffer);
    buffer.fill(0x62);
    await sink.write(buffer);
    expect(new TextDecoder().decode(sink.bytes())).toBe('aaaabbbb');
    expect((await sink.close()).sha256).toBe(sha256Hex('aaaabbbb'));
  });

  it('copies a Node Buffer chunk too, so its bytes still match the SHA-256 it reports', async () => {
    const sink = memorySink();
    const buffer = Buffer.from('aaaa');
    await sink.write(buffer);
    buffer.fill(0x62);
    expect(new TextDecoder().decode(sink.bytes())).toBe('aaaa');
    expect((await sink.close()).sha256).toBe(sha256Hex('aaaa'));
  });

  it('returns what has been written so far, without later writes changing an earlier result', async () => {
    const sink = memorySink();
    await sink.write(utf8('ab'));
    const early = sink.bytes();
    await sink.write(utf8('cd'));
    expect(new TextDecoder().decode(early)).toBe('ab');
    expect(new TextDecoder().decode(sink.bytes())).toBe('abcd');
  });

  it('gives the same result from repeated close calls and an empty sink', async () => {
    const sink = memorySink();
    const first = await sink.close();
    expect(first).toEqual({ size: 0, sha256: sha256Hex('') });
    expect(await sink.close()).toEqual(first);
    expect(sink.bytes()).toEqual(new Uint8Array(0));
  });

  it('refuses writes after close', async () => {
    const sink = memorySink();
    await sink.close();
    await expect(sink.write(utf8('late'))).rejects.toBeInstanceOf(EngineError);
  });
});
