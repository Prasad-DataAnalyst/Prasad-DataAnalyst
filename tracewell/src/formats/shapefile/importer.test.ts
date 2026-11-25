import { describe, expect, it } from 'vitest';
import { esriWkt } from '@tw/geo';
import { writeZip } from '@tw/io';
import type { ByteSource, RawRow } from '@tw/model';
import { shapefileImporter } from './index';

function source(bytes: Uint8Array, name = 'layer.zip'): ByteSource {
  return {
    name,
    size: bytes.byteLength,
    slice: (start, end) => Promise.resolve(bytes.slice(start, end)),
    stream: () => new Blob([bytes as BlobPart]).stream(),
  };
}

async function readAll(src: ByteSource, entry = 'layer.shp'): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
  for await (const batch of shapefileImporter.read(src, { format: 'shapefile', shapefile: { entry } }, ctx)) {
    rows.push(...batch.rows);
  }
  return rows;
}

/** A record's content: its shape type, then little-endian numbers as the format lays them out. */
function content(type: number, ints: number[], doubles: number[]): Uint8Array {
  const out = new Uint8Array(4 + 4 * ints.length + 8 * doubles.length);
  const v = new DataView(out.buffer);
  v.setInt32(0, type, true);
  ints.forEach((x, i) => v.setInt32(4 + 4 * i, x, true));
  doubles.forEach((x, i) => v.setFloat64(4 + 4 * ints.length + 8 * i, x, true));
  return out;
}

/** A polyline or polygon record: box, part and point counts, part starts, then x and y. */
function parts(type: number, rings: number[][][]): Uint8Array {
  const points = rings.flat();
  const starts: number[] = [];
  let n = 0;
  for (const r of rings) {
    starts.push(n);
    n += r.length;
  }
  const out = new Uint8Array(44 + 4 * starts.length + 16 * points.length);
  const v = new DataView(out.buffer);
  v.setInt32(0, type, true);
  v.setInt32(36, rings.length, true);
  v.setInt32(40, points.length, true);
  starts.forEach((s, i) => v.setInt32(44 + 4 * i, s, true));
  points.forEach((p, i) => {
    v.setFloat64(44 + 4 * starts.length + 16 * i, p[0] as number, true);
    v.setFloat64(52 + 4 * starts.length + 16 * i, p[1] as number, true);
  });
  return out;
}

function shp(type: number, records: Uint8Array[]): Uint8Array {
  const length = 100 + records.reduce((n, r) => n + 8 + r.length, 0);
  const out = new Uint8Array(length);
  const v = new DataView(out.buffer);
  v.setInt32(0, 9994, false);
  v.setInt32(24, length / 2, false);
  v.setInt32(28, 1000, true);
  v.setInt32(32, type, true);
  let at = 100;
  records.forEach((r, i) => {
    v.setInt32(at, i + 1, false);
    v.setInt32(at + 4, r.length / 2, false);
    out.set(r, at + 8);
    at += 8 + r.length;
  });
  return out;
}

/** A dBASE III table; values are the bytes of each field, padded here to its width. */
function dbf(fields: [string, string, number][], rows: (number[] | string)[][], driver = 0): Uint8Array {
  const recordLength = 1 + fields.reduce((n, f) => n + f[2], 0);
  const headerLength = 32 + 32 * fields.length + 1;
  const out = new Uint8Array(headerLength + rows.length * recordLength + 1);
  const v = new DataView(out.buffer);
  out[0] = 3;
  v.setUint32(4, rows.length, true);
  v.setUint16(8, headerLength, true);
  v.setUint16(10, recordLength, true);
  out[29] = driver;
  fields.forEach(([name, type, width], i) => {
    out.set(new TextEncoder().encode(name), 32 + 32 * i);
    out[32 + 32 * i + 11] = type.charCodeAt(0);
    out[32 + 32 * i + 16] = width;
  });
  out[headerLength - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerLength + r * recordLength;
    out[at++] = 0x20;
    row.forEach((value, i) => {
      const width = (fields[i] as [string, string, number])[2];
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
      out.fill(0x20, at, at + width);
      out.set(bytes.subarray(0, width), at);
      at += width;
    });
  });
  out[out.length - 1] = 0x1a;
  return out;
}

const square = (x: number, y: number, s: number, clockwise: boolean) => {
  const ring = [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ];
  return clockwise ? ring.reverse() : ring;
};

const FIELDS: [string, string, number][] = [
  ['NAME', 'C', 12],
  ['DEPTH', 'N', 10],
  ['ACTIVE', 'L', 1],
  ['SPUD', 'D', 8],
];

describe('shapefileImporter', () => {
  it('reads polygons with holes and multipolygons, and every field type, with the CRS of the .prj', async () => {
    const zip = writeZip([
      { path: 'readme.txt', data: new TextEncoder().encode('Licence blocks') },
      {
        path: 'layer.shp',
        data: shp(5, [
          parts(5, [square(0, 0, 10, true), square(2, 2, 2, false)]),
          parts(5, [square(0, 0, 1, true), square(5, 5, 1, true)]),
          content(0, [], []),
        ]),
      },
      {
        path: 'Layer.DBF',
        data: dbf(FIELDS, [
          ['Bloc', '  1250.5', 'T', '20190304'],
          ['  padded', '**********', '?', '        '],
          ['Café', '-3', 'n', '2020'],
        ]),
      },
      { path: 'layer.prj', data: new TextEncoder().encode(`${esriWkt('EPSG:27700') ?? ''}\n`) },
      { path: 'layer.cpg', data: new TextEncoder().encode('UTF-8') },
    ]);
    const sniff = await shapefileImporter.sniff(source(zip));
    expect(sniff.format).toBe('shapefile');
    expect(sniff.options).toEqual({ format: 'shapefile', shapefile: { entry: 'layer.shp' } });
    expect(sniff.header).toEqual([['NAME', 'DEPTH', 'ACTIVE', 'SPUD']]);
    expect(sniff.detections['crs']).toMatchObject({
      value: { code: 'EPSG:27700', source: 'shapefile-prj' },
      confidence: 'high',
    });
    expect(sniff.detections['encoding']).toMatchObject({ value: 'utf-8', method: 'cpg' });
    expect(sniff.detections['rowCount']?.value).toBe(3);
    const rows = await readAll(source(zip));
    expect(rows.map((r) => r.fields)).toEqual([
      ['Bloc', '1250.5', true, { date: '2019-03-04' }],
      ['  padded', null, null, null],
      ['Café', '-3', false, '2020'],
    ]);
    expect(rows.map((r) => r.geometry)).toEqual([
      { type: 'Polygon', coordinates: [square(0, 0, 10, true), square(2, 2, 2, false)] },
      { type: 'MultiPolygon', coordinates: [[square(0, 0, 1, true)], [square(5, 5, 1, true)]] },
      null,
    ]);
  });

  it('reads lines, points with heights and multipoints, and more .dbf records than shapes', async () => {
    const pointZ = content(11, [], [1.5, 2.5, 30, 0]);
    const multi = (() => {
      const c = new Uint8Array(40 + 32);
      const v = new DataView(c.buffer);
      v.setInt32(0, 8, true);
      v.setInt32(36, 2, true);
      [1, 2, 3, 4].forEach((x, i) => v.setFloat64(40 + 8 * i, x, true));
      return c;
    })();
    const lines = writeZip([
      {
        path: 'gis/lines.shp',
        data: shp(3, [
          parts(3, [
            [
              [0, 0],
              [1, 1],
            ],
          ]),
          parts(3, [
            [
              [0, 0],
              [1, 1],
            ],
            [
              [2, 2],
              [-0, Number.NaN],
            ],
          ]),
        ]),
      },
      { path: 'gis/lines.dbf', data: dbf([['ID', 'N', 4]], [['1'], ['2'], ['3']]) },
    ]);
    const rows = await readAll(source(lines), 'gis/lines.shp');
    expect(rows.map((r) => [r.fields, r.geometry])).toEqual([
      [
        ['1'],
        {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
      [
        ['2'],
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0],
              [1, 1],
            ],
            [
              [2, 2],
              [0, null],
            ],
          ],
        },
      ],
      [['3'], null],
    ]);
    const points = writeZip([
      { path: 'p.shp', data: shp(11, [pointZ]) },
      { path: 'm.shp', data: shp(8, [multi]) },
    ]);
    const sniff = await shapefileImporter.sniff(source(points));
    expect(sniff.header).toEqual([[]]);
    expect(sniff.detections['crs']).toMatchObject({ value: { code: 'unknown' }, confidence: 'low' });
    expect(sniff.sampleRows.map((r) => r.geometry)).toEqual([{ type: 'Point', coordinates: [1.5, 2.5, 30] }]);
  });

  it('finds the encoding without a .cpg, and the CRS by EPSG authority or by ESRI name', async () => {
    const layer = (files: { path: string; data: Uint8Array }[]) =>
      shapefileImporter.sniff(
        source(writeZip([{ path: 'layer.shp', data: shp(1, [content(1, [], [1, 2])]) }, ...files])),
      );
    const latin = dbf([['NAME', 'C', 8]], [[[0x43, 0x61, 0x66, 0xe9]]]);
    expect((await layer([{ path: 'layer.dbf', data: latin }])).detections['encoding']).toMatchObject({
      value: 'windows-1252',
      confidence: 'low',
    });
    const ansi = dbf([['NAME', 'C', 8]], [[[0x43, 0x61, 0x66, 0xe9]]], 0x57);
    const read = await layer([{ path: 'layer.dbf', data: ansi }]);
    expect(read.detections['encoding']).toMatchObject({ value: 'windows-1252', confidence: 'high' });
    expect(read.sampleRows[0]?.fields).toEqual(['Café']);
    const utf8 = dbf([['NAME', 'C', 8]], [['Café']]);
    expect((await layer([{ path: 'layer.dbf', data: utf8 }])).detections['encoding']).toMatchObject({
      value: 'utf-8',
      confidence: 'medium',
    });
    const prj = (text: string) => layer([{ path: 'layer.prj', data: new TextEncoder().encode(text) }]);
    expect((await prj('PROJCS["x",GEOGCS["y"],AUTHORITY["EPSG","32631"]]')).detections['crs']).toMatchObject({
      value: { code: 'EPSG:32631' },
      confidence: 'high',
    });
    expect((await prj('PROJCS["British_National_Grid",GEOGCS["GCS_OSGB_1936"]]')).detections['crs']).toMatchObject({
      value: { code: 'EPSG:27700' },
      confidence: 'medium',
    });
    expect((await prj('PROJCS["Somewhere_Else",GEOGCS["x"]]')).detections['crs']).toMatchObject({
      value: { code: 'unknown' },
    });
  });

  it('refuses a .shp alone, an archive without one and a damaged .shp, with a fix', async () => {
    await expect(shapefileImporter.sniff(source(shp(1, []), 'wells.shp'))).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
    });
    await expect(
      shapefileImporter.sniff(source(writeZip([{ path: 'a.dbf', data: dbf(FIELDS, []) }]))),
    ).rejects.toMatchObject({ message: 'The Shapefile does not parse: the ZIP archive holds no .shp file.' });
    const cut = shp(1, [content(1, [], [1, 2])]).subarray(0, 120);
    await expect(shapefileImporter.sniff(source(writeZip([{ path: 'a.shp', data: cut }])))).rejects.toMatchObject({
      message: 'The Shapefile does not parse: record 1 of the .shp file is cut short.',
    });
  });
});
