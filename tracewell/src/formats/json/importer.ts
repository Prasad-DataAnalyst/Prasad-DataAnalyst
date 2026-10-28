/**
 * The JSON Importer used by ingest, for tabular JSON: an array of objects, one object per line
 * (JSON Lines, NDJSON), or an object whose member holds an array of objects (a typical API
 * response). Each object is a row; its keys, in first-seen order over the file, are the columns.
 * Nested objects and arrays are kept as JSON text, as GeoJSON properties are.
 *
 * sniff() reads at most the first MiB, decides the layout and reports the keys seen there as the
 * single header row. read() streams the whole file; a key first seen after the first MiB extends
 * the header, as for GeoJSON.
 */
import {
  BATCH_ROWS,
  detection,
  PREVIEW_MAX_BYTES,
  type ByteSource,
  type Detection,
  type FormatOptions,
  type Importer,
  type JsonOptions,
  type JsonValue,
  type RawBatch,
  type RawRow,
  type ReadContext,
  type SniffResult,
} from '@tw/model';
import { JSONParser } from '@streamparser/json';
import { decodeAll, decodeStream, sniffEncoding } from '@tw/io';
import { RecordColumns } from './columns';
import { brokenJson, formatCount, invalidArgument, notRecords, throwIfAborted } from './errors';
import { isRecord, recordParser } from './records';

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;

function jsonOptions(opts: FormatOptions): JsonOptions {
  if (opts.format !== 'json') {
    throw invalidArgument(`The JSON reader was given options for the "${opts.format}" format.`, {
      format: opts.format,
    });
  }
  return opts.json;
}

// ---------------------------------------------------------------------------------------------
// Layout

interface Layout {
  options: JsonOptions;
  confidence: 'high' | 'medium';
  evidence: string;
}

function parsesAsObject(text: string): boolean {
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
}

/** The first member of the top-level object whose value is an array starting with an object. */
function recordsMember(text: string, complete: boolean): string | null {
  let found: string | null = null;
  const parser = new JSONParser({ paths: ['$.*.*'], keepStack: false });
  parser.onValue = (info) => {
    const key = (info.stack as readonly { key?: unknown }[])[1]?.key;
    if (found === null && Array.isArray(info.parent) && isRecord(info.value) && typeof key === 'string') found = key;
  };
  try {
    parser.write(text);
    if (complete && !parser.isEnded) parser.end();
  } catch (e) {
    throw brokenJson(e instanceof Error ? e.message : String(e));
  }
  return found;
}

/** Decides how records are laid out from the head of the file (`text`, decoded, without a BOM). */
export function detectLayout(text: string, complete: boolean): Layout {
  const body = text.trimStart();
  const first = body.charAt(0);
  if (first === '[') {
    return {
      options: { layout: 'array', member: '', nested: 'json-text' },
      confidence: 'high',
      evidence: 'The file starts with "[": an array whose objects are the rows.',
    };
  }
  if (first !== '{') {
    throw notRecords(
      first === ''
        ? 'The file is empty: it holds no JSON.'
        : 'The file does not start with a JSON array or object, so it holds no records.',
    );
  }
  const lines = body.split('\n');
  const firstLine = parsesAsObject((lines[0] ?? '').trim());
  const next = lines.slice(1).find((l) => l.trim() !== '');
  if (firstLine && next?.trimStart().startsWith('{') === true) {
    return {
      options: { layout: 'lines', member: '', nested: 'json-text' },
      confidence: 'high',
      evidence: 'Each line holds one JSON object (JSON Lines): each line is a row.',
    };
  }
  const member = recordsMember(body, complete);
  if (member !== null) {
    return {
      options: { layout: 'member', member, nested: 'json-text' },
      confidence: complete ? 'high' : 'medium',
      evidence: `The file is one object whose member "${member}" holds an array of objects: those are the rows; its other members are not imported.`,
    };
  }
  if (firstLine) {
    return {
      options: { layout: 'lines', member: '', nested: 'json-text' },
      confidence: 'medium',
      evidence: 'The file holds one JSON object on one line and no array of objects: it is read as a single row.',
    };
  }
  throw notRecords(
    complete
      ? 'The file holds one JSON object with no array of objects in it, so it has no rows to import.'
      : `The first ${formatCount(text.length)} characters hold one JSON object with no array of objects in them.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Sniff

function keysDetection(columns: RecordColumns, records: number, complete: boolean): Detection<JsonValue> {
  const keys = [...columns.keys];
  const scope = complete
    ? `all ${formatCount(records)} records in the file`
    : `the ${formatCount(records)} records in the first part of the file`;
  return detection(
    keys,
    complete ? 'high' : 'medium',
    'record-key-union',
    `The union of keys in first-seen order over ${scope}: ${keys.length} keys.`,
  );
}

function nestedDetection(nested: string[]): Detection<JsonValue> {
  const evidence =
    `The keys ${nested.map((k) => `"${k}"`).join(', ')} hold objects or arrays; ` +
    'they are kept as JSON text in text columns.';
  return detection(nested, 'medium', 'json-text', evidence);
}

async function sniff(src: ByteSource): Promise<SniffResult> {
  const head = await src.slice(0, PREVIEW_MAX_BYTES);
  const { bomLength, ...encoding } = sniffEncoding(head);
  const complete = head.byteLength >= src.size;
  const text = decodeAll(head, encoding.value, bomLength);
  const layout = detectLayout(text, complete);
  const columns = new RecordColumns();
  const sampleRows: RawRow[] = [];
  const parser = recordParser(layout.options, (r) => {
    const row = columns.toRow(r.srcLoc, r.value);
    if (sampleRows.length < SAMPLE_ROWS) sampleRows.push(row);
  });
  parser.write(text);
  // A cut-off head ends mid-document by design; only a whole file must be a complete document.
  if (complete) parser.finish();
  const options: FormatOptions = { format: 'json', json: layout.options };
  const detections: Record<string, Detection<JsonValue>> = {
    encoding,
    layout: detection(
      { layout: layout.options.layout, member: layout.options.member },
      layout.confidence,
      'json-layout',
      layout.evidence,
    ),
    recordKeys: keysDetection(columns, parser.records, complete),
  };
  const nested = columns.nested;
  if (nested.length > 0) detections['nestedKeys'] = nestedDetection(nested);
  return { format: 'json', options, detections, header: [[...columns.keys]], sampleRows, notes: [] };
}

// ---------------------------------------------------------------------------------------------
// Read

function countingStream(src: ByteSource, ctx: ReadContext): ReadableStream<Uint8Array> {
  return src.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        ctx.onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
}

function* batches(pending: RawRow[], all: boolean): Generator<RawBatch> {
  while (pending.length >= BATCH_ROWS || (all && pending.length > 0)) {
    yield { rows: pending.splice(0, BATCH_ROWS) };
  }
}

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  const options = jsonOptions(opts);
  throwIfAborted(ctx.signal);
  // The same head as sniff(), so both decide the same encoding for the same bytes.
  const encoding = sniffEncoding(await src.slice(0, PREVIEW_MAX_BYTES));
  const columns = new RecordColumns();
  const pending: RawRow[] = [];
  const parser = recordParser(options, (r) => pending.push(columns.toRow(r.srcLoc, r.value)));
  const reader = decodeStream(countingStream(src, ctx), encoding.value, encoding.bomLength).getReader();
  let done = false;
  try {
    for (;;) {
      throwIfAborted(ctx.signal);
      const next = await reader.read();
      if (next.done) break;
      parser.write(next.value);
      yield* batches(pending, false);
    }
    done = true;
    parser.finish();
    yield* batches(pending, true);
  } finally {
    // Stops the file read when the consumer quits early, a parse fails or the import is cancelled.
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const jsonImporter: Importer = {
  formats: ['json'],
  sniff,
  read,
};
