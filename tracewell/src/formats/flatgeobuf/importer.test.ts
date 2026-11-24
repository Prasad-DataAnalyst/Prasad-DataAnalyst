import { describe, expect, it } from 'vitest';
import type { ByteSource, Geometry, RawRow } from '@tw/model';
import { FGB_COLUMN, FGB_GEOMETRY, flatgeobufImporter, writeFlatGeobuf, type FgbWriteHeader } from './index';

/** A source that streams its bytes in chunks of `chunk` bytes, to cross every boundary. */
function source(bytes: Uint8Array, chunk = 7): ByteSource {
  return {
    name: 'wells.fgb',
    size: bytes.byteLength,
    slice: (start, end) => Promise.resolve(bytes.slice(start, end)),
    stream: () => {
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.length) controller.close();
          else {
            controller.enqueue(bytes.slice(at, at + chunk));
            at += chunk;
          }
        },
      });
    },
  };
}

async function readAll(src: ByteSource): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
  const opts = { format: 'flatgeobuf' as const, flatgeobuf: { nested: 'json-text' as const } };
  for await (const batch of flatgeobufImporter.read(src, opts, ctx)) rows.push(...batch.rows);
  return rows;
}

const HEADER: FgbWriteHeader = {
  name: 'wells',
  envelope: [-0, 1, 3, 4],
  geometryType: FGB_GEOMETRY.Unknown,
  hasZ: false,
  columns: [
    { name: 'well_id', type: FGB_COLUMN.String },
    { name: 'Depth [m]', type: FGB_COLUMN.Double },
    { name: 'slots', type: FGB_COLUMN.Long },
    { name: 'active', type: FGB_COLUMN.Bool },
    { name: 'spud', type: FGB_COLUMN.DateTime },
    { name: 'tags', type: FGB_COLUMN.Json },
  ],
  featuresCount: 3,
  crs: { org: 'EPSG', code: 27700, name: 'OSGB36 / British National Grid' },
};

const LINE: Geometry = {
  type: 'LineString',
  coordinates: [
    [1, 2],
    [3, 4],
  ],
};

function file(): Uint8Array {
  return writeFlatGeobuf(HEADER, [
    {
      geometry: { type: 'Point', coordinates: [-0, 1] },
      properties: ['W-1', 1200.5, 3, true, '2019-03-04', '{"a":1}'],
    },
    { geometry: null, properties: [null, null, null, null, null, null] },
    { geometry: LINE, properties: ['W-3', 980, -2, false, '2020-01-02T03:04:05.000Z', '[1,2]'] },
  ]);
}

describe('flatgeobufImporter', () => {
  it('sniffs the columns, the CRS from the header, the geometry types and the feature count', async () => {
    const sniff = await flatgeobufImporter.sniff(source(file()));
    expect(sniff.format).toBe('flatgeobuf');
    expect(sniff.header).toEqual([['well_id', 'Depth [m]', 'slots', 'active', 'spud', 'tags']]);
    expect(sniff.detections['crs']).toMatchObject({
      value: { code: 'EPSG:27700', source: 'flatgeobuf-header' },
      confidence: 'high',
      evidence:
        'The FlatGeobuf header records the coordinate reference system EPSG:27700 (OSGB36 / British National Grid).',
    });
    expect(sniff.detections['rowCount']?.value).toBe(3);
    expect(sniff.detections['geometryTypes']?.value).toEqual(['Point', 'LineString']);
    expect(sniff.sampleRows.map((r) => r.srcLoc)).toEqual([0, 1, 2]);
  });

  it('reads every feature as typed fields with its geometry, across chunk boundaries', async () => {
    const rows = await readAll(source(file()));
    expect(rows).toEqual([
      {
        srcLoc: 0,
        fields: ['W-1', 1200.5, 3, true, '2019-03-04', '{"a":1}'],
        geometry: { type: 'Point', coordinates: [0, 1] },
      },
      { srcLoc: 1, fields: [null, null, null, null, null, null], geometry: null },
      { srcLoc: 2, fields: ['W-3', 980, -2, false, '2020-01-02T03:04:05.000Z', '[1,2]'], geometry: LINE },
    ]);
    expect(Object.is((rows[0]?.geometry as { coordinates: number[] }).coordinates[0], 0)).toBe(true);
  });

  it('reports a CRS it cannot name as unknown, and a cut-off file as a parse failure', async () => {
    const plain = writeFlatGeobuf({ ...HEADER, crs: null, columns: [], featuresCount: 1 }, [
      { geometry: { type: 'Point', coordinates: [1, 2] }, properties: [] },
    ]);
    const sniff = await flatgeobufImporter.sniff(source(plain));
    expect(sniff.detections['crs']).toMatchObject({ value: { code: 'unknown' }, confidence: 'low' });
    const cut = file().slice(0, -5);
    await expect(readAll(source(cut))).rejects.toMatchObject({
      code: 'PARSE_FAILED',
      message: 'The FlatGeobuf file does not parse: feature 3 is cut short.',
    });
  });
});
