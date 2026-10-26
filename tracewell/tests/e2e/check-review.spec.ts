import { fixtureExpectation } from './files';
import { expect, test } from './fixtures';

test('checks, review decisions, undo and lineage on csv_well_daily_golden.csv', async ({ app, page }) => {
  await app.open();
  await app.importFixture('csv_well_daily_golden.csv');
  await app.runChecks();
  expect(await app.issueCounts()).toEqual(fixtureExpectation('csv_well_daily_golden.csv').issues);

  // An edit needs a reason of at least three characters.
  const cell = await app.cell(0, 'Pressure');
  await cell.click();
  await page.keyboard.press('Enter');
  await page.getByTestId('tw-cell-editor').fill('1860.5');
  await page.getByTestId('tw-cell-editor').press('Enter');
  const record = page.getByRole('button', { name: 'Record' });
  await page.getByTestId('tw-reason-input').fill('ab');
  await expect(record).toBeDisabled();
  await page.getByTestId('tw-reason-input').fill('Gauge re-read');
  await expect(record).toBeEnabled();
  await record.click();
  await expect(await app.cell(0, 'Pressure')).toHaveClass(/tw-cell-edited/);

  await page.getByRole('tab', { name: 'Log' }).click();
  const edit = page.locator('tr[data-action="cell.edit"]');
  await expect(edit).toContainText('1860 → 1860.5');
  await expect(edit).toContainText('Gauge re-read');
  await expect(edit).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  await expect(page.getByTestId('tw-chain-status')).toContainText('verified');

  // Accept the time-zone note, exclude the duplicate-key rows.
  await page.getByRole('tab', { name: 'Issues' }).click();
  const panel = page.getByTestId('tw-issues-panel');
  await panel.locator('tr[data-rule="TW-TIME-004"]').click();
  await panel.getByTestId('tw-issue-action-accept-all').click();
  await app.giveReason('Logger runs on UTC');
  await expect(panel.locator('tr[data-rule="TW-TIME-004"]')).toContainText('Resolved');
  await panel.locator('tr[data-rule="TW-DQ-003"]').click();
  await panel.getByTestId('tw-issue-action-exclude-all').click();
  await app.giveReason('Duplicate transmissions');
  await expect(panel.locator('tr[data-rule="TW-DQ-003"]')).toContainText('Resolved');

  // Undo the exclusion.
  await app.menu('Edit', 'Undo last change…');
  await app.giveReason('Excluded too early');
  await page.getByRole('tab', { name: 'Log' }).click();
  await expect(page.locator('tr[data-action="entry.revert"]')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Issues' }).click();
  await expect(panel.locator('tr[data-rule="TW-DQ-003"]')).toContainText('Open');

  // Lineage of the edited cell.
  await (await app.cell(0, 'Pressure')).click();
  const lineage = page.getByTestId('tw-lineage');
  await expect(lineage).toContainText('line 2, field 5');
  await expect(lineage).toContainText('cell.edit');
  await expect(lineage).toContainText('Gauge re-read');
});
