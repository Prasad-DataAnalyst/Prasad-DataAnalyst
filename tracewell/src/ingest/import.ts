/**
 * The full import: stream batches from the reader, parse every field with the planned parsers,
 * build columns, and hash the original bytes in the same pass. The memory budget is checked after
 * each batch; when it would be exceeded the import stops cleanly and keeps a partial dataset with
 * a TW-IMP-006 note instead of failing. Identical bytes and spec always give an identical dataset.
 */
import { buildColumn, TableBuilder, type Dataset } from '@tw/table';
import { collectAssumptions } from '@tw/detect';
import { sha256, sha256OfSource } from '@tw/io';
import {
  EngineError,
  type Assumption,
  type ByteSource,
  type CellValue,
  type ColumnId,
  type DatasetId,
  type Detection,
  type ImportNote,
  type ImportNoteCode,
  type JobProgress,
  type JsonValue,
  type Sha256Hex,
  type TableSchema,
} from '@tw/model';
import { importerFor } from './format';
import { geometryColumnOf, rowParser } from './options';
import type { ImportSpec } from './spec';

export interface ImportContext {
  signal: AbortSignal;
  memoryBudgetBytes: number;
  onProgress(p: JobProgress): void;
}

/** A reader note, or one of the two notes ingest itself raises. */
export type IngestNote = Omit<ImportNote, 'code'> & { code: ImportNoteCode | 'TW-IMP-006' };

export interface ImportOutcome {
  dataset: Dataset;
  spec: ImportSpec;
  notes: IngestNote[];
  sha256: Sha256Hex;
  partial: boolean;
  assumptions: Assumption[];
}

function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The import was cancelled.', 'Start the import again when you are ready.');
}

/** Wraps a source so that whatever the reader streams is also hashed, counting the bytes seen. */
function hashingSource(src: ByteSource) {
  const h = sha256();
  let seen = 0;
  let streamed = false;
  const wrapped: ByteSource = {
    name: src.name,
    size: src.size,
    slice: (start, end) => src.slice(start, end),
    stream: () => {
      if (streamed) return src.stream();
      streamed = true;
      return src.stream().pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            h.update(chunk);
            seen += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
    },
  };
  return {
    wrapped,
    /** The digest from the single pass when it saw every byte; otherwise a second, full pass. */
    async digest(): Promise<Sha256Hex> {
      if (streamed && seen === src.size) return h.hex();
      return sha256OfSource(src);
    },
  };
}

function schemaFor(datasetId: DatasetId, spec: ImportSpec, partial: boolean): Omit<TableSchema, 'rowCount'> {
  const sheet = spec.options.format === 'xlsx' ? spec.options.xlsx.sheet : undefined;
  return {
    datasetId,
    name: spec.datasetName,
    source: {
      fileId: spec.fileId,
      fileName: spec.fileName,
      format: spec.options.format,
      ...(sheet === undefined ? {} : { sheet }),
    },
    columns: spec.columns,
    crs: spec.crs,
    geometryColumn: geometryColumnOf(spec.columns),
    partial,
  };
}

/**
 * The text readers report an assumed encoding while sniffing, not while reading, so the note is
 * restated here from the spec: an import replayed from a project raises it exactly as the first did.
 */
function assumedEncodingNote(spec: ImportSpec): IngestNote | null {
  const d = spec.detections['encoding'];
  if (d === undefined || !d.assumed || (spec.options.format !== 'csv' && spec.options.format !== 'tsv')) return null;
  return {
    code: 'TW-IMP-004',
    message:
      `The text encoding ${String(d.value)} is assumed. ${d.evidence} If accented letters or symbols such as the ` +
      'degree sign look wrong, choose another encoding in the import settings.',
    detail: { encoding: d.value, confidence: d.confidence, method: d.method },
  };
}

function budgetNote(rows: number, budget: number): IngestNote {
  const mib = Math.round(budget / 1024 ** 2);
  return {
    code: 'TW-IMP-006',
    message:
      `Only the first ${rows} rows were imported: the file needs more memory than this edition's ` +
      `${mib} MiB budget. Open the file in the desktop edition to import all of it.`,
    detail: { rowsImported: rows, memoryBudgetBytes: budget },
  };
}

export async function importSource(
  src: ByteSource,
  datasetId: DatasetId,
  spec: Omit<ImportSpec, 'fileId'> | ImportSpec,
  ctx: ImportContext,
): Promise<ImportOutcome> {
  if (ctx.signal.aborted) throw cancelled();
  const importer = importerFor(spec.options.format);
  const parse = rowParser(spec.columns, spec.options);
  const builder = new TableBuilder(spec.columns.map((c) => ({ id: c.id, type: c.type.value })));
  const notes: IngestNote[] = [];
  const hashing = hashingSource(src);
  let bytes = 0;
  let partial = false;

  const readCtx = {
    signal: ctx.signal,
    onBytes: (n: number) => {
      bytes += n;
    },
    note: (n: ImportNote) => notes.push(n),
  };

  try {
    for await (const batch of importer.read(hashing.wrapped, spec.options, readCtx)) {
      if (ctx.signal.aborted) throw cancelled();
      for (const row of batch.rows) builder.pushRow(row.srcLoc, parse(row));
      ctx.onProgress({ phase: 'Importing', done: Math.min(bytes, src.size), total: src.size, unit: 'bytes' });
      if (builder.estimatedBytes() > ctx.memoryBudgetBytes) {
        partial = true;
        notes.push(budgetNote(builder.rowCount, ctx.memoryBudgetBytes));
        break;
      }
    }
  } catch (e) {
    if (ctx.signal.aborted) throw cancelled();
    throw EngineError.from(e);
  }
  if (ctx.signal.aborted) throw cancelled();

  const digest = await hashing.digest();
  if ('fileId' in spec && spec.fileId !== digest) {
    throw new EngineError(
      'INVALID_INPUT',
      `The file ${spec.fileName} is not the file this import was planned for (its SHA-256 differs).`,
      'Import the file again so the plan matches its contents.',
      { expected: spec.fileId, actual: digest },
    );
  }
  const full: ImportSpec = { ...spec, fileId: digest };
  const encodingNote = assumedEncodingNote(full);
  if (encodingNote !== null && !notes.some((n) => n.code === 'TW-IMP-004')) notes.unshift(encodingNote);
  const dataset = builder.finish(schemaFor(datasetId, full, partial));
  const extra: Record<string, Detection<JsonValue>> = full.crs === null
    ? full.detections
    : { ...full.detections, crs: full.crs as unknown as Detection<JsonValue> };
  return {
    dataset,
    spec: full,
    notes,
    sha256: digest,
    partial,
    assumptions: collectAssumptions(datasetId, full.columns, extra),
  };
}

/**
 * Re-parses one column after an interpretation-only override (name, type, unit, role, null
 * markers, date format, timezone), leaving every other column and the row set untouched.
 */
export async function reparseColumn(
  ds: Dataset,
  src: ByteSource,
  spec: ImportSpec,
  columnId: ColumnId,
  ctx: ImportContext,
): Promise<Dataset> {
  const index = spec.columns.findIndex((c) => c.id === columnId);
  const plan = spec.columns[index];
  if (plan === undefined) {
    throw new EngineError(
      'NOT_FOUND',
      `There is no column ${columnId} in dataset ${ds.schema.datasetId}.`,
      'Choose a listed column.',
      {
        columnId,
      },
    );
  }
  const parse = rowParser([plan], spec.options);
  const cells: ReturnType<typeof parse>[number][] = [];
  const readCtx = { signal: ctx.signal, onBytes: () => undefined, note: () => undefined };
  outer: for await (const batch of importerFor(spec.options.format).read(src, spec.options, readCtx)) {
    if (ctx.signal.aborted) throw cancelled();
    for (const row of batch.rows) {
      if (cells.length >= ds.rowCount) break outer;
      const cell = parse(row)[0];
      cells.push(cell ?? { ok: true, value: null as CellValue });
    }
  }
  if (cells.length !== ds.rowCount) {
    throw new EngineError(
      'INTERNAL',
      `Re-reading ${spec.fileName} gave ${cells.length} rows instead of ${ds.rowCount}.`,
      'Import the file again.',
      { expected: ds.rowCount, actual: cells.length },
    );
  }
  const existing = ds.schema.columns.find((c) => c.id === columnId);
  return ds.withColumn(buildColumn(columnId, plan.type.value, cells), {
    ...plan,
    ...(existing?.derivedFrom ? { derivedFrom: existing.derivedFrom } : {}),
  });
}
