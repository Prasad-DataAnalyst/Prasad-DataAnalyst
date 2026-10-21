/**
 * ByteSource and ByteSink implementations that work the same in the browser worker and in Node:
 * over a Blob (a File picked by the user), over bytes already in memory, and into memory.
 */
import type { ByteSink, ByteSource, Sha256Hex } from '@tw/model';
import { copyBytes } from './bytes';
import { invalidArgument, misuse } from './errors';
import { sha256 } from './sha256';
import { chunkedStream } from './streams';

/** Chunk size of in-memory streams; the same as Node's file streams, so consumers see similar batches. */
export const STREAM_CHUNK_BYTES = 65_536;

const UNNAMED = 'untitled';

/**
 * Turns a requested [start, end) range into offsets inside a source of `size` bytes. Out-of-range
 * offsets are clamped, so `slice(0, Infinity)` reads everything; unlike Blob.slice, negative
 * offsets are not counted from the end, because a negative offset here is always a bug upstream.
 */
export function clampRange(start: number, end: number, size: number): [number, number] {
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw invalidArgument('A byte range offset is not a number.', { start: String(start), end: String(end) });
  }
  const from = Math.min(Math.max(Math.trunc(start), 0), size);
  const to = Math.min(Math.max(Math.trunc(end), from), size);
  return [from, to];
}

function blobName(blob: Blob): string | undefined {
  // A File carries the name the user picked; a plain Blob has none.
  const name: unknown = (blob as { name?: unknown }).name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** A source over a Blob or File. `name` defaults to the File's name. */
export function blobSource(blob: Blob, name?: string): ByteSource {
  const size = blob.size;
  return {
    name: name ?? blobName(blob) ?? UNNAMED,
    size,
    async slice(start: number, end: number): Promise<Uint8Array> {
      const [from, to] = clampRange(start, end, size);
      return new Uint8Array(await blob.slice(from, to).arrayBuffer());
    },
    stream: () => blob.stream(),
  };
}

/**
 * A source over bytes in memory. Slices and stream chunks are copies, so a consumer may transfer
 * them to another thread; the bytes themselves must not change while the source is in use.
 */
export function bytesSource(bytes: Uint8Array, name: string): ByteSource {
  return {
    name,
    size: bytes.byteLength,
    slice(start: number, end: number): Promise<Uint8Array> {
      const [from, to] = clampRange(start, end, bytes.byteLength);
      return Promise.resolve(copyBytes(bytes, from, to));
    },
    stream: () => chunkedStream(bytes, STREAM_CHUNK_BYTES),
  };
}

/**
 * A sink that collects everything written into memory and hashes it on the way in. `bytes()`
 * returns what has been written so far; the array it returns is never changed by later writes.
 */
export function memorySink(): ByteSink & { bytes(): Uint8Array } {
  let chunks: Uint8Array[] = [];
  let size = 0;
  const hasher = sha256();
  let result: { size: number; sha256: Sha256Hex } | null = null;

  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (result !== null) throw misuse('Bytes were written to a sink after it was closed.');
      // Copied because writers commonly reuse one buffer for every chunk they produce.
      const copy = copyBytes(chunk);
      chunks.push(copy);
      size += copy.byteLength;
      hasher.update(copy);
    },
    async close(): Promise<{ size: number; sha256: Sha256Hex }> {
      result ??= { size, sha256: hasher.hex() };
      return { ...result };
    },
    bytes(): Uint8Array {
      // Compacted into one chunk so repeated calls do not concatenate again.
      if (chunks.length !== 1) chunks = [concat(chunks, size)];
      return chunks[0] ?? new Uint8Array(0);
    },
  };
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
