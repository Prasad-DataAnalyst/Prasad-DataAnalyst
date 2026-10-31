import { parquetWriteBuffer } from 'hyparquet-writer';
import { describe, expect, it } from 'vitest';
import { fixtureSource } from '@tw/fixtures';
import type { ByteSource, RawRow } from '@tw/model';
import { parquetImporter, writeParquet } from './index';

function source(bytes: Uint8Array, name = 'data.parquet'): ByteSource {
  return {
    name,
    size: bytes.byteLength,
    slice: (start, end) => Promise.resolve(bytes.slice(start, end)),
    stream: () => new Blob([bytes as BlobPart]).stream(),
  };
}

async function readAll(src: ByteSource): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
  for await (const batch of parquetImporter.read(src, { format: 'parquet', parquet: { nested: 'json-text' } }, ctx)) {
    rows.push(...batch.rows);
  }
  return rows;
}

describe('parquetImporter', () => {
  it('reads the typed fixture with its stored types', async () => {
    const src = fixtureSource('parquet_well_daily_typed.parquet');
    const sniff = await parquetImporter.sniff(src);
    expect(sniff.header).toEqual([
      ['well_id', 'day', 'recorded_at', 'Oil rate (bbl/d)', 'choke_64ths', 'shut_in', 'remark'],
    ]);
    expect(sniff.detections['rowCount']?.value).toBe(8);
    const rows = await readAll(src);
    expect(rows).toEqual(sniff.sampleRows);
    expect(rows[0]).toEqual({
      srcLoc: 0,
      // TIMESTAMP_MICROS holds UTC instants, passed on with their zone.
      fields: ['NS-C01', { date: '2026-03-01' }, '2026-03-01T06:00:00.000Z', 900, 28, false, null],
    });
    expect(rows[5]?.fields[3]).toBeNull();
    expect(rows[6]?.fields.slice(5)).toEqual([true, 'shut in for survey']);
  });

  it('streams row group by row group and keeps their order', async () => {
    const n = 250_001;
    const bytes = writeParquet([
      { name: 'i', type: 'integer', values: Array.from({ length: n }, (_, i) => i) },
      { name: 'x', type: 'number', values: Array.from({ length: n }, (_, i) => (i % 7 === 0 ? null : i / 8)) },
    ]);
    const rows = await readAll(source(bytes));
    expect(rows).toHaveLength(n);
    expect(rows.every((r, i) => r.srcLoc === i && r.fields[0] === i)).toBe(true);
    expect(rows[250_000]?.fields).toEqual([250_000, 31_250]);
  });

  it('keeps the zone of UTC timestamps, none for local ones, and every digit finer than a millisecond', async () => {
    const values = [1_700_000_000_123_456n, 1_700_000_000_123_000n, null];
    const timestamp = (isAdjustedToUTC: boolean) => ({ type: 'TIMESTAMP', isAdjustedToUTC, unit: 'MICROS' });
    const bytes = new Uint8Array(
      parquetWriteBuffer({
        columnData: [
          { name: 'utc', data: values },
          { name: 'local', data: values },
        ],
        schema: [
          { name: 'root', num_children: 2 },
          { name: 'utc', type: 'INT64', repetition_type: 'OPTIONAL', logical_type: timestamp(true) },
          { name: 'local', type: 'INT64', repetition_type: 'OPTIONAL', logical_type: timestamp(false) },
        ] as never,
      }),
    );
    const rows = await readAll(source(bytes));
    expect(rows.map((r) => r.fields)).toEqual([
      ['2023-11-14T22:13:20.123456Z', '2023-11-14T22:13:20.123456'],
      ['2023-11-14T22:13:20.123Z', { datetime: '2023-11-14T22:13:20.123Z' }],
      [null, null],
    ]);
  });

  it('refuses a file that is not Parquet, saying how to fix it', async () => {
    await expect(
      parquetImporter.sniff(source(new TextEncoder().encode('a,b\n1,2\n'), 'x.parquet')),
    ).rejects.toMatchObject({
      code: 'PARSE_FAILED',
      message: expect.stringContaining('could not be read as Parquet'),
    });
  });
});
