import { readFileSync } from 'node:fs';
import { fixturePath } from './files';
import { expect, test } from './fixtures';

const PSI_IN_PA = 6894.757293168361; // NIST SP 811 (2008) Appendix B.8: 1 psi = 4.4482216152605 N / (0.0254 m)²

test('psia to kPa uses the cited factor, refuses psig, and a filter reduces the rows', async ({ app, page }) => {
  await app.open();
  await app.importFixture('csv_well_daily_golden.csv');

  // The refusal: absolute and gauge pressure need an atmospheric reference.
  const id = await app.columnId('Pressure');
  await page.getByTestId(`tw-header-menu-${id}`).click();
  await page.getByTestId('tw-header-action-convert').click();
  await page.getByTestId('tw-convert-unit').fill('psig');
  const preview = page.getByTestId('tw-convert-preview');
  await expect(preview).toContainText(/gauge/i);
  await expect(page.getByTestId('tw-convert-dialog').getByTestId('tw-dialog-apply')).toBeDisabled();
  await page.getByTestId('tw-convert-dialog').getByTestId('tw-dialog-cancel').click();

  await app.convertColumn('Pressure', 'kPa', 'Report in kPa');
  const firstLine = readFileSync(fixturePath('csv_well_daily_golden.csv'), 'utf8').split(/\r?\n/)[1] as string;
  const psia = Number(firstLine.split(',')[4]);
  const cell = page.getByTestId(`tw-cell-0-${id}~kPa`);
  const stored = Number(((await cell.getAttribute('title')) ?? '').replace(/^n:/, ''));
  expect(Math.abs(stored - (psia * PSI_IN_PA) / 1000) / ((psia * PSI_IN_PA) / 1000)).toBeLessThan(1e-12);

  await page.getByRole('tab', { name: 'Log' }).click();
  const step = page.locator('tr[data-action="step.apply"]');
  await expect(step).toContainText('6894.757293168361');
  await expect(step).toContainText('NIST');

  const well = await app.columnId('well_id');
  const before = await app.statusText();
  await app.addFilter(
    { combinator: 'all', conditions: [{ columnId: well, op: 'eq', value: 'NS-A01' }] },
    'One well only',
  );
  const rows = readFileSync(fixturePath('csv_well_daily_golden.csv'), 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.startsWith('NS-A01,')).length;
  await expect(page.getByRole('status', { name: 'Status' })).toContainText(`${rows} rows`);
  expect(await app.statusText()).not.toBe(before);
});
