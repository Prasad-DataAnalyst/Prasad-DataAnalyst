import { writeFileSync } from 'node:fs';
import { rasterPmtiles } from '../../fixtures/pmtiles';
import { chooseFile, expect, test } from './fixtures';

test('wells on the map: placed, drawn over a basemap file, and filtered by a drawn area', async ({
  app,
  page,
}, testInfo) => {
  await app.open();
  await app.importFixture('geojson_wells_points_wgs84.geojson');
  await app.menu('View', 'Map');
  const canvas = page.getByTestId('tw-map-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('tw-map-status')).toContainText('10 of 10 rows placed · OGC:CRS84');
  expect(Number(await canvas.getAttribute('data-rendered'))).toBe(10);

  // A basemap read from a local PMTiles file; nothing is fetched (the offline guard checks).
  const file = testInfo.outputPath('test.pmtiles');
  writeFileSync(file, rasterPmtiles([200, 220, 240]));
  await page.getByTestId('tw-map-basemap').setInputFiles(file);
  await expect(page.getByTestId('tw-map-basemap-status')).toContainText('test.pmtiles (raster, zoom 0 to 0)');
  await expect(canvas).toHaveAttribute('data-basemap', 'loaded');

  // A box over the western half of the map keeps the wells inside it, as a logged filter step.
  await page.getByTestId('tw-map-draw').click();
  const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 5, { steps: 5 });
  await page.mouse.up();
  const area = page.getByTestId('tw-map-area');
  await expect(area).toContainText('Keep rows where location is within');
  const kept = Number(/: (\d+) of 10 rows kept/.exec((await area.textContent()) ?? '')?.[1]);
  expect(kept).toBeGreaterThan(0);
  expect(kept).toBeLessThan(10);
  await area.getByTestId('tw-map-area-apply').click();
  await app.giveReason('Wells in the western block');
  await expect(area).toBeHidden();
  await page.getByTestId('tw-map-stage').getByRole('radio', { name: 'Output' }).click();
  await expect(page.getByTestId('tw-map-status')).toContainText(`${kept} of ${kept} rows placed`);
  await page.getByRole('tab', { name: 'Log' }).click();
  await expect(page.locator('tr[data-action="step.apply"]')).toContainText('location is within');
});

test('a place clicked on the map selects its row, and data without a known CRS is not placed', async ({
  app,
  page,
}, testInfo) => {
  await app.open();
  const path = testInfo.outputPath('one_well.csv');
  writeFileSync(path, 'well,lat,lon,depth\nW1,57.5,1.5,1200\n');
  await chooseFile(page, 'Control+i', path);
  await page.getByTestId('tw-import-button').click();
  await expect(page.getByTestId('tw-grid')).toBeVisible();
  await app.menu('View', 'Map');
  const canvas = page.getByTestId('tw-map-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('tw-map-status')).toContainText('1 of 1 rows placed · EPSG:4326');
  // The one well is in the middle of the map, which is fitted to it.
  const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(canvas).toHaveAttribute('data-selected', '0');
  await expect(page.getByTestId('tw-properties')).toContainText('one_well.csvline 2, field 3');

  // Coordinates whose CRS is not known are not placed, with the reason and the fix, and no area
  // can be drawn for them.
  const grid = testInfo.outputPath('wells_bng.csv');
  writeFileSync(grid, 'well,Easting,Northing\nW1,651409.903,313177.270\nW2,400000,500000\n');
  await chooseFile(page, 'Control+i', grid);
  await page.getByTestId('tw-import-button').click();
  await expect(page.getByTestId('tw-grid')).toBeVisible();
  await app.menu('View', 'Map');
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be placed on the map' })).toContainText(
    'Set the coordinate reference system of the dataset first.',
  );
  await expect(page.getByTestId('tw-map-draw')).toBeDisabled();
});

test('more wells than the map draws show as density cells, and a cell clicked shows its wells', async ({
  app,
  page,
}, testInfo) => {
  // 25,000 wells on a grid over the North Sea, more than the 20,000 the map draws as places.
  const lines = ['well,lat,lon'];
  for (let i = 0; i < 25_000; i++)
    lines.push(`W${i},${(55 + Math.floor(i / 250) * 0.05).toFixed(2)},${(-2 + (i % 250) * 0.02).toFixed(2)}`);
  const path = testInfo.outputPath('many_wells.csv');
  writeFileSync(path, `${lines.join('\n')}\n`);
  await app.open();
  await chooseFile(page, 'Control+i', path);
  await page.getByTestId('tw-import-button').click();
  await expect(page.getByTestId('tw-grid')).toBeVisible({ timeout: 60_000 });
  await app.menu('View', 'Map');
  const canvas = page.getByTestId('tw-map-canvas');
  await expect(canvas).toHaveAttribute('data-mode', 'density', { timeout: 30_000 });
  const status = page.getByTestId('tw-map-status');
  await expect(status).toContainText('25,000 of 25,000 rows placed · EPSG:4326 · density of the 25,000 in view');
  expect(Number(await canvas.getAttribute('data-cells'))).toBeGreaterThan(10);

  // A cell in the middle of the wells zooms the map to it, where its wells are few enough to draw.
  const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(canvas).toHaveAttribute('data-mode', 'points', { timeout: 30_000 });
  await expect(status).toContainText('in view drawn');
  await expect.poll(async () => Number(await canvas.getAttribute('data-rendered'))).toBeGreaterThan(0);
});
