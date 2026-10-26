import { expect, test } from './fixtures';
import { expectAllChecksPassed, expectOracleAgrees } from './export-shared';

test('a GeoJSON package passes every check and the oracle', async ({ app, page }) => {
  await app.open();
  await app.importFixture('geojson_wells_points_wgs84.geojson');
  await app.runChecks();
  const { path } = await app.exportProfile('geojson');
  await expectAllChecksPassed(page, 'geojson');
  const facts = expectOracleAgrees(path, 'check_geojson.py') as {
    type: string;
    has_crs_member: boolean;
    features: number;
    valid_types: boolean;
    in_lonlat_range: boolean;
    manifestRows: number;
  };
  expect(facts.type).toBe('FeatureCollection');
  expect(facts.has_crs_member).toBe(false);
  expect(facts.features).toBe(facts.manifestRows);
  expect(facts.valid_types).toBe(true);
  expect(facts.in_lonlat_range).toBe(true);
});
