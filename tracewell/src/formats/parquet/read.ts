/**
 * Parquet reader for export read-back: the file's schema with each column's physical and
 * converted or logical type, and its values rebuilt as cell values. Dates and timestamps are
 * decoded from their stored integers, never through a JavaScript Date, so no precision is lost
 * and a timestamp finer than a millisecond is reported rather than rounded.
 */
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import type { CellValue } from '@tw/model';

export interface ParquetColumnRead {
  name: string;
  physical: string;
  /** The converted type, or the logical type ('TIMESTAMP(MICROS, UTC)') when only that is set; null for none. */
  annotation: string | null;
}

export interface ParquetRead {
  columns: ParquetColumnRead[];
  rowCount: number;
  /** Values per column; undefined marks a value that no cell value can hold exactly. */
  values: (CellValue | undefined)[][];
  kvMetadata: Record<string, string>;
}

const DAY_MS = 86_400_000;

/** A decoded value that has no exact cell value (such as a timestamp with microseconds). */
const INEXACT = Symbol('inexact');

function dateText(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

function isoOf(ms: bigint): string | typeof INEXACT {
  const n = Number(ms);
  return Number.isSafeInteger(n) ? new Date(n).toISOString() : INEXACT;
}

const PARSERS = {
  dateFromDays: (days: number) => ({ date: dateText(days) }),
  timestampFromMilliseconds: (ms: bigint) => {
    const iso = isoOf(BigInt(ms));
    return iso === INEXACT ? INEXACT : { datetime: iso };
  },
  timestampFromMicroseconds: (us: bigint) => {
    if (BigInt(us) % 1000n !== 0n) return INEXACT;
    const iso = isoOf(BigInt(us) / 1000n);
    return iso === INEXACT ? INEXACT : { datetime: iso };
  },
  timestampFromNanoseconds: (ns: bigint) => {
    if (BigInt(ns) % 1_000_000n !== 0n) return INEXACT;
    const iso = isoOf(BigInt(ns) / 1_000_000n);
    return iso === INEXACT ? INEXACT : { datetime: iso };
  },
};

function annotation(e: {
  converted_type?: string;
  logical_type?: { type: string } & Record<string, unknown>;
}): string | null {
  if (e.converted_type !== undefined) return e.converted_type;
  const l = e.logical_type;
  if (l === undefined) return null;
  if (l.type === 'TIMESTAMP') return `TIMESTAMP(${String(l['unit'])}${l['isAdjustedToUTC'] === true ? ', UTC' : ''})`;
  return l.type;
}

/** A decoded value as a cell value: numbers, booleans, strings, dates, timestamps and JSON objects. */
function cellOf(v: unknown): CellValue | undefined {
  if (v === null || v === undefined) return null;
  if (v === INEXACT) return undefined;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'object' && ('date' in v || 'datetime' in v)) return v as CellValue;
  if (typeof v === 'object' && 'type' in v) return { geometry: v as never };
  return undefined;
}

export async function readParquet(bytes: Uint8Array): Promise<ParquetRead> {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const meta = parquetMetadata(file);
  const leaves = meta.schema.slice(1);
  const columns = leaves.map((e) => ({
    name: e.name,
    physical: String(e.type ?? 'GROUP'),
    annotation: annotation(e as never),
  }));
  const rows = await parquetReadObjects({ file, parsers: PARSERS as never });
  const values = columns.map((c) => rows.map((r) => cellOf((r as Record<string, unknown>)[c.name])));
  const kvMetadata: Record<string, string> = {};
  for (const kv of meta.key_value_metadata ?? []) kvMetadata[kv.key] = kv.value ?? '';
  return { columns, rowCount: Number(meta.num_rows), values, kvMetadata };
}
