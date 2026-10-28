import { describe, expect, it } from 'vitest';
import { readParquet } from '@tw/formats-parquet';
import { readZip } from '@tw/io';
import type { ValidationCheck } from '@tw/model';
import { CTX, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { DEFAULT_WRITERS, buildExport, expectedShape, readBack, type ExportWriters } from './index';

const view = viewOf(datasetOf());

function failing(checks: ValidationCheck[]): string[] {
  return [...new Set(checks.filter((c) => !c.ok).map((c) => c.id))];
}

async function parquetExport(writers: ExportWriters = DEFAULT_WRITERS) {
  return buildExport(inputOf(view, { profile: 'parquet' }), CTX, writers);
}

describe('Parquet export', () => {
  it('passes every read-back check, the Parquet type check included', async () => {
    const result = await parquetExport();
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    const ids = new Set(result.validation.checks.map((c) => c.id));
    for (const id of ['RB-OPEN', 'RB-PARQUET-TYPES', 'RB-HEADER', 'RB-ROWS', 'RB-VALUES', 'RB-PKG-CHECKSUMS']) {
      expect(ids.has(id as never), id).toBe(true);
    }
    expect(readZip(result.bytes as Uint8Array).paths()).toContain('data.parquet');
  });

  it("types every column for its logical type and names it 'Name [unit]'", async () => {
    const result = await parquetExport();
    const table = await readParquet(readZip(result.bytes as Uint8Array).read('data.parquet'));
    expect(table.columns.map((c) => c.name)).toEqual(expectedShape(view).columns.map((c) => c.header));
    const byName = Object.fromEntries(table.columns.map((c) => [c.name, `${c.physical} ${c.annotation ?? ''}`.trim()]));
    expect(byName).toMatchObject({
      well_id: 'BYTE_ARRAY UTF8',
      date: 'INT32 DATE',
      'reading time': 'INT64 TIMESTAMP_MICROS',
      'Pressure [psia]': 'DOUBLE',
      Online: 'BOOLEAN',
    });
    expect(table.rowCount).toBe(view.rowCount);
  });

  it('is byte-identical for the same input and clock', async () => {
    const [a, b] = [await parquetExport(), await parquetExport()];
    expect(a.packageSha256).toBe(b.packageSha256);
  });

  it('a corrupted value fails RB-VALUES and offers no package', async () => {
    const writers: ExportWriters = {
      ...DEFAULT_WRITERS,
      parquet: (cols) =>
        DEFAULT_WRITERS.parquet(
          cols.map((c, j) => (j === 3 ? { ...c, values: c.values.map((v, i) => (i === 0 ? 1205.4 : v)) } : c)),
        ),
    };
    const result = await parquetExport(writers);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBeUndefined();
    expect(failing(result.validation.checks)).toContain('RB-VALUES');
  });

  it('a column written as text instead of a number fails RB-PARQUET-TYPES', async () => {
    const writers: ExportWriters = {
      ...DEFAULT_WRITERS,
      parquet: (cols) =>
        DEFAULT_WRITERS.parquet(
          cols.map((c, j) =>
            j === 3 ? { ...c, type: 'string', values: c.values.map((v) => (v === null ? null : String(v))) } : c,
          ),
        ),
    };
    const result = await parquetExport(writers);
    expect(failing(result.validation.checks)).toEqual(expect.arrayContaining(['RB-PARQUET-TYPES', 'RB-VALUES']));
  });

  it('reports a file that is not Parquet as not opening', async () => {
    const checks = await readBack.parquet(new TextEncoder().encode('a,b\n1,2\n'), expectedShape(view), 'x.parquet');
    expect(checks).toEqual([expect.objectContaining({ id: 'RB-OPEN', ok: false })]);
  });
});
