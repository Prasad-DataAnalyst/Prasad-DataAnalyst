import { describe, expect, it } from 'vitest';
import { FGB_COLUMN, FGB_GEOMETRY, readFlatGeobuf } from '@tw/formats-flatgeobuf';
import { readZip } from '@tw/io';
import type { CellValue } from '@tw/model';
import { CTX, COLS, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport, planExport, profileStatuses } from './index';
import { DEFAULT_WRITERS } from './writers';

const WGS84 = { code: 'OGC:CRS84', source: 'rfc7946-default' } as const;
const GEO_COLS = [
  { name: 'well_id', type: 'string' as const, role: 'id' as const },
  { name: 'geometry', type: 'geometry' as const, role: 'geometry' as const },
];

function geoView(rows: CellValue[][], crs: { code: string; source: string } = WGS84) {
  return viewOf(datasetOf(GEO_COLS, rows, crs as never, 'c1'));
}

const point = (...coordinates: number[]): CellValue => ({ geometry: { type: 'Point', coordinates } });

describe('FlatGeobuf export', () => {
  it('writes typed columns and points from latitude and longitude, and passes read-back', async () => {
    const view = viewOf(datasetOf());
    const result = await buildExport(inputOf(view, { profile: 'flatgeobuf' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.validation.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['RB-FGB-STRUCTURE', 'RB-FGB-GEOMETRY', 'RB-VALUES', 'RB-HEADER', 'RB-ROWS']),
    );
    expect(result.manifest.files.filter((f) => f.role === 'data').map((f) => f.path)).toEqual(['data.fgb']);
    const doc = readFlatGeobuf(readZip(result.bytes ?? new Uint8Array()).read('data.fgb'));
    expect(doc.header).toMatchObject({
      name: view.schema.name,
      geometryType: FGB_GEOMETRY.Point,
      hasZ: false,
      featuresCount: 4n,
      indexNodeSize: 0,
      envelope: [1.7501, -33.9, 151.2, 57.51],
      crs: { org: 'EPSG', code: 4326, name: 'WGS 84' },
    });
    expect(doc.header.columns.map((c) => [c.name, c.type])).toEqual([
      ['well_id', FGB_COLUMN.String],
      ['date', FGB_COLUMN.DateTime],
      ['reading time', FGB_COLUMN.DateTime],
      ['Pressure [psia]', FGB_COLUMN.Double],
      ['Choke', FGB_COLUMN.Long],
      ['lat', FGB_COLUMN.Double],
      ['lon', FGB_COLUMN.Double],
      ['Online', FGB_COLUMN.Bool],
      ['Note', FGB_COLUMN.String],
    ]);
    expect(doc.features.map((f) => f.geometry)).toEqual([
      { type: 'Point', coordinates: [1.7501, 57.4802] },
      { type: 'Point', coordinates: [1.8, 57.51] },
      null,
      { type: 'Point', coordinates: [151.2, -33.9] },
    ]);
    expect(doc.features[0]?.properties).toEqual([
      'NS-A01',
      '2026-01-01',
      '2026-01-01T06:00:00.000Z',
      1205.3,
      32,
      57.4802,
      1.7501,
      true,
      'normal, "steady" flow',
    ]);
  });

  it('keeps any mix of geometry kinds, collections and heights included, and passes read-back', async () => {
    const view = geoView([
      ['A', point(1.5, 57.25, 30)],
      [
        'B',
        {
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [0, 0, 1],
                  [1, 0, 1],
                  [1, 1, 1],
                  [0, 0, 1],
                ],
              ],
            ],
          },
        },
      ],
      [
        'C',
        {
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: [1, 2, 3] },
              {
                type: 'LineString',
                coordinates: [
                  [1, 2, 3],
                  [3, 4, 5],
                ],
              },
            ],
          },
        },
      ],
      ['D', null],
    ]);
    const result = await buildExport(inputOf(view, { profile: 'flatgeobuf' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.manifest.substitutions).toEqual([]);
    const doc = readFlatGeobuf(readZip(result.bytes ?? new Uint8Array()).read('data.fgb'));
    expect(doc.header).toMatchObject({ geometryType: FGB_GEOMETRY.Unknown, hasZ: true });
    expect(doc.header.columns.map((c) => c.name)).toEqual(['well_id']);
  });

  it('records a projected CRS by its EPSG code, with points from easting and northing', async () => {
    const cols = [
      { name: 'well_id', type: 'string' as const, role: 'id' as const },
      { name: 'E', type: 'number' as const, role: 'easting' as const, unit: 'm' },
      { name: 'N', type: 'number' as const, role: 'northing' as const, unit: 'm' },
    ];
    const view = viewOf(
      datasetOf(
        cols,
        [
          ['A', 530000.5, 180000.25],
          ['B', null, 181000],
        ],
        { code: 'EPSG:27700', source: 'user' },
      ),
    );
    const result = await buildExport(inputOf(view, { profile: 'flatgeobuf' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const doc = readFlatGeobuf(readZip(result.bytes ?? new Uint8Array()).read('data.fgb'));
    expect(doc.header.crs).toMatchObject({ org: 'EPSG', code: 27700, name: 'OSGB36 / British National Grid' });
    expect(doc.header.columns.map((c) => c.name)).toEqual(['well_id', 'E [m]', 'N [m]']);
    expect(doc.features.map((f) => f.geometry)).toEqual([{ type: 'Point', coordinates: [530000.5, 180000.25] }, null]);
  });

  it('keeps three numbers of each position, and features without a valid shape, and says so', async () => {
    const view = geoView([
      ['A', point(1, 2, 3, 4)],
      ['B', { geometry: { type: 'Point', coordinates: [[1, 2]] } } as never],
      ['C', point(5, 6, 7)],
    ]);
    const result = await buildExport(inputOf(view, { profile: 'flatgeobuf' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.manifest.substitutions.map((s) => s.what)).toEqual(['1 geometry', '1 geometry']);
    const doc = readFlatGeobuf(readZip(result.bytes ?? new Uint8Array()).read('data.fgb'));
    expect(doc.features.map((f) => f.geometry)).toEqual([
      { type: 'Point', coordinates: [1, 2, 3] },
      null,
      { type: 'Point', coordinates: [5, 6, 7] },
    ]);
  });

  it('refuses what a FlatGeobuf file cannot record, with the reason and a fix', () => {
    const status = (rows: CellValue[][], crs: { code: string; source: string } = WGS84) => {
      const view = geoView(rows, crs);
      return profileStatuses(view, view.schema.crs).find((s) => s.profile.id === 'flatgeobuf');
    };
    expect(status([['A', point(1, 2)]])?.available).toBe(true);
    expect(
      status([
        ['A', point(1, 2)],
        ['B', point(1, 2, 3)],
      ]),
    ).toMatchObject({
      available: false,
      reason: 'A FlatGeobuf file holds geometries all with heights or all without, and this dataset has both.',
      fix: expect.stringContaining('export as GeoJSON'),
    });
    expect(status([['A', point(1, 2)]], { code: 'unknown', source: 'user' })?.fix).toBe(
      'Set the coordinate reference system of the dataset first.',
    );
    expect(status([['A', point(1, 2)]], { code: 'EPSG:3857', source: 'user' })?.available).toBe(true);
    expect(status([['A', point(1, 2)]], { code: 'ESRI:102001', source: 'user' })?.reason).toBe(
      'A FlatGeobuf file records its coordinate reference system by EPSG code, and ESRI:102001 has none.',
    );
    const plain = viewOf(datasetOf(COLS.slice(0, 5), [[null, null, null, null, null]]));
    expect(profileStatuses(plain, plain.schema.crs).find((s) => s.profile.id === 'flatgeobuf')?.available).toBe(false);
  });

  it('fails read-back when a coordinate or a value is changed after writing', async () => {
    const view = geoView([['A', point(1, 2)]]);
    const tamper = (find: number[], replace: number[]) => ({
      ...DEFAULT_WRITERS,
      flatgeobuf: (...args: Parameters<typeof DEFAULT_WRITERS.flatgeobuf>) => {
        const out = DEFAULT_WRITERS.flatgeobuf(...args);
        const at = out.findLastIndex((_, i) => find.every((b, k) => out[i + k] === b));
        out.set(replace, at);
        return out;
      },
    });
    const two = [...new Uint8Array(new Float64Array([2]).buffer)];
    const moved = await buildExport(
      inputOf(view, { profile: 'flatgeobuf' }),
      CTX,
      tamper(two, [...new Uint8Array(new Float64Array([2.5]).buffer)]),
    );
    expect(moved.ok).toBe(false);
    expect(moved.validation.checks.filter((c) => !c.ok).map((c) => c.id)).toContain('RB-FGB-GEOMETRY');
    const renamed = await buildExport(
      inputOf(view, { profile: 'flatgeobuf' }),
      CTX,
      tamper([1, 0, 0, 0, 0x41], [1, 0, 0, 0, 0x42]),
    );
    expect(new Set(renamed.validation.checks.filter((c) => !c.ok).map((c) => c.id))).toEqual(new Set(['RB-VALUES']));
  });
});

describe('Shapefile over its 2 GB limit (FR-EXP-03)', () => {
  it('is delivered as FlatGeobuf, and the substitution says so', async () => {
    const view = viewOf(datasetOf());
    const limits = { shapefileMaxBytes: 300 };
    const plan = planExport(view, 'shapefile', view.schema.crs, limits);
    expect(plan).toMatchObject({
      profile: 'shapefile',
      available: true,
      dataFiles: [{ path: 'data.fgb', kind: 'flatgeobuf' }],
    });
    expect(plan.substitutions[0]).toMatchObject({
      ruleId: 'TW-EXP-002',
      what: 'the Shapefile',
      why: expect.stringMatching(/^It would hold a file of \d+ bytes, more than the 2 GB its format can address\.$/),
    });
    const result = await buildExport(inputOf(view, { profile: 'shapefile', limits }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.manifest.files.filter((f) => f.role === 'data').map((f) => f.path)).toEqual(['data.fgb']);
    expect(readZip(result.bytes ?? new Uint8Array()).readText('README.txt')).toContain('data.fgb');
    expect(planExport(view, 'shapefile', view.schema.crs).dataFiles[0]?.path).toBe('data.shp');
  });
});
