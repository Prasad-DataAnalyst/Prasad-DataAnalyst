import { expect, test } from './fixtures';

test('csv_semicolon_decimalcomma_cp1252.csv shows the assumed encoding, and a changed delimiter is logged', async ({
  app,
  page,
}) => {
  await app.open();
  await app.importFixture('csv_semicolon_decimalcomma_cp1252.csv', { acceptPreview: false });
  const encoding = page.getByTestId('tw-detection-encoding');
  await expect(encoding).toContainText('windows-1252');
  await expect(encoding.getByTestId('tw-assumed')).toBeVisible();
  await expect(page.getByTestId('tw-detection-delimiter')).toContainText(';');

  await page.getByTestId('tw-import-option-delimiter').selectOption(',');
  await expect(page.getByTestId('tw-preview-grid').locator('thead th')).toHaveCount(1);
  await page.getByTestId('tw-import-button').click();
  await app.giveReason('Checking the comma reading');
  await expect(page.getByTestId('tw-grid')).toBeVisible();

  await page.getByRole('tab', { name: 'Log' }).click();
  const row = page.locator('tr[data-action="detection.override"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('; → ,');
  await expect(row).toContainText('Checking the comma reading');
});
