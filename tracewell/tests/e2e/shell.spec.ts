import { expect, test } from './fixtures';
import { CANONICAL_VECTORS, runOracle } from './oracle';

test('the production build boots offline with the enterprise frame', async ({ app, page }) => {
  await app.open();
  await app.importFixture('csv_well_daily_golden.csv');
  for (const role of ['menubar', 'toolbar', 'tree', 'grid'] as const)
    await expect(page.getByRole(role).first()).toBeVisible();
  await expect(page.getByRole('status', { name: 'Status' })).toContainText('Offline');
});

test('Alt then the arrow keys open the File menu', async ({ app, page }) => {
  await app.open();
  await page.keyboard.press('Alt');
  await expect(page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
  await expect(page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'Import file…' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('About names the owner and the worker answers', async ({ app, page }) => {
  await app.open();
  await app.menu('Help', 'About Tracewell');
  await expect(page.getByRole('dialog')).toContainText('Prasad');
  await expect(page.getByRole('dialog')).toContainText('Works offline');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('tw-properties')).toContainText('Untitled project');
});

test('the Python oracle agrees with every canonical vector', () => {
  expect(runOracle('canonical.py', [CANONICAL_VECTORS])).toEqual({ ok: true, failures: [] });
});
