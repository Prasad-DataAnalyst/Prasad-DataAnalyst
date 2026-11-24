import { describe, expect, it } from 'vitest';
import type { Geometry } from '@tw/model';
import {
  FGB_COLUMN,
  FGB_GEOMETRY,
  FGB_MAGIC,
  FlatGeobufFormatError,
  indexSize,
  readFlatGeobuf,
  writeFlatGeobuf,
  type FgbWriteHeader,
} from './index';
import { writeFeature, writeHeader } from './writer';

const f64 = (x: number) => [...new Uint8Array(new Float64Array([x]).buffer)];

describe('FlatBuffers layout', () => {
  it('writes a header table as the FlatBuffers rules place it, worked out by hand', () => {
    const bytes = writeHeader({
      name: 't',
      envelope: null,
      geometryType: FGB_GEOMETRY.Unknown,
      hasZ: false,
      columns: [],
      featuresCount: 0,
      crs: null,
    });
    // prettier-ignore
    expect([...bytes]).toEqual([
      48, 0, 0, 0, // size of the buffer after this prefix
      28, 0, 0, 0, // root table at 4 + 28
      24, 0, 12, 0, // vtable: its size, the table's size
      8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, // name at +8, index_node_size at +6
      24, 0, 0, 0, // the table: its vtable is 24 bytes before it
      0, 0, // padding
      0, 0, // index_node_size 0: no spatial index
      4, 0, 0, 0, // name, 4 bytes on
      1, 0, 0, 0, 0x74, 0, 0, 0, // "t", its terminator and padding
    ]);
  });

  it('writes a point feature as the FlatBuffers rules place it, worked out by hand', () => {
    const bytes = writeFeature([], { geometry: { type: 'Point', coordinates: [1, 2] }, properties: [] }, false);
    // prettier-ignore
    expect([...bytes]).toEqual([
      76, 0, 0, 0, 16, 0, 0, 0, // size, root table at 4 + 16
      0, 0, 0, 0, 0, 0, // padding that aligns the doubles
      6, 0, 10, 0, 4, 0, // Feature vtable: geometry at +4
      6, 0, 0, 0, 24, 0, 0, 0, // Feature table, geometry 24 bytes on
      0, 0, // padding
      18, 0, 12, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, // Geometry vtable: xy at +8, type at +7
      18, 0, 0, 0, 0, 0, 0, 1, // Geometry table, padding, type Point
      4, 0, 0, 0, // xy, 4 bytes on
      2, 0, 0, 0, ...f64(1), ...f64(2), // two doubles, 8-aligned
    ]);
  });
});

const COLUMNS: FgbWriteHeader['columns'] = [
  { name: 'Well', type: FGB_COLUMN.String },
  { name: 'Choke', type: FGB_COLUMN.Long },
  { name: 'Pressure [kPa]', type: FGB_COLUMN.Double },
  { name: 'Online', type: FGB_COLUMN.Bool },
  { name: 'Spud', type: FGB_COLUMN.DateTime },
  { name: 'Outline', type: FGB_COLUMN.Json },
];

const GEOMETRIES: (Geometry | null)[] = [
  { type: 'Point', coordinates: [1.5, -2.25] },
  null,
  { type: 'Point', coordinates: [] },
  {
    type: 'MultiPoint',
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  },
  {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [3, 4],
    ],
  },
  {
    type: 'MultiLineString',
    coordinates: [
      [
        [0, 0],
        [1, 0],
      ],
      [
        [2, 2],
        [3, 3],
        [4, 4],
      ],
    ],
  },
  { type: 'MultiLineString', coordinates: [] },
  {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 0],
      ],
    ],
  },
  {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [9, 0],
        [9, 9],
        [0, 0],
      ],
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 1],
      ],
    ],
  },
  { type: 'Polygon', coordinates: [] },
  { type: 'Polygon', coordinates: [[]] },
  {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      [
        [
          [5, 5],
          [6, 5],
          [6, 6],
          [5, 5],
        ],
        [],
      ],
    ],
  },
  { type: 'MultiPolygon', coordinates: [] },
  {
    type: 'GeometryCollection',
    geometries: [
      { type: 'Point', coordinates: [7, 8] },
      {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'LineString',
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
      },
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    ],
  },
  { type: 'GeometryCollection', geometries: [] },
];

describe('FlatGeobuf writer and reader', () => {
  it('reads back every kind of geometry, empty ones included, and every column type', () => {
    const bytes = writeFlatGeobuf(
      {
        name: 'wells',
        envelope: [-1, -2, 3, 4],
        geometryType: FGB_GEOMETRY.Unknown,
        hasZ: false,
        columns: COLUMNS,
        featuresCount: GEOMETRIES.length,
        crs: { org: 'EPSG', code: 27700, name: 'OSGB36 / British National Grid' },
      },
      GEOMETRIES.map((geometry, i) => ({
        geometry,
        properties:
          i === 1
            ? [null, null, null, null, null, null]
            : [`W-${i} °`, i - 5, i / 3, i % 2 === 0, '2026-01-02', '{"type":"Point","coordinates":[1,2]}'],
      })),
    );
    expect([...bytes.subarray(0, 8)]).toEqual([...FGB_MAGIC]);
    const doc = readFlatGeobuf(bytes);
    expect(doc.version).toEqual([3, 1]);
    expect(doc.indexBytes).toBe(0);
    expect(doc.header).toEqual({
      name: 'wells',
      envelope: [-1, -2, 3, 4],
      geometryType: 0,
      hasZ: false,
      hasM: false,
      hasT: false,
      hasTM: false,
      columns: COLUMNS.map((c) => ({ ...c, nullable: true })),
      featuresCount: BigInt(GEOMETRIES.length),
      indexNodeSize: 0,
      crs: { org: 'EPSG', code: 27700, name: 'OSGB36 / British National Grid', codeString: null, wkt: null },
    });
    expect(doc.features.map((f) => f.geometry)).toEqual(GEOMETRIES);
    expect(doc.features[0]?.properties).toEqual([
      'W-0 °',
      -5,
      0,
      true,
      '2026-01-02',
      '{"type":"Point","coordinates":[1,2]}',
    ]);
    expect(doc.features[1]?.properties).toEqual([null, null, null, null, null, null]);
  });

  it('writes heights as z values when the header says the data has them', () => {
    const geometry: Geometry = {
      type: 'LineString',
      coordinates: [
        [1, 2, 3],
        [4, 5, -6],
      ],
    };
    const header = {
      name: 'z',
      envelope: [1, 2, 4, 5] as const,
      geometryType: FGB_GEOMETRY.LineString,
      hasZ: true,
      columns: [],
      featuresCount: 1,
      crs: null,
    };
    const doc = readFlatGeobuf(writeFlatGeobuf(header, [{ geometry, properties: [] }]));
    expect(doc.header.hasZ).toBe(true);
    expect(doc.header.geometryType).toBe(FGB_GEOMETRY.LineString);
    expect(doc.features[0]?.geometry).toEqual(geometry);
  });

  it('keeps whole numbers beyond 2^53 exact, and refuses damaged files with a reason', () => {
    const header = {
      name: 'n',
      envelope: null,
      geometryType: 0,
      hasZ: false,
      columns: [{ name: 'Count', type: FGB_COLUMN.Long } as const],
      featuresCount: 1,
      crs: null,
    };
    const bytes = writeFlatGeobuf(header, [{ geometry: null, properties: [2 ** 53 - 1] }]);
    expect(readFlatGeobuf(bytes).features[0]?.properties).toEqual([2 ** 53 - 1]);
    expect(() => readFlatGeobuf(bytes.subarray(0, bytes.length - 3))).toThrow(FlatGeobufFormatError);
    expect(() => readFlatGeobuf(new TextEncoder().encode('fgb\u0002fgb\u0000'))).toThrow(/version 2/);
    expect(() => readFlatGeobuf(new Uint8Array(12))).toThrow(/magic bytes/);
  });

  it('sizes a packed R-tree as the reference implementation does', () => {
    expect(indexSize(0, 16)).toBe(0);
    expect(indexSize(1, 16)).toBe(2 * 40);
    expect(indexSize(179, 16)).toBe((179 + 12 + 1) * 40);
    expect(indexSize(5, 0)).toBe(0);
  });
});
