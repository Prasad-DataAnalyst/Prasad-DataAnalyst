import { fixtureExpectation } from './files';
import { expect, test } from './fixtures';

test('xlsx_merged_two_row_header_units.xlsx shows the flattened header text', async ({ app, page }) => {
  await app.open();
  await app.importFixture('xlsx_merged_two_row_header_units.xlsx');
  const names = await page.locator('.tw-colhead-text').allInnerTexts();
  expect(names).toEqual(fixtureExpectation('xlsx_merged_two_row_header_units.xlsx').columns.map((c) => c.name));
});

test('xlsx_two_tables_one_sheet.xlsx raises TW-IMP-002 naming the second table', async ({ app, page }) => {
  await app.open();
  await app.importFixture('xlsx_two_tables_one_sheet.xlsx');
  await app.runChecks();
  const row = page.getByTestId('tw-issues-panel').locator('tr[data-rule="TW-IMP-002"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText(/[A-Z]+\d+:[A-Z]+\d+/);
});
