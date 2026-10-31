import { expect, test } from './fixtures';

test('work left unsaved when the page closed is recovered exactly on the next start', async ({ app, page }) => {
  await app.open();
  await app.importFixture('csv_null_markers.csv');
  await app.runChecks();
  await app.editCell(1, 'Pressure', '1511', 'Field sheet value');
  const counts = await app.issueCounts();
  await page.getByRole('tab', { name: 'Log' }).click();
  const auditRows = await page.locator('tr[data-action]').count();

  // An unexpected close: the page goes away without saving.
  await page.reload();
  const prompt = page.getByTestId('tw-recovery');
  await expect(prompt).toContainText('Untitled project');
  await expect(prompt).toContainText(`${auditRows - 1} changes`);
  await page.getByTestId('tw-recovery-recover').click();
  await page.waitForFunction(() => window.__tracewellReady === true);

  expect(await app.issueCounts()).toEqual(counts);
  await page.getByRole('tab', { name: 'Log' }).click();
  await expect(page.locator('tr[data-action]')).toHaveCount(auditRows);
  await expect(await app.cell(1, 'Pressure')).toHaveClass(/tw-cell-edited/);

  // Recovered work is this session's now: closing again offers it again, not twice.
  await page.reload();
  await expect(page.getByTestId('tw-recovery')).toContainText(`${auditRows - 1} changes`);
});
