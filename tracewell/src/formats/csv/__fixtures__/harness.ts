/** Test helpers: run csvImporter over bytes and collect what it reports. */
import { bytesSource } from '@tw/io';
import type { ByteSource, FormatOptions, ImportNote, RawBatch, SniffResult } from '@tw/model';
import { csvImporter } from '../reader';
import { SAMPLES, type SampleName } from './samples';

export interface ReadOutcome {
  batches: RawBatch[];
  notes: ImportNote[];
  bytes: number;
}

export async function readAll(src: ByteSource, opts: FormatOptions, signal?: AbortSignal): Promise<ReadOutcome> {
  const outcome: ReadOutcome = { batches: [], notes: [], bytes: 0 };
  const ctx = {
    signal: signal ?? new AbortController().signal,
    onBytes: (n: number) => {
      outcome.bytes += n;
    },
    note: (n: ImportNote) => {
      outcome.notes.push(n);
    },
  };
  for await (const batch of csvImporter.read(src, opts, ctx)) outcome.batches.push(batch);
  return outcome;
}

export function sampleSource(name: SampleName): ByteSource {
  return bytesSource(SAMPLES[name].bytes, name);
}

/** Sniffs a sample, then reads it with the sniffed options. */
export async function sniffAndRead(name: SampleName): Promise<{ sniff: SniffResult; read: ReadOutcome }> {
  const src = sampleSource(name);
  const sniff = await csvImporter.sniff(src);
  return { sniff, read: await readAll(src, sniff.options) };
}

/** Bytes of CSV text with `rows` data rows, for tests that need more than one batch or one MiB. */
export function generatedCsv(rows: number): Uint8Array {
  const lines = ['id,name,value\n'];
  for (let i = 1; i <= rows; i++) lines.push(`${i},row ${i},${(i * 0.25).toFixed(2)}\n`);
  return new TextEncoder().encode(lines.join(''));
}
