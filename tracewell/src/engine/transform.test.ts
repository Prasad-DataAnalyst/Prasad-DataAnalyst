/** The coordinate transformation step (FR-PRC-02) in the TypeScript engine. */
import { describe, expect, it } from 'vitest';
import { crsTransformer } from '@tw/geo';
import type { DatasetSummary, StepResult } from '@tw/model';
import { awaitJob, checked, withProject } from './__fixtures__/session';

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Four wells on British National Grid, and a well whose easting is missing. */
const BNG =
  'well,Easting,Northing,depth\nW1,651409.903,313177.270,1200\nW2,577274.99,69740.50,980\nW3,400000,500000,1500\nW4,,250000,800\n';

async function bngDataset() {
  const engine = await withProject();
  const file = { kind: 'bytes' as const, bytes: utf8(BNG), name: 'wells.csv' };
  const ds = await awaitJob<DatasetSummary>(engine, await engine.importFile(file));
  await engine.decide({
    kind: 'override_detection',
    datasetId: ds.id,
    property: 'crs',
    value: { code: 'EPSG:27700', source: 'user' },
    reason: 'Grid stated by the survey contractor',
  });
  return { engine, id: ds.id };
}

describe('the coordinate transformation step', () => {
  it('replaces easting and northing by WGS 84 longitude and latitude, and logs the EPSG operations', async () => {
    const { engine, id } = await bngDataset();
    const preview = await engine.previewStep(id, { kind: 'transform_crs', toCrs: 'EPSG:4326' });
    expect(preview.ok).toBe(true);
    expect(preview.description).toBe(
      'Transform coordinates from EPSG:27700 (OSGB36 / British National Grid) to EPSG:4326 (WGS 84), through OSGB36 to WGS 84 (6) (EPSG:1314), accurate to 2 m',
    );
    const result = await awaitJob<StepResult>(
      engine,
      await engine.applyStep(id, { kind: 'transform_crs', toCrs: 'EPSG:4326' }, 'Map the wells in WGS 84'),
    );
    expect(result.audit.payload).toMatchObject({
      transformation: {
        from: 'EPSG:27700',
        to: 'EPSG:4326',
        accuracy: 2,
        registryVersion: '2026.2',
        operations: [
          { code: 'EPSG:27700', method: 'Transverse Mercator (EPSG method 9807)', accuracy: null },
          {
            code: 'EPSG:1314',
            method: 'Position Vector transformation (geog2D domain) (EPSG method 9606)',
            accuracy: 2,
          },
        ],
      },
    });
    const schema = await engine.getSchema(id);
    expect(schema.crs?.value).toEqual({ code: 'EPSG:4326', source: 'user' });
    expect(schema.columns.map((c) => [c.name, c.role.value, c.unit.value])).toEqual([
      ['well', 'text', null],
      ['Longitude', 'longitude', null],
      ['Latitude', 'latitude', null],
      ['depth', 'measure', null],
    ]);
    const rows = await engine.getRows({ datasetId: id, stage: 'working', offset: 0, limit: 10 });
    const t = crsTransformer('EPSG:27700', 'EPSG:4326');
    expect(rows.rows[0]?.cells.slice(1, 3)).toEqual(t.forward(651409.903, 313177.27));
    // A point with a missing coordinate is not placed.
    expect(rows.rows[3]?.cells.slice(1, 3)).toEqual([null, null]);
    // The original easting is still where a lineage starts.
    const lineage = await engine.explainCell(id, 0, schema.columns[1]?.id as string);
    expect(lineage.source.rawText).toBe('651409.903');
    expect(lineage.history.map((h) => h.action)).toEqual(['detection.override', 'step.apply']);
    // GeoJSON export, refused for British National Grid, is offered now.
    const geojson = (await engine.listExportProfiles(id)).find((p) => p.profile.id === 'geojson');
    expect(geojson?.available).toBe(true);
  });

  it('transforms every position of a geometry column, and the coordinate warning goes', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'geojson_legacy_crs_27700.geojson');
    const rules = async () =>
      (await engine.listIssues({ datasetId: ds.id, limit: 100 })).items
        .filter((i) => i.status === 'open')
        .map((i) => i.ruleId);
    expect(await rules()).toContain('TW-GEO-004');
    const before = (await engine.getSchema(ds.id)).geometryColumn as string;
    const original = (await engine.getRows({ datasetId: ds.id, stage: 'working', offset: 0, limit: 1 })).rows[0]?.cells;
    await awaitJob(
      engine,
      await engine.applyStep(ds.id, { kind: 'transform_crs', toCrs: 'EPSG:4326' }, 'WGS 84 for the map'),
    );
    const schema = await engine.getSchema(ds.id);
    expect(schema.geometryColumn).toBe(`${before}~EPSG_4326`);
    const at = schema.columns.findIndex((c) => c.id === schema.geometryColumn);
    const cells = (await engine.getRows({ datasetId: ds.id, stage: 'working', offset: 0, limit: 1 })).rows[0]?.cells;
    const g = (original?.[at] as unknown as { geometry: { coordinates: [number, number] } }).geometry;
    expect(cells?.[at]).toEqual({
      geometry: { type: 'Point', coordinates: crsTransformer('EPSG:27700', 'EPSG:4326').forward(...g.coordinates) },
    });
    expect(await rules()).not.toContain('TW-GEO-004');
  });

  it('is refused with a reason when it cannot apply', async () => {
    const { engine, id } = await bngDataset();
    const refusal = async (toCrs: string) => (await engine.previewStep(id, { kind: 'transform_crs', toCrs })).error;
    expect(await refusal('EPSG:27700')).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'The coordinates are already in EPSG:27700.',
    });
    expect(await refusal('EPSG:9999')).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'EPSG:9999 is not a coordinate reference system this edition can transform.',
    });
    const plain = await withProject();
    const file = { kind: 'bytes' as const, bytes: utf8('a,b\n1,2\n'), name: 'plain.csv' };
    const ds = await awaitJob<DatasetSummary>(plain, await plain.importFile(file));
    expect((await plain.previewStep(ds.id, { kind: 'transform_crs', toCrs: 'EPSG:4326' })).error?.message).toBe(
      'The coordinate reference system of the data is not known, so its coordinates cannot be transformed.',
    );
  });

  it('is undone by removing it, and the original coordinates come back', async () => {
    const { engine, id } = await bngDataset();
    const result = await awaitJob<StepResult>(
      engine,
      await engine.applyStep(id, { kind: 'transform_crs', toCrs: 'EPSG:32630' }, 'UTM for the field team'),
    );
    expect((await engine.getSchema(id)).columns.map((c) => c.name)).toEqual(['well', 'Easting', 'Northing', 'depth']);
    expect((await engine.getSchema(id)).crs?.value.code).toBe('EPSG:32630');
    await engine.removeStep(id, result.step.id, 'Back to the grid');
    expect((await engine.getSchema(id)).crs?.value.code).toBe('EPSG:27700');
    const rows = await engine.getRows({ datasetId: id, stage: 'working', offset: 0, limit: 1 });
    expect(rows.rows[0]?.cells.slice(1, 3)).toEqual([651409.903, 313177.27]);
  });
});
