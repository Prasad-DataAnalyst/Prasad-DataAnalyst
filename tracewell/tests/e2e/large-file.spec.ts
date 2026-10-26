import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

/** A synthetic daily production file of `rows` rows (deterministic, no randomness). */
function bigCsv(rows: number): Buffer {
  const lines = ['well_id,date,Oil (bbl/d),Gas (Mscf/d),Pressure (psia)'];
  for (let i = 0; i < rows; i++) {
    const day = new Date(Date.UTC(2020, 0, 1) + (i % 2000) * 86_400_000).toISOString().slice(0, 10);
    lines.push(
      `W-${String(i % 500).padStart(3, '0')},${day},${(1000 + (i % 977) * 0.5).toFixed(1)},${(2000 + (i % 613)).toFixed(1)},${(1500 + (i % 389) * 0.25).toFixed(2)}`,
    );
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

test.describe('@slow large files', () => {
  test.setTimeout(600_000);

  test('a one-million-row CSV previews within 5 s and imports; the time is recorded', async ({
    app,
    page,
  }, testInfo) => {
    const path = testInfo.outputPath('million.csv');
    writeFileSync(path, bigCsv(1_000_000));
    await app.open();
    const started = Date.now();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+i');
    await (await chooser).setFiles(path);
    await expect(page.getByTestId('tw-import-view')).toBeVisible();
    const previewMs = Date.now() - started;
    expect(previewMs).toBeLessThan(5_000);
    const importStart = Date.now();
    await page.getByTestId('tw-import-button').click();
    await expect(page.getByTestId('tw-grid')).toBeVisible({ timeout: 540_000 });
    const importMs = Date.now() - importStart;
    const pageStart = Date.now();
    await page.getByRole('grid').evaluate((g) => g.parentElement?.scrollTo({ top: 1e7 }));
    await expect(page.locator('[role="gridcell"]').last()).not.toBeEmpty();
    const pageMs = Date.now() - pageStart;
    mkdirSync('test-results', { recursive: true });
    const file = join('test-results', 'benchmarks.json');
    let prior: Record<string, unknown>;
    try {
      prior = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      prior = {};
    }
    writeFileSync(file, JSON.stringify({ ...prior, million: { previewMs, importMs, pageMs } }, null, 2));
  });

  test('with a lowered budget a large import stops cleanly with TW-IMP-006', async ({ app, page }, testInfo) => {
    const path = testInfo.outputPath('large.csv');
    writeFileSync(path, bigCsv(400_000));
    await page.goto('/?budget=5000000');
    await page.getByTestId('tw-profile-name').fill('Prasad');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.waitForFunction(() => window.__tracewellReady === true);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+i');
    await (await chooser).setFiles(path);
    await page.getByTestId('tw-import-button').click();
    await expect(page.getByTestId('tw-grid')).toBeVisible({ timeout: 300_000 });
    await app.runChecks();
    await expect(page.getByTestId('tw-issues-panel').locator('tr[data-rule="TW-IMP-006"]')).toBeVisible();
  });
});
