import { describe, expect, it } from 'vitest';
import { EngineError, utf8 } from '@tw/model';
import { MESSY_READY, messyBytes, messySums } from './__fixtures__/messy';
import { blobSource, bytesSource } from './source';
import { sha256, sha256Hex, sha256OfSource, teeHash } from './sha256';

/** Deterministic pseudo-random bytes (a linear congruential generator), so failures reproduce. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

function hashInChunks(data: Uint8Array, chunkSize: number): string {
  const h = sha256();
  for (let i = 0; i < data.length; i += chunkSize) h.update(data.subarray(i, i + chunkSize));
  return h.hex();
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

describe('SHA-256 NIST test vectors (FIPS 180-4 examples)', () => {
  it.each([
    ['the empty message', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ["'abc'", 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'the 448-bit message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'the 896-bit message',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ])('hashes %s', (_label, message, expected) => {
    expect(sha256Hex(message)).toBe(expected);
    expect(sha256Hex(utf8(message))).toBe(expected);
    expect(sha256().update(utf8(message)).hex()).toBe(expected);
  });

  it("hashes one million repetitions of 'a', one-shot and incrementally", () => {
    const expected = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';
    const message = new Uint8Array(1_000_000).fill(0x61);
    expect(sha256Hex(message)).toBe(expected);
    expect(hashInChunks(message, 1000)).toBe(expected);
  });
});

describe('sha256 (incremental)', () => {
  const data = noise(200_003);
  const oneShot = sha256Hex(data);

  it.each([1, 7, 65_536])('gives the one-shot digest when fed in chunks of %i bytes', (chunkSize) => {
    expect(hashInChunks(data, chunkSize)).toBe(oneShot);
  });

  it('returns the same hasher from update, so calls chain', () => {
    const h = sha256();
    expect(h.update(data.subarray(0, 10))).toBe(h);
  });

  it('returns the same digest from repeated hex() calls', () => {
    const h = sha256().update(data);
    expect(h.hex()).toBe(oneShot);
    expect(h.hex()).toBe(oneShot);
  });

  it('refuses bytes added after the digest was taken', () => {
    const h = sha256();
    h.hex();
    expect(() => h.update(data)).toThrow(EngineError);
    expect(() => h.update(data)).toThrow(/after its digest was taken/);
  });

  it('hashes strings as UTF-8, including characters outside the BMP', () => {
    const text = 'Temp \u00b0C, cost \u20ac, well \u{1f6e2}';
    expect(sha256Hex(text)).toBe(sha256Hex(new TextEncoder().encode(text)));
  });

  it('gives 64 lowercase hex characters', () => {
    expect(sha256Hex(data)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256OfSource', () => {
  const data = noise(300_001, 7);

  it('equals the one-shot digest of the same bytes and reports every byte', async () => {
    const reported: number[] = [];
    const digest = await sha256OfSource(bytesSource(data, 'noise.bin'), (n) => reported.push(n));
    expect(digest).toBe(sha256Hex(data));
    expect(reported.reduce((a, b) => a + b, 0)).toBe(data.length);
    expect(reported.length).toBeGreaterThan(1);
  });

  it('hashes a Blob source', async () => {
    const blob = new Blob([data.slice()]);
    expect(await sha256OfSource(blobSource(blob, 'noise.bin'))).toBe(sha256Hex(data));
  });

  it('hashes an empty source', async () => {
    expect(await sha256OfSource(bytesSource(new Uint8Array(0), 'empty'))).toBe(sha256Hex(''));
  });

  it('is cancelled by an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(sha256OfSource(bytesSource(data, 'noise.bin'), undefined, controller.signal));
    expect(error.code).toBe('CANCELLED');
  });

  it('stops part-way when the signal aborts during hashing', async () => {
    const controller = new AbortController();
    let seen = 0;
    const onBytes = (n: number): void => {
      seen += n;
      controller.abort();
    };
    const error = await rejection(sha256OfSource(bytesSource(data, 'noise.bin'), onBytes, controller.signal));
    expect(error.code).toBe('CANCELLED');
    expect(seen).toBeLessThan(data.length);
  });

  it.skipIf(!MESSY_READY)('matches fixtures/messy/SHA256SUMS for csv_utf8_bom_crlf.csv', async () => {
    const name = 'csv_utf8_bom_crlf.csv';
    const expected = messySums().get(name);
    expect(expected, `${name} is listed in SHA256SUMS`).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256OfSource(bytesSource(messyBytes(name), name))).toBe(expected);
  });
});

describe('teeHash', () => {
  it('passes every byte through unchanged and hashes them on the way', async () => {
    const data = noise(150_000, 3);
    const h = sha256();
    const out = await collect(teeHash(bytesSource(data, 'noise.bin').stream(), h));
    expect(out).toEqual(data);
    expect(h.hex()).toBe(sha256Hex(data));
  });
});
