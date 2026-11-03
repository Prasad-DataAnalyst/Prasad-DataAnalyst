import { fixtureExpectation } from './files';
import { expect, test } from './fixtures';

test(
  'xlsx_merged_two_row_header_units.xlsx shows the flattened header text',
  { tag: '@lite' },
  async ({ app, page }) => {
    await app.open();
    await app.importFixture('xlsx_merged_two_row_header_units.xlsx');
    const names = await page.locator('.tw-colhead-text').allInnerTexts();
    expect(names).toEqual(fixtureExpectation('xlsx_merged_two_row_header_units.xlsx').columns.map((c) => c.name));
  },
);

test(
  'xlsx_two_tables_one_sheet.xlsx raises TW-IMP-002 naming the second table',
  { tag: '@lite' },
  async ({ app, page }) => {
    await app.open();
    await app.importFixture('xlsx_two_tables_one_sheet.xlsx');
    await app.runChecks();
    const row = page.getByTestId('tw-issues-panel').locator('tr[data-rule="TW-IMP-002"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText(/[A-Z]+\d+:[A-Z]+\d+/);
  },
);

test(
  'xls_merged_two_row_header_units.xls, a legacy Excel 97-2003 file, imports as its XLSX original does',
  { tag: '@lite' },
  async ({ app, page }) => {
    await app.open();
    await app.importFixture('xls_merged_two_row_header_units.xls');
    const names = await page.locator('.tw-colhead-text').allInnerTexts();
    expect(names).toEqual(fixtureExpectation('xls_merged_two_row_header_units.xls').columns.map((c) => c.name));
    expect(names).toEqual(fixtureExpectation('xlsx_merged_two_row_header_units.xlsx').columns.map((c) => c.name));
  },
);

test(
  'xlsx_two_tables_one_sheet.xlsx imports the table chosen in the preview, and the choice is logged',
  { tag: '@lite' },
  async ({ app, page }) => {
    await app.open();
    await app.importFixture('xlsx_two_tables_one_sheet.xlsx', { acceptPreview: false });
    await page.getByTestId('tw-import-option-tableIndex').selectOption({ label: 'A11:C15' });
    await expect(page.getByTestId('tw-preview-grid').locator('thead th')).toHaveCount(3);
    await page.getByTestId('tw-import-button').click();
    await app.giveReason('The second table lists the downtime events');
    await expect(page.getByTestId('tw-grid')).toBeVisible();
    expect(await page.locator('.tw-colhead-text').allInnerTexts()).toEqual(['Event', 'Duration', 'Cause']);
    await page.getByRole('tab', { name: 'Log' }).click();
    const row = page.locator('tr[data-action="detection.override"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('0 → 1');
  },
);
