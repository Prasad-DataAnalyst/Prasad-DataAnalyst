import { fixtureExpectation } from './files';
import { expect, test } from './fixtures';

test('geojson_invalid_geometries.geojson raises TW-GEO-001 for every invalid geometry', async ({ app }) => {
  await app.open();
  await app.importFixture('geojson_invalid_geometries.geojson');
  await app.runChecks();
  const counts = await app.issueCounts();
  expect(counts['TW-GEO-001']).toBe(fixtureExpectation('geojson_invalid_geometries.geojson').issues['TW-GEO-001']);
});

test('geojson_legacy_crs_27700.geojson raises TW-GEO-004 and is not offered as GeoJSON', async ({ app, page }) => {
  await app.open();
  await app.importFixture('geojson_legacy_crs_27700.geojson');
  await app.runChecks();
  expect(Object.keys(await app.issueCounts())).toContain('TW-GEO-004');
  await page.keyboard.press('Control+e');
  const card = page.getByTestId('tw-export-card-geojson');
  await expect(card).toContainText('TW-EXP-003');
  await expect(card.getByTestId('tw-export-geojson')).toBeDisabled();
});

test('fgb_assets_bng_indexed.fgb imports with its columns, its CRS and every check the library expects', async ({
  app,
  page,
}) => {
  const name = 'fgb_assets_bng_indexed.fgb';
  await app.open();
  await app.importFixture(name);
  await app.runChecks();
  expect(await app.issueCounts()).toEqual(fixtureExpectation(name).issues);
  await expect(page.getByRole('columnheader', { name: /Throughput/ })).toBeVisible();
  // A projected CRS: the FlatGeobuf and Shapefile profiles keep it, GeoJSON needs WGS 84.
  await page.keyboard.press('Control+e');
  await expect(page.getByTestId('tw-export-flatgeobuf')).toBeEnabled();
  await expect(page.getByTestId('tw-export-geojson')).toBeDisabled();
});

test('kml_wells_folders_extended.kml and kmz_pipelines_latin1.kmz import with every check the library expects', async ({
  app,
  page,
}) => {
  await app.open();
  await app.importFixture('kml_wells_folders_extended.kml');
  await app.runChecks();
  expect(await app.issueCounts()).toEqual(fixtureExpectation('kml_wells_folders_extended.kml').issues);
  await expect(page.getByRole('columnheader', { name: /folder/ })).toBeVisible();
  await app.importFixture('kmz_pipelines_latin1.kmz');
  await expect(page.getByText('Cañon gathering')).toBeVisible();
});
