/**
 * Framing for engines in another process (SAD section 4.3, phase A): every message is one line of
 * JSON, and the byte arrays it carries follow that line as raw binary frames, so a 1 GB export is
 * not base64-inflated. The engine protocol's values are plain data; what JSON cannot say directly
 * (byte arrays, `undefined` inside arrays) is written as a marker object under a key no data uses.
 */
import { EngineError } from '@tw/model';
import type { MessagePortLike } from './protocol';

/** A duplex byte stream, such as a child process's stdout and stdin. */
export interface ByteChannel {
  readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): void | Promise<void>;
}

const MARK = '\u0000tw';
const NEWLINE = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type Encoded = null | boolean | number | string | Encoded[] | { [k: string]: Encoded };

function unsendable(what: string): EngineError {
  return new EngineError(
    'INVALID_INPUT',
    `A ${what} cannot be sent to an engine in another process.`,
    'Pass files to such an engine by path or as bytes, and pass only plain data.',
  );
}

function encodeValue(v: unknown, binaries: Uint8Array[]): Encoded {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw unsendable(`number ${String(v)}`);
    return v;
  }
  if (typeof v !== 'object') throw unsendable(typeof v);
  if (v instanceof Uint8Array) {
    binaries.push(v);
    return { [MARK]: 'b', i: binaries.length - 1, n: v.byteLength };
  }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) throw unsendable('binary value other than a Uint8Array');
  if (typeof Blob !== 'undefined' && v instanceof Blob) throw unsendable('Blob');
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? { [MARK]: 'u' } : encodeValue(x, binaries)));
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw unsendable((v as object).constructor?.name ?? 'object');
  const out: { [k: string]: Encoded } = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encodeValue(x, binaries);
  // An object that happens to use the marker key is wrapped, so nothing in the data is misread.
  return MARK in out ? { [MARK]: 'o', v: out } : out;
}

/** One message as bytes: a JSON line, then each binary frame in order. */
export function encodeFrame(message: unknown): Uint8Array {
  const binaries: Uint8Array[] = [];
  const line = encoder.encode(`${JSON.stringify(encodeValue(message, binaries))}\n`);
  const total = binaries.reduce((n, b) => n + b.byteLength, line.byteLength);
  const out = new Uint8Array(total);
  out.set(line, 0);
  let at = line.byteLength;
  for (const b of binaries) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out;
}

interface BinaryMark {
  i: number;
  n: number;
}

function isMarked(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && MARK in v;
}

/** The binary frames a decoded line announces, in frame order. */
function binaryMarks(v: unknown, into: BinaryMark[]): void {
  if (Array.isArray(v)) {
    for (const x of v) binaryMarks(x, into);
    return;
  }
  if (typeof v !== 'object' || v === null) return;
  if (isMarked(v)) {
    if (v[MARK] === 'b') into.push({ i: Number(v['i']), n: Number(v['n']) });
    // An escaped object's own keys are data; only its values can hold markers.
    else if (v[MARK] === 'o') for (const x of Object.values(v['v'] as object)) binaryMarks(x, into);
    return;
  }
  for (const x of Object.values(v)) binaryMarks(x, into);
}

function reviveValue(v: unknown, frames: Uint8Array[]): unknown {
  if (Array.isArray(v)) return v.map((x) => reviveValue(x, frames));
  if (typeof v !== 'object' || v === null) return v;
  if (isMarked(v)) {
    if (v[MARK] === 'b') return frames[Number(v['i'])] ?? new Uint8Array(0);
    if (v[MARK] === 'u') return undefined;
    v = v['v'];
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = reviveValue(x, frames);
  return out;
}

/** Turns a byte stream back into messages, whatever sizes the chunks arrive in. */
export class FrameDecoder {
  private buf = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;
  private scanned = 0;
  private pending: { tree: unknown; marks: BinaryMark[]; need: number } | null = null;

  /** Adds bytes and returns every message they complete. */
  push(chunk: Uint8Array): unknown[] {
    this.append(chunk);
    const out: unknown[] = [];
    for (;;) {
      if (this.pending === null) {
        const nl = this.buf.subarray(this.scanned, this.end).indexOf(NEWLINE);
        if (nl < 0) {
          this.scanned = this.end;
          break;
        }
        const lineEnd = this.scanned + nl;
        const tree: unknown = JSON.parse(decoder.decode(this.buf.subarray(this.start, lineEnd)));
        const marks: BinaryMark[] = [];
        binaryMarks(tree, marks);
        marks.sort((a, b) => a.i - b.i);
        this.pending = { tree, marks, need: marks.reduce((n, m) => n + m.n, 0) };
        this.start = lineEnd + 1;
        this.scanned = this.start;
      }
      const p = this.pending;
      if (this.end - this.start < p.need) break;
      const frames: Uint8Array[] = [];
      let at = this.start;
      for (const m of p.marks) {
        frames[m.i] = this.buf.slice(at, at + m.n);
        at += m.n;
      }
      this.start = at;
      this.scanned = at;
      this.pending = null;
      out.push(reviveValue(p.tree, frames));
    }
    return out;
  }

  /** True when no partial message is waiting for more bytes. */
  get idle(): boolean {
    return this.pending === null && this.start === this.end;
  }

  private append(chunk: Uint8Array): void {
    if (this.start > 0 && this.start === this.end) {
      this.start = this.end = this.scanned = 0;
    }
    if (this.end + chunk.byteLength > this.buf.byteLength) {
      const live = this.end - this.start;
      const size = Math.max(this.buf.byteLength, (live + chunk.byteLength) * 2);
      const next = size === this.buf.byteLength ? this.buf : new Uint8Array(size);
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.scanned -= this.start;
      this.end = live;
      this.start = 0;
      this.buf = next;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.byteLength;
  }
}

/**
 * A MessagePortLike over a byte channel, so the RPC that runs over worker ports runs unchanged
 * over a pipe. `onClose` fires when the stream ends or fails.
 */
export function framedPort(ch: ByteChannel): MessagePortLike & { onClose(cb: (reason: string) => void): void } {
  const listeners = new Set<(e: MessageEvent) => void>();
  const closers: ((reason: string) => void)[] = [];
  let writing: Promise<void> = Promise.resolve();
  let started = false;

  const close = (reason: string) => {
    for (const cb of closers.splice(0)) cb(reason);
  };
  const pump = async () => {
    const reader = ch.readable.getReader();
    const frames = new FrameDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of frames.push(value)) {
          for (const l of [...listeners]) l({ data } as MessageEvent);
        }
      }
      close(frames.idle ? 'the engine closed the connection' : 'the connection ended in the middle of a message');
    } catch (e) {
      close(e instanceof Error ? e.message : String(e));
    } finally {
      reader.releaseLock();
    }
  };
  const start = () => {
    if (started) return;
    started = true;
    void pump();
  };

  return {
    postMessage(msg: unknown) {
      const bytes = encodeFrame(msg);
      writing = writing.then(
        () => ch.write(bytes),
        () => ch.write(bytes),
      );
      writing.catch((e: unknown) => close(e instanceof Error ? e.message : String(e)));
    },
    addEventListener(_type: 'message', l: (e: MessageEvent) => void) {
      listeners.add(l);
      start();
    },
    removeEventListener(_type: 'message', l: (e: MessageEvent) => void) {
      listeners.delete(l);
    },
    start,
    onClose(cb) {
      closers.push(cb);
    },
  };
}
