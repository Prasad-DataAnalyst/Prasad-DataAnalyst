import { fixtureExpectation } from './files';
import { expect, test } from './fixtures';

test('json_api_wrapper_nested.json imports the records under "data" and scores the water cut over 100 %', async ({
  app,
  page,
}) => {
  const expected = fixtureExpectation('json_api_wrapper_nested.json');
  await app.open();
  await app.importFixture('json_api_wrapper_nested.json');
  expect(await page.locator('.tw-colhead-text').allInnerTexts()).toEqual(expected.columns.map((c) => c.name));
  await app.runChecks();
  const counts = await app.issueCounts();
  expect(counts['TW-DQ-005']).toBe(expected.issues['TW-DQ-005']);
  // The Review stage opens the dataset's issues register with its health score. One of six rows
  // is beyond a physical limit: 5 of 6 rows, rounded down to one decimal.
  await page.locator('[data-stage="review"]').click();
  await expect(page.getByTestId('tw-health-range')).toContainText('83.3');
});

test('parquet_well_daily_typed.parquet keeps its stored types and its UTC times need no assumption', async ({
  app,
  page,
}) => {
  const expected = fixtureExpectation('parquet_well_daily_typed.parquet');
  await app.open();
  await app.importFixture('parquet_well_daily_typed.parquet');
  expect(await page.locator('.tw-colhead-text').allInnerTexts()).toEqual(expected.columns.map((c) => c.name));
  await app.runChecks();
  const counts = await app.issueCounts();
  expect(Object.keys(counts).sort()).toEqual(Object.keys(expected.issues).sort());
});
