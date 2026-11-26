import { expect, test } from './fixtures';
import { expectAllChecksPassed, expectOracleAgrees } from './export-shared';

test('a GeoPackage package passes every check, and SQLite itself opens and agrees with it', async ({ app, page }) => {
  await app.open();
  await app.importFixture('geojson_wells_points_wgs84.geojson');
  await app.runChecks();
  const { path } = await app.exportProfile('geopackage');
  await expectAllChecksPassed(page, 'geopackage');
  const facts = expectOracleAgrees(path, 'check_geopackage.py') as {
    integrity: string[];
    foreign_keys: unknown[];
    application_id: number;
    user_version: number;
    srs_ids: number[];
    srs: { org: string; code: number; name: string; wkt: string };
    table: string;
    data_type: string;
    geometry_column: { name: string; type: string; srs_id: number; z: number; m: number };
    geometry_srs_ids: number[];
    fids_in_order: boolean;
    features: number;
    with_geometry: number;
    manifestRows: number;
  };
  expect(facts.integrity).toEqual(['ok']);
  expect(facts.foreign_keys).toEqual([]);
  expect([facts.application_id, facts.user_version]).toEqual([0x47504b47, 10200]);
  expect(facts.srs_ids).toEqual([-1, 0, 4326]);
  expect(facts.srs).toEqual({ org: 'EPSG', code: 4326, name: 'WGS 84 geodetic', wkt: 'GEOGCS[' });
  expect([facts.table, facts.data_type]).toEqual(['data', 'features']);
  expect(facts.geometry_column).toEqual({ name: 'geom', type: 'POINT', srs_id: 4326, z: 0, m: 0 });
  expect(facts.geometry_srs_ids).toEqual([4326]);
  expect(facts.fids_in_order).toBe(true);
  expect(facts.features).toBe(facts.manifestRows);
  expect(facts.with_geometry).toBe(facts.manifestRows);
});
