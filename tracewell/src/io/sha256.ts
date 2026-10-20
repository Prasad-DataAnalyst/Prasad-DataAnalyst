/**
 * Incremental SHA-256 (FIPS 180-4) over @noble/hashes, a pure-JavaScript implementation, so the
 * worker, Node and the conformance suite compute identical digests without WebCrypto, whose
 * digest is one-shot and asynchronous.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { utf8, type ByteSource, type Sha256Hex } from '@tw/model';
import { misuse } from './errors';
import { forEachChunk } from './streams';

export interface Sha256 {
  /** Adds bytes to the hash; returns the same hasher so calls can be chained. */
  update(chunk: Uint8Array): Sha256;
  /** Finishes the hash and returns 64 lowercase hex characters; later calls return the same value. */
  hex(): Sha256Hex;
}

export function sha256(): Sha256 {
  const state = nobleSha256.create();
  let digest: Sha256Hex | null = null;
  const hasher: Sha256 = {
    update(chunk: Uint8Array): Sha256 {
      if (digest !== null) throw misuse('Bytes were added to a SHA-256 hash after its digest was taken.');
      state.update(chunk);
      return hasher;
    },
    hex(): Sha256Hex {
      digest ??= bytesToHex(state.digest());
      return digest;
    },
  };
  return hasher;
}

/** One-shot SHA-256; a string is hashed as its UTF-8 bytes. */
export function sha256Hex(data: Uint8Array | string): Sha256Hex {
  return bytesToHex(nobleSha256(typeof data === 'string' ? utf8(data) : data));
}

/**
 * Streams a source through SHA-256. `onBytes` receives the size of each chunk as it is hashed
 * (an increment, not a running total), for progress reporting.
 * Throws EngineError('CANCELLED') when `signal` aborts.
 */
export async function sha256OfSource(
  src: ByteSource,
  onBytes?: (n: number) => void,
  signal?: AbortSignal,
): Promise<Sha256Hex> {
  const hasher = sha256();
  await forEachChunk(
    src.stream(),
    (chunk) => {
      hasher.update(chunk);
      onBytes?.(chunk.byteLength);
    },
    signal,
  );
  return hasher.hex();
}

/**
 * Passes a byte stream through unchanged while adding every chunk to `h`, so a source is hashed in
 * the same pass that parses it. The digest covers all bytes once the returned stream has ended.
 */
export function teeHash(stream: ReadableStream<Uint8Array>, h: Sha256): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Hash before handing the chunk on: the consumer may transfer or reuse its buffer.
        h.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
}
