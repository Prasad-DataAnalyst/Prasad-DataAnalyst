import { describe, expect, it } from 'vitest';
import { readKml } from '@tw/formats-kml';
import { readZip } from '@tw/io';
import type { CellValue } from '@tw/model';
import { CTX, COLS, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport, profileStatuses } from './index';
import { DEFAULT_WRITERS } from './writers';

const WGS84 = { code: 'OGC:CRS84', source: 'rfc7946-default' } as const;
const GEO_COLS = [
  { name: 'well_id', type: 'string' as const, role: 'id' as const },
  { name: 'geometry', type: 'geometry' as const, role: 'geometry' as const },
];

describe('KML export', () => {
  it('writes one placemark per row from latitude and longitude, named by the ID column, and passes read-back', async () => {
    const view = viewOf(datasetOf());
    const result = await buildExport(inputOf(view, { profile: 'kml' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.validation.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['RB-KML-STRUCTURE', 'RB-KML-GEOMETRY', 'RB-VALUES', 'RB-HEADER', 'RB-ROWS']),
    );
    const doc = readKml(readZip(result.bytes ?? new Uint8Array()).read('data.kml'));
    expect(doc.placemarks.map((p) => p.name)).toEqual(['NS-A01', 'NS-A02', 'NS-A03', 'NS-A01']);
    expect(doc.placemarks.map((p) => p.geometry)).toEqual([
      { type: 'Point', coordinates: [1.7501, 57.4802] },
      { type: 'Point', coordinates: [1.8, 57.51] },
      null,
      { type: 'Point', coordinates: [151.2, -33.9] },
    ]);
    expect(doc.placemarks[0]?.data.map(([n]) => n)).toEqual([
      'well_id',
      'date',
      'reading time',
      'Pressure [psia]',
      'Choke',
      'lat',
      'lon',
      'Online',
      'Note',
    ]);
  });

  it('keeps every kind of geometry, collections included, and passes read-back', async () => {
    const rows: CellValue[][] = [
      ['A', { geometry: { type: 'Point', coordinates: [1.5, 57.25, 30] } }],
      [
        'B',
        {
          geometry: {
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
        },
      ],
      [
        'C',
        {
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: [1, 2] },
              {
                type: 'LineString',
                coordinates: [
                  [1, 2],
                  [3, 4],
                ],
              },
            ],
          },
        },
      ],
      ['D', null],
    ];
    const view = viewOf(datasetOf(GEO_COLS, rows, WGS84, 'c1'));
    const result = await buildExport(inputOf(view, { profile: 'kml' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.manifest.substitutions).toEqual([]);
  });

  it('moves text XML cannot carry to a CSV beside it, and says so', async () => {
    const cols = [...GEO_COLS, { name: 'Remarks', type: 'string' as const, role: 'text' as const }];
    const point: CellValue = { geometry: { type: 'Point', coordinates: [1, 2] } };
    const view = viewOf(
      datasetOf(
        cols,
        [
          ['A', point, 'bell \u0007'],
          ['B', point, 'fine'],
        ],
        WGS84,
        'c1',
      ),
    );
    const result = await buildExport(inputOf(view, { profile: 'kml' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.manifest.substitutions).toEqual([
      expect.objectContaining({ ruleId: 'TW-EXP-002', what: 'the column Remarks' }),
    ]);
    expect(readZip(result.bytes ?? new Uint8Array()).readText('data-long-text.csv')).toContain('bell \u0007');
  });

  it('refuses data that is not in WGS 84, or without places, with a fix', () => {
    const grid = viewOf(datasetOf(COLS, undefined, { code: 'EPSG:27700', source: 'user' }));
    expect(profileStatuses(grid, grid.schema.crs).find((s) => s.profile.id === 'kml')).toMatchObject({
      available: false,
      reason: 'KML holds WGS 84 longitude and latitude; this dataset is in EPSG:27700.',
      fix: expect.stringContaining('Transform the coordinates to EPSG:4326'),
    });
    const plain = viewOf(datasetOf(COLS.slice(0, 5), [[null, null, null, null, null]]));
    expect(profileStatuses(plain, plain.schema.crs).find((s) => s.profile.id === 'kml')?.available).toBe(false);
  });

  it('fails read-back when a coordinate is changed after writing', async () => {
    const view = viewOf(
      datasetOf(GEO_COLS, [['A', { geometry: { type: 'Point', coordinates: [1, 2] } }]], WGS84, 'c1'),
    );
    const writers = {
      ...DEFAULT_WRITERS,
      kml: (...args: Parameters<typeof DEFAULT_WRITERS.kml>) =>
        new TextEncoder().encode(new TextDecoder().decode(DEFAULT_WRITERS.kml(...args)).replace('1,2', '1,2.5')),
    };
    const result = await buildExport(inputOf(view, { profile: 'kml' }), CTX, writers);
    expect(result.ok).toBe(false);
    expect(result.validation.checks.filter((c) => !c.ok).map((c) => c.id)).toContain('RB-KML-GEOMETRY');
  });
});
