import { describe, expect, it } from 'vitest';
import { readZip } from '@tw/io';
import type { CellValue } from '@tw/model';
import { CTX, COLS, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport, profileStatuses } from './index';

describe('GeoJSON export', () => {
  it('builds points from latitude and longitude columns and passes read-back', async () => {
    const result = await buildExport(inputOf(viewOf(datasetOf()), { profile: 'geojson' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const doc = JSON.parse(readZip(result.bytes ?? new Uint8Array()).readText('data.geojson')) as {
      type: string;
      crs?: unknown;
      features: { geometry: { coordinates: number[] } | null }[];
    };
    expect(doc.type).toBe('FeatureCollection');
    expect(doc.crs).toBeUndefined();
    expect(doc.features[0]?.geometry?.coordinates).toEqual([1.7501, 57.4802]);
    expect(doc.features[2]?.geometry).toBeNull();
  });

  it('writes the geometry column of a GeoJSON dataset', async () => {
    const cols = [
      { name: 'well_id', type: 'string' as const, role: 'id' as const },
      { name: 'geometry', type: 'geometry' as const, role: 'geometry' as const },
    ];
    const rows: CellValue[][] = [
      ['A', { geometry: { type: 'Point', coordinates: [1.5, 57.25] } }],
      [
        'B',
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [1, 57],
              [2, 58],
            ],
          },
        },
      ],
      ['C', null],
    ];
    const view = viewOf(datasetOf(cols, rows, { code: 'OGC:CRS84', source: 'rfc7946-default' }, 'c1'));
    const result = await buildExport(inputOf(view, { profile: 'geojson' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('refuses data that is not WGS84 with EXPORT_REFUSED and the TW-EXP-003 reason', async () => {
    const view = viewOf(datasetOf(COLS, undefined, { code: 'EPSG:27700', source: 'geojson-crs-member' }));
    await expect(buildExport(inputOf(view, { profile: 'geojson' }), CTX)).rejects.toMatchObject({
      code: 'EXPORT_REFUSED',
      message: expect.stringContaining('TW-EXP-003'),
      fix: expect.stringContaining('CSV or Excel'),
    });
    const geo = profileStatuses(view, view.schema.crs).find((s) => s.profile.id === 'geojson');
    expect(geo?.available).toBe(false);
  });

  it('refuses a dataset without any location', async () => {
    const view = viewOf(datasetOf(COLS.slice(0, 5), [[null, null, null, null, null]]));
    await expect(buildExport(inputOf(view, { profile: 'geojson' }), CTX)).rejects.toMatchObject({
      code: 'EXPORT_REFUSED',
    });
  });
});
