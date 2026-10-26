import { spawnSync } from 'node:child_process';
import { expect, test } from './fixtures';

/** Rewrites the .twp with Python's zipfile, changing one byte of the original file. */
const TAMPER = `
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    items = [(i, z.read(i.filename)) for i in z.infolist()]
with zipfile.ZipFile(dst, "w") as out:
    for info, data in items:
        if info.filename.startswith("originals/"):
            data = data[:-3] + (b"7" if data[-3:-2] != b"7" else b"8") + data[-2:]
        out.writestr(info, data)
`;

test('a project whose original was changed opens read-only with TW-PRJ-001', async ({ app, page }, testInfo) => {
  await app.open();
  await app.importFixture('csv_null_markers.csv');
  const { path } = await app.saveProject();
  const tampered = testInfo.outputPath('tampered.twp');
  const r = spawnSync('python3', ['-I', '-c', TAMPER, path, tampered], { encoding: 'utf8' });
  expect(r.stderr).toBe('');

  await app.openProject(tampered);
  await expect(page.getByTestId('tw-open-report')).toContainText('read-only');
  await page.getByTestId('tw-open-report').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('tw-read-only').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Issues' }).click();
  await expect(page.getByTestId('tw-issues-panel').locator('tr[data-rule="TW-PRJ-001"]')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Status' })).toContainText('Read-only');
});
