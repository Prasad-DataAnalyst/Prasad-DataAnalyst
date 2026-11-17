/** Where a dataset's rows are on the map (getPlaces, FR-MAP-01) in the TypeScript engine. */
import { describe, expect, it } from 'vitest';
import { crsTransformer } from '@tw/geo';
import type { DatasetSummary, StepResult } from '@tw/model';
import { awaitJob, checked, withProject } from './__fixtures__/session';

const utf8 = (s: string) => new TextEncoder().encode(s);

const BNG = 'well,Easting,Northing\nW1,651409.903,313177.270\nW2,,250000\nW3,400000,500000\n';

async function csv(text: string) {
  const engine = await withProject();
  const file = { kind: 'bytes' as const, bytes: utf8(text), name: 'wells.csv' };
  const ds = await awaitJob<DatasetSummary>(engine, await engine.importFile(file));
  return { engine, id: ds.id };
}

describe('getPlaces', () => {
  it('places WGS 84 points as they are, and a drawn area can filter them', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'geojson_wells_points_wgs84.geojson');
    const p = await engine.getPlaces({ datasetId: ds.id, stage: 'working' });
    expect(p).toMatchObject({ transformed: false, unplaced: null, truncated: false });
    expect(p.placed).toBe(p.rows);
    const rows = await engine.getRows({ datasetId: ds.id, stage: 'working', offset: 0, limit: 1 });
    const g = (await engine.getSchema(ds.id)).geometryColumn as string;
    const at = rows.columns.findIndex((c) => c.id === g);
    expect(p.features[0]).toEqual({ rowId: 0, ...(rows.rows[0]?.cells[at] as object) });
    // The first features only, with the rest counted.
    const one = await engine.getPlaces({ datasetId: ds.id, stage: 'working', limit: 1 });
    expect([one.features.length, one.placed, one.truncated]).toEqual([1, p.placed, true]);
  });

  it('transforms British National Grid coordinates to WGS 84 and leaves out what has no position', async () => {
    const { engine, id } = await csv(BNG);
    expect((await engine.getPlaces({ datasetId: id, stage: 'working' })).unplaced?.reason).toBe(
      'The coordinate reference system of the data is not known, so its rows cannot be placed on the map.',
    );
    await engine.decide({
      kind: 'override_detection',
      datasetId: id,
      property: 'crs',
      value: { code: 'EPSG:27700', source: 'user' },
      reason: 'Grid stated by the survey contractor',
    });
    const p = await engine.getPlaces({ datasetId: id, stage: 'working' });
    const t = crsTransformer('EPSG:27700', 'EPSG:4326');
    expect(p).toMatchObject({ crs: 'EPSG:27700', transformed: true, rows: 3, placed: 2 });
    expect(p.features).toEqual([
      { rowId: 0, geometry: { type: 'Point', coordinates: t.forward(651409.903, 313177.27) } },
      { rowId: 2, geometry: { type: 'Point', coordinates: t.forward(400000, 500000) } },
    ]);
    await engine.decide({
      kind: 'override_detection',
      datasetId: id,
      property: 'crs',
      value: { code: 'EPSG:3857', source: 'user' },
      reason: 'Web map coordinates',
    });
    expect((await engine.getPlaces({ datasetId: id, stage: 'working' })).unplaced).toEqual({
      reason: 'EPSG:3857 is not a coordinate reference system this edition can transform.',
      fix: 'Choose a listed coordinate reference system.',
    });
  });

  it('refuses a bad stage or limit', async () => {
    const { engine, id } = await csv(BNG);
    await expect(engine.getPlaces({ datasetId: id, stage: 'final' as 'working' })).rejects.toThrow(
      'The stage final does not exist.',
    );
    await expect(engine.getPlaces({ datasetId: id, stage: 'working', limit: 100_001 })).rejects.toThrow(
      'limit must be a whole number from 0 to 100000',
    );
  });
});

describe('a step that would break an earlier one', () => {
  it('is refused when it replaces the column an earlier filter reads', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'geojson_wells_points_wgs84.geojson');
    const geometry = (await engine.getSchema(ds.id)).geometryColumn as string;
    await awaitJob<StepResult>(
      engine,
      await engine.applyStep(
        ds.id,
        { kind: 'filter', predicate: { bbox: [-180, -90, 180, 90], geometry } },
        'Everything, for now',
      ),
    );
    const s = { kind: 'transform_crs', toCrs: 'EPSG:32631' } as const;
    const preview = await engine.previewStep(ds.id, s);
    expect(preview.error).toMatchObject({
      message: 'This step would break step s1, which uses a column it replaces.',
      fix: 'Remove step s1 first, then apply it again after this step.',
    });
    await expect(engine.applyStep(ds.id, s, 'UTM')).rejects.toThrow('would break step s1');
  });
});
