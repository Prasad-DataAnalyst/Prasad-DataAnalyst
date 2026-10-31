import { expect, test } from './fixtures';

test('a mapping template saved from csv_well_daily_golden.csv is applied to the next import after a reload', async ({
  app,
  page,
}) => {
  await app.open();
  // Rename the pressure column in the preview and import with a reason.
  await app.importFixture('csv_well_daily_golden.csv', { acceptPreview: false });
  await page.getByTestId('tw-import-column-c4-name').fill('BHP');
  await page.getByTestId('tw-import-button').click();
  await app.giveReason('Field data dictionary, March 2026');
  await expect(page.getByTestId('tw-grid')).toBeVisible();

  await app.menu('Data', 'Mapping templates…');
  await page.getByTestId('tw-template-name').fill('Daily wells');
  await page.getByTestId('tw-template-save').click();
  const row = page.getByTestId('tw-templates-view').locator('tr', { hasText: 'Daily wells' });
  await expect(row).toContainText('csv_well_daily_golden.csv');
  await expect(row).toContainText('9');

  // Templates outlive the page: a new session after a reload still has it.
  await page.reload();
  // The profile is remembered, so the app starts without asking for it.
  await app.open({ profile: false });
  await app.importFixture('csv_well_daily_golden.csv', { acceptPreview: false });
  const note = page.getByTestId('tw-import-template');
  await expect(note).toContainText('Daily wells');
  await expect(note).toContainText('sets 1 column');
  await expect(page.getByTestId('tw-import-column-c4-name')).toHaveValue('BHP');

  // Declining shows the detected name again, and the template can be applied again.
  await page.getByTestId('tw-import-template-toggle').click();
  await expect(note).toContainText('not applied');
  await expect(page.getByTestId('tw-import-column-c4-name')).toHaveValue('Pressure');
  await page.getByTestId('tw-import-template-toggle').click();
  await expect(page.getByTestId('tw-import-column-c4-name')).toHaveValue('BHP');

  // Importing records the template's change without asking for a reason.
  await page.getByTestId('tw-import-button').click();
  await expect(page.getByTestId('tw-grid')).toBeVisible();
  await expect(page.locator('.tw-colhead-text', { hasText: 'BHP' })).toBeVisible();
});
