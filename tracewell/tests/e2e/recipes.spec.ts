import { readFileSync, writeFileSync } from 'node:fs';
import { fixturePath } from './files';
import { expect, test } from './fixtures';

/** csv_well_daily_golden.csv as next month's export: Pressure moved last, three readings missing. */
function nextMonth(): string {
  return readFileSync(fixturePath('csv_well_daily_golden.csv'), 'utf8')
    .split('\n')
    .map((line, i) => {
      if (line === '') return line;
      const fields = line.split(',');
      const [pressure] = fields.splice(4, 1);
      return [...fields, i >= 1 && i <= 3 ? '' : pressure].join(',');
    })
    .join('\n');
}

test('a recipe saved from one month runs on the next, and the register shows only new or changed issues', async ({
  app,
  page,
}, testInfo) => {
  await app.open();
  await app.importFixture('csv_well_daily_golden.csv');
  await app.convertColumn('Pressure', 'kPa', 'Report pressures in kPa');
  await app.runChecks();

  await app.menu('Data', 'Recipes…');
  await page.getByTestId('tw-recipe-name').fill('Monthly well report');
  await page.getByTestId('tw-recipe-export').selectOption('csv');
  const download = page.waitForEvent('download');
  await page.getByTestId('tw-recipe-save').click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('Monthly well report v1.twr');
  const recipePath = testInfo.outputPath(saved.suggestedFilename());
  await saved.saveAs(recipePath);
  expect(readFileSync(recipePath, 'utf8')).not.toContain('NS-A01');

  const nextPath = testInfo.outputPath('well_daily_next.csv');
  writeFileSync(nextPath, nextMonth());
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(nextPath);
  await page.getByTestId('tw-import-button').click();
  await expect(page.getByTestId('tw-grid')).toBeVisible();

  await app.menu('Data', 'Recipes…');
  await page.getByTestId('tw-recipe-file').setInputFiles(recipePath);
  const plan = page.getByTestId('tw-recipe-plan');
  await expect(plan).toContainText('Monthly well report');
  await expect(plan).toContainText('Pressure');
  await page.getByTestId('tw-recipe-run').click();
  await app.giveReason('March data, same processing');
  await expect(page.getByTestId('tw-recipe-result')).toContainText(/\d+ new/);

  await page.getByTestId('tw-recipe-issues').click();
  const view = page.getByTestId('tw-issues-view');
  await expect(view.getByTestId('tw-issue-filter-delta')).toHaveValue('new_or_changed');
  const deltas = view.getByTestId('tw-issue-delta');
  await expect(deltas.first()).toBeVisible();
  const states = await deltas.evaluateAll((cells) => cells.map((c) => c.getAttribute('data-delta')));
  expect(states.every((s) => s === 'new' || s === 'changed')).toBe(true);
  // The three missing pressures were not in the first month.
  await expect(view.locator('tr[data-rule="TW-DQ-001"]').filter({ hasText: 'Pressure' })).toContainText('New');
});
