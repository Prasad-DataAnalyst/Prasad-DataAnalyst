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
