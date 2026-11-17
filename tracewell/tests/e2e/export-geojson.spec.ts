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

test('British National Grid geometries transformed to WGS 84 export as GeoJSON', async ({ app, page }) => {
  await app.open();
  await app.importFixture('geojson_legacy_crs_27700.geojson');
  await app.runChecks();
  await app.menu('Data', 'Transform coordinates…');
  const dialog = page.getByTestId('tw-transform-dialog');
  await expect(dialog.getByTestId('tw-transform-target')).toHaveValue('EPSG:4326');
  const preview = dialog.getByTestId('tw-transform-preview');
  await expect(preview).toContainText('OSGB36 to WGS 84 (6) (EPSG:1314), accurate to 2 m');
  await dialog.getByTestId('tw-dialog-apply').click();
  await app.giveReason('WGS 84 for the map');
  await expect(dialog).toBeHidden();

  const { path } = await app.exportProfile('geojson');
  await expectAllChecksPassed(page, 'geojson');
  const facts = expectOracleAgrees(path, 'check_geojson.py') as {
    has_crs_member: boolean;
    features: number;
    in_lonlat_range: boolean;
    manifestRows: number;
  };
  expect(facts.has_crs_member).toBe(false);
  expect(facts.features).toBe(facts.manifestRows);
  expect(facts.in_lonlat_range).toBe(true);
});
