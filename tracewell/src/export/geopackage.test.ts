import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gpkgFeatures, readGeoPackage, readGpkgGeometry } from '@tw/formats-geopackage';
import { readZip } from '@tw/io';
import type { CellValue } from '@tw/model';
import { CTX, COLS, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport, profileStatuses } from './index';
import { DEFAULT_WRITERS } from './writers';

const PYTHON = spawnSync('python3', ['-I', '-c', 'import sqlite3'], { stdio: 'ignore' }).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'tw-gpkg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What SQLite sees in a GeoPackage: its integrity check, its metadata tables and its feature table. */
const SQLITE = String.raw`
import json, sqlite3, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
q = lambda sql: [list(r) for r in con.execute(sql)]
print(json.dumps({
    'check': q('PRAGMA integrity_check'),
    'foreign_keys': q('PRAGMA foreign_key_check'),
    'ids': q('PRAGMA application_id') + q('PRAGMA user_version'),
    'srs': q('SELECT srs_id, organization, organization_coordsys_id, srs_name FROM gpkg_spatial_ref_sys ORDER BY srs_id'),
    'contents': q('SELECT * FROM gpkg_contents'),
    'geometry_columns': q('SELECT * FROM gpkg_geometry_columns'),
    'columns': q('SELECT name, type, pk FROM pragma_table_info(\'data\')'),
    'rows': q('SELECT fid, length(geom), * FROM data ORDER BY fid'),
    'sequence': q('SELECT * FROM sqlite_sequence'),
}, default=lambda b: b.hex()))
`;

function sqlite(bytes: Uint8Array): Record<string, unknown[][]> {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.gpkg`);
  writeFileSync(path, bytes);
  const r = spawnSync('python3', ['-I', '-c', SQLITE, path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown[][]>;
}

const WGS84 = { code: 'OGC:CRS84', source: 'rfc7946-default' } as const;
const GEO_COLS = [
  { name: 'well_id', type: 'string' as const, role: 'id' as const },
  { name: 'geometry', type: 'geometry' as const, role: 'geometry' as const },
];

type Cols = NonNullable<Parameters<typeof datasetOf>[0]>;

function geoView(
  rows: CellValue[][],
  crs: { code: string; source: string } = WGS84,
  cols: Cols = GEO_COLS,
  geometry = 'c1',
) {
  return viewOf(datasetOf(cols, rows, crs as never, geometry));
}

const point = (...coordinates: number[]): CellValue => ({ geometry: { type: 'Point', coordinates } });

async function gpkgOf(view: ReturnType<typeof viewOf>) {
  const result = await buildExport(inputOf(view, { profile: 'geopackage' }), CTX);
  return { result, bytes: readZip(result.bytes ?? new Uint8Array()).read('data.gpkg') };
}

describe('GeoPackage export', () => {
  it('writes typed fields and points from latitude and longitude, and passes read-back', async () => {
    const view = viewOf(datasetOf());
    const { result, bytes } = await gpkgOf(view);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.validation.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['RB-GPKG-STRUCTURE', 'RB-GPKG-GEOMETRY', 'RB-VALUES', 'RB-HEADER', 'RB-ROWS']),
    );
    expect(result.manifest.files.filter((f) => f.role === 'data').map((f) => f.path)).toEqual(['data.gpkg']);
    const gpkg = readGeoPackage(bytes);
    const layer = gpkg.layers[0];
    expect(layer).toMatchObject({
      table: 'data',
      dataType: 'features',
      identifier: view.schema.name,
      srsId: 4326,
      extent: [1.7501, -33.9, 151.2, 57.51],
      geometry: { column: 'geom', type: 'POINT', srsId: 4326, z: 0, m: 0 },
    });
    expect(layer?.columns.map((c) => [c.name, c.type])).toEqual([
      ['fid', 'INTEGER'],
      ['geom', 'POINT'],
      ['well_id', 'TEXT'],
      ['date', 'DATE'],
      ['reading time', 'DATETIME'],
      ['Pressure [psia]', 'REAL'],
      ['Choke', 'INTEGER'],
      ['lat', 'REAL'],
      ['lon', 'REAL'],
      ['Online', 'BOOLEAN'],
      ['Note', 'TEXT'],
    ]);
    const features = [...gpkgFeatures(gpkg, layer as NonNullable<typeof layer>)];
    expect(features.map((f) => (f.blob === null ? null : readGpkgGeometry(f.blob).geometry))).toEqual([
      { type: 'Point', coordinates: [1.7501, 57.4802] },
      { type: 'Point', coordinates: [1.8, 57.51] },
      null,
      { type: 'Point', coordinates: [151.2, -33.9] },
    ]);
    expect(features[0]?.values.slice(0, 4)).toEqual(['NS-A01', '2026-01-01', '2026-01-01T06:00:00.000Z', 1205.3]);
  });

  it.skipIf(!PYTHON)('is a GeoPackage SQLite opens, checks and reads as written', async () => {
    const { bytes } = await gpkgOf(viewOf(datasetOf()));
    const db = sqlite(bytes);
    expect(db['check']).toEqual([['ok']]);
    expect(db['foreign_keys']).toEqual([]);
    expect(db['ids']).toEqual([[0x47504b47], [10200]]);
    expect(db['srs']).toEqual([
      [-1, 'NONE', -1, 'Undefined Cartesian SRS'],
      [0, 'NONE', 0, 'Undefined geographic SRS'],
      [4326, 'EPSG', 4326, 'WGS 84 geodetic'],
    ]);
    expect(db['geometry_columns']).toEqual([['data', 'geom', 'POINT', 4326, 0, 0]]);
    expect(db['columns']?.slice(0, 3)).toEqual([
      ['fid', 'INTEGER', 1],
      ['geom', 'POINT', 0],
      ['well_id', 'TEXT', 0],
    ]);
    expect(db['rows']?.map((r) => [r[0], r[1], r[4]])).toEqual([
      [1, 29, 'NS-A01'],
      [2, 29, 'NS-A02'],
      [3, null, 'NS-A03'],
      [4, 29, 'NS-A01'],
    ]);
    expect(db['sequence']).toEqual([['data', 4]]);
  });

  it('keeps any mix of geometries, heights per geometry, and the projected system with its WKT', async () => {
    const line = {
      geometry: {
        type: 'LineString',
        coordinates: [
          [400000, 100000, 12],
          [400100, 100050, 13],
        ],
      },
    };
    const uneven = {
      geometry: {
        type: 'LineString',
        coordinates: [
          [400000, 100000, 12],
          [400100, 100050],
        ],
      },
    };
    const collection = {
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [400010, 100010] },
          {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        ],
      },
    };
    const view = geoView(
      [
        ['A', point(400000, 100000, 5, 9)],
        ['B', line as CellValue],
        ['C', uneven as CellValue],
        ['D', collection as CellValue],
        ['E', null],
      ],
      { code: 'EPSG:27700', source: 'user' },
    );
    const status = profileStatuses(view, view.schema.crs).find((s) => s.profile.id === 'geopackage');
    expect(status?.substitutions.map((s) => s.what)).toEqual(['1 geometry', '1 geometry']);
    expect(status?.substitutions.map((s) => s.why)).toEqual([
      expect.stringContaining('more than three numbers'),
      expect.stringContaining('Some of their positions have heights'),
    ]);
    const { result, bytes } = await gpkgOf(view);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const gpkg = readGeoPackage(bytes);
    expect(gpkg.srs.map((s) => [s.id, s.name])).toEqual([
      [-1, 'Undefined Cartesian SRS'],
      [0, 'Undefined geographic SRS'],
      [4326, 'WGS 84 geodetic'],
      [27700, 'OSGB36 / British National Grid'],
    ]);
    expect(gpkg.srs[3]?.definition).toMatch(
      /^PROJCS\["OSGB36 \/ British National Grid",GEOGCS\["OSGB36",.*AUTHORITY\["EPSG","27700"\]\]$/,
    );
    const layer = gpkg.layers[0] as NonNullable<(typeof gpkg.layers)[0]>;
    expect(layer.geometry).toEqual({ column: 'geom', type: 'GEOMETRY', srsId: 27700, z: 2, m: 0 });
    const read = [...gpkgFeatures(gpkg, layer)].map((f) => (f.blob === null ? null : readGpkgGeometry(f.blob)));
    expect(read.map((r) => r?.geometry ?? null)).toEqual([
      { type: 'Point', coordinates: [400000, 100000, 5] },
      line.geometry,
      {
        type: 'LineString',
        coordinates: [
          [400000, 100000],
          [400100, 100050],
        ],
      },
      collection.geometry,
      null,
    ]);
    expect(read.map((r) => r?.envelope ?? null)).toEqual([
      null,
      [400000, 400100, 100000, 100050],
      [400000, 400100, 100000, 100050],
      [0, 400010, 0, 100010],
      null,
    ]);
    if (PYTHON) expect(sqlite(bytes)['check']).toEqual([['ok']]);
  });

  it('names its own fields apart from the columns of the data, and says so', async () => {
    const cols = [
      { name: 'FID', type: 'integer' as const, role: 'id' as const },
      { name: 'geom', type: 'string' as const, role: 'text' as const },
      { name: 'geometry', type: 'geometry' as const, role: 'geometry' as const },
    ];
    const view = geoView([[7, 'x', point(1, 2)]], WGS84, cols, 'c2');
    const status = profileStatuses(view, view.schema.crs).find((s) => s.profile.id === 'geopackage');
    expect(status?.substitutions).toEqual([
      expect.objectContaining({ instead: 'The feature IDs are in the field "fid_1" and the geometries in "geom_1".' }),
    ]);
    const { result, bytes } = await gpkgOf(view);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(readGeoPackage(bytes).layers[0]?.columns.map((c) => c.name)).toEqual(['fid_1', 'geom_1', 'FID', 'geom']);
  });

  it('refuses what a GeoPackage cannot record, with the reason and a fix', () => {
    const status = (
      rows: CellValue[][],
      crs: { code: string; source: string } = WGS84,
      cols: Cols = GEO_COLS,
      g = 'c1',
    ) => {
      const view = geoView(rows, crs, cols, g);
      return profileStatuses(view, view.schema.crs).find((s) => s.profile.id === 'geopackage');
    };
    expect(status([['A', point(1, 2)]])?.available).toBe(true);
    expect(status([['A', point(1, 2)]], { code: 'unknown', source: 'user' })?.fix).toBe(
      'Set the coordinate reference system of the dataset first.',
    );
    expect(status([['A', point(1, 2)]], { code: 'EPSG:3857', source: 'user' })).toMatchObject({
      available: false,
      reason:
        'A GeoPackage describes its coordinate reference system in Well-Known Text, and Tracewell has no description of EPSG:3857.',
      fix: expect.stringContaining('Export as FlatGeobuf'),
    });
    const clash = [
      { name: 'Depth', type: 'number' as const, role: 'text' as const },
      { name: 'depth', type: 'number' as const, role: 'text' as const },
      { name: 'geometry', type: 'geometry' as const, role: 'geometry' as const },
    ];
    expect(status([[1, 2, point(1, 2)]], WGS84, clash, 'c2')).toMatchObject({
      available: false,
      reason:
        'A GeoPackage field name is unique whatever the case of its letters, and the columns "Depth" and "depth" differ only in case.',
      fix: 'Rename one of the columns first.',
    });
    const plain = viewOf(datasetOf(COLS.slice(0, 5), [[null, null, null, null, null]]));
    expect(profileStatuses(plain, plain.schema.crs).find((s) => s.profile.id === 'geopackage')?.available).toBe(false);
  });

  it('fails read-back when a coordinate or a value is changed after writing', async () => {
    const view = geoView([['A', point(1, 2)]]);
    const tamper = (find: number[], replace: number[]) => ({
      ...DEFAULT_WRITERS,
      geopackage: (...args: Parameters<typeof DEFAULT_WRITERS.geopackage>) => {
        const out = DEFAULT_WRITERS.geopackage(...args);
        const at = out.findLastIndex((_, i) => find.every((b, k) => out[i + k] === b));
        out.set(replace, at);
        return out;
      },
    });
    const two = [...new Uint8Array(new Float64Array([2]).buffer)];
    const moved = await buildExport(
      inputOf(view, { profile: 'geopackage' }),
      CTX,
      tamper(two, [...new Uint8Array(new Float64Array([2.5]).buffer)]),
    );
    expect(moved.ok).toBe(false);
    expect(moved.validation.checks.filter((c) => !c.ok).map((c) => c.id)).toContain('RB-GPKG-GEOMETRY');
    // The text "A" just after the point's last coordinate, 2.0, becomes "B".
    const renamed = await buildExport(
      inputOf(view, { profile: 'geopackage' }),
      CTX,
      tamper([0x00, 0x40, 0x41], [0x00, 0x40, 0x42]),
    );
    expect(new Set(renamed.validation.checks.filter((c) => !c.ok).map((c) => c.id))).toEqual(new Set(['RB-VALUES']));
  });
});
