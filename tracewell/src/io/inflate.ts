/**
 * DEFLATE decompression that never produces more than an expected number of bytes. fflate's
 * one-shot inflateSync grows its output without limit (or, given a buffer, silently truncates while
 * still decoding all input), so a zip bomb with a lying size header would exhaust memory or CPU.
 * Feeding the streaming inflater small slices of input bounds the output of each step and stops
 * as soon as the expected size is passed.
 */
import { Inflate } from 'fflate';

/** Input per step. DEFLATE expands at most about 1,032 times, so one step yields at most ~33 MB. */
const INPUT_SLICE_BYTES = 32_768;
const MAX_DEFLATE_RATIO = 1032;

export type InflateOutcome =
  | { kind: 'ok'; data: Uint8Array }
  /** The data expands to more than the expected size. */
  | { kind: 'oversize' }
  /** The data ends before reaching the expected size. */
  | { kind: 'undersize'; actual: number }
  | { kind: 'corrupt'; reason: string };

class OversizeSignal extends Error {}

/** Inflates raw DEFLATE data that must expand to exactly `expectedSize` bytes. */
export function inflateExact(compressed: Uint8Array, expectedSize: number): InflateOutcome {
  // A header claiming more than the input can possibly expand to must not reserve that memory.
  let out: Uint8Array = new Uint8Array(Math.min(expectedSize, compressed.length * MAX_DEFLATE_RATIO + 1024));
  let written = 0;
  const inflater = new Inflate((chunk) => {
    const needed = written + chunk.length;
    if (needed > expectedSize) throw new OversizeSignal();
    if (needed > out.length) out = grow(out, needed, expectedSize);
    out.set(chunk, written);
    written = needed;
  });
  try {
    pushInSlices(inflater, compressed);
  } catch (e) {
    if (e instanceof OversizeSignal) return { kind: 'oversize' };
    return { kind: 'corrupt', reason: e instanceof Error ? e.message : String(e) };
  }
  if (written !== expectedSize) return { kind: 'undersize', actual: written };
  return { kind: 'ok', data: out };
}

/**
 * Stops at the end of the DEFLATE stream: any bytes after it inside the entry's compressed size are
 * never decoded, so they cannot change the result. Pushing them anyway is a CPU bomb, because
 * fflate appends each push to its pending input and copies all of it again, every time.
 */
function pushInSlices(inflater: Inflate, compressed: Uint8Array): void {
  if (compressed.length === 0) {
    inflater.push(compressed, true);
    return;
  }
  for (let start = 0; start < compressed.length && !streamEnded(inflater); start += INPUT_SLICE_BYTES) {
    const end = Math.min(start + INPUT_SLICE_BYTES, compressed.length);
    inflater.push(compressed.subarray(start, end), end === compressed.length);
  }
}

/**
 * True once the final block is complete. fflate has no public way to ask, so this reads the same
 * state its own decoder tests before skipping input ("final block seen, no block open"). fflate is
 * pinned to an exact version, and zip.test.ts counts pushes, so a change in that state shows up.
 */
function streamEnded(inflater: Inflate): boolean {
  const state = (inflater as unknown as { s?: { f?: number; l?: unknown } }).s;
  return state?.f === 1 && !state.l;
}

function grow(buffer: Uint8Array, needed: number, limit: number): Uint8Array {
  const next = new Uint8Array(Math.min(limit, Math.max(needed, buffer.length * 2)));
  next.set(buffer);
  return next;
}
