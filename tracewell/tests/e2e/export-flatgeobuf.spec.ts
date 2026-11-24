import { expect, test } from './fixtures';
import { expectAllChecksPassed, expectOracleAgrees } from './export-shared';

test('a FlatGeobuf package passes every check and an independent reader agrees with it', async ({ app, page }) => {
  await app.open();
  await app.importFixture('geojson_wells_points_wgs84.geojson');
  await app.runChecks();
  const { path } = await app.exportProfile('flatgeobuf');
  await expectAllChecksPassed(page, 'flatgeobuf');
  const facts = expectOracleAgrees(path, 'check_flatgeobuf.py') as {
    magic: string;
    geometry_type: string;
    has_z: boolean;
    crs: { org: string; code: number; name: string };
    features_count: number;
    features: number;
    with_geometry: number;
    manifestRows: number;
  };
  expect(facts.magic).toBe('6667620366676201');
  expect(facts.crs).toEqual({ org: 'EPSG', code: 4326, name: 'WGS 84' });
  expect(facts.features).toBe(facts.manifestRows);
  expect(facts.features_count).toBe(facts.manifestRows);
  expect(facts.with_geometry).toBe(facts.manifestRows);
});
