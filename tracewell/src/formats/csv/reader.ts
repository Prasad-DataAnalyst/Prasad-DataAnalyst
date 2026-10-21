/**
 * The CSV/TSV Importer. read() streams the file: bytes are counted for progress, decoded with the
 * chosen encoding, tokenized and shaped into rows, and handed out in batches of BATCH_ROWS. Only
 * one batch and one chunk of text are held at a time, so file size is bounded by the table the
 * caller builds, not by this reader.
 */
import { decodeStream } from '@tw/io';
import {
  BATCH_ROWS,
  type ByteSource,
  type FormatOptions,
  type Importer,
  type RawBatch,
  type RawRow,
  type ReadContext,
} from '@tw/model';
import { throwIfAborted } from './errors';
import { csvOptionsOf } from './options';
import { sniffCsvSource } from './sniff';
import { TableStream } from './table';

/** Cancelling a stream that already ended or failed rejects; there is nothing left to release. */
function ignore(): void {}

interface CountedBytes {
  stream: ReadableStream<Uint8Array>;
  /** Cancels the source at once. Cancelling through the decoder reaches it only some ticks later. */
  release(): Promise<void>;
}

/** The source's bytes, each chunk reported to `onBytes` before the BOM is skipped. */
function countedBytes(src: ByteSource, onBytes: (n: number) => void): CountedBytes {
  const reader = src.stream().getReader();
  let released = false;
  const release = async (reason?: unknown): Promise<void> => {
    if (released) return;
    released = true;
    await reader.cancel(reason).catch(ignore);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (released) return;
        if (done) {
          controller.close();
          return;
        }
        onBytes(value.byteLength);
        controller.enqueue(value);
      },
      cancel: release,
    },
    { highWaterMark: 0 },
  );
  return { stream, release };
}

/**
 * Reads the next chunk of text. A read that fails because the signal cancelled the stream is
 * reported as CANCELLED, not as the stream's own error.
 */
async function nextText(reader: ReadableStreamDefaultReader<string>, signal: AbortSignal): Promise<string | null> {
  let result: ReadableStreamReadResult<string>;
  try {
    result = await reader.read();
  } catch (e) {
    throwIfAborted(signal);
    throw e;
  }
  throwIfAborted(signal);
  return result.done ? null : result.value;
}

/** Collects rows and hands out full batches. */
class Batcher {
  #rows: RawRow[] = [];

  /** Adds rows and returns the batches they completed. */
  add(rows: readonly RawRow[]): RawBatch[] {
    const full: RawBatch[] = [];
    for (const row of rows) {
      this.#rows.push(row);
      if (this.#rows.length === BATCH_ROWS) full.push(this.#take());
    }
    return full;
  }

  /** The last, partly filled batch, or none. */
  rest(): RawBatch[] {
    return this.#rows.length === 0 ? [] : [this.#take()];
  }

  #take(): RawBatch {
    const batch = { rows: this.#rows };
    this.#rows = [];
    return batch;
  }
}

async function* readCsv(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  const csv = csvOptionsOf(opts);
  const { signal } = ctx;
  throwIfAborted(signal);
  const table = new TableStream(
    { dialect: { delimiter: csv.delimiter, quote: csv.quote }, skipLines: csv.skipLines, headerRows: csv.headerRows },
    (n) => ctx.note(n),
  );
  const bytes = countedBytes(src, (n) => ctx.onBytes(n));
  const reader = decodeStream(bytes.stream, csv.encoding, csv.bomLength).getReader();
  // Cancelling wakes a read that is waiting on a slow source, so a cancel takes effect at once.
  const onAbort = (): void => {
    reader.cancel().catch(ignore);
    bytes.release().catch(ignore);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let ended = false;
  try {
    const batcher = new Batcher();
    for (let text = await nextText(reader, signal); text !== null; text = await nextText(reader, signal)) {
      for (const batch of batcher.add(table.push(text))) {
        yield batch;
        throwIfAborted(signal);
      }
    }
    ended = true;
    yield* batcher.add(table.finish());
    yield* batcher.rest();
  } finally {
    signal.removeEventListener('abort', onAbort);
    // The consumer stopped early, the signal fired or something failed: release the file.
    if (!ended) {
      await reader.cancel().catch(ignore);
      await bytes.release();
    }
    reader.releaseLock();
  }
}

export const csvImporter: Importer = {
  formats: ['csv', 'tsv'],
  sniff: (src) => sniffCsvSource(src),
  read: (src, opts, ctx) => readCsv(src, opts, ctx),
};
