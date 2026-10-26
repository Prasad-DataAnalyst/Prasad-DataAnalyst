import { expect, test } from './fixtures';

test('a saved project reopens after a reload with the same issues, audit and rows', async ({ app, page }) => {
  await app.open();
  await app.importFixture('csv_null_markers.csv');
  await app.runChecks();
  await app.editCell(1, 'Pressure', '1511', 'Field sheet value');
  const counts = await app.issueCounts();
  const status = await app.statusText();
  await page.getByRole('tab', { name: 'Log' }).click();
  const auditRows = await page.locator('tr[data-action]').count();
  const { path } = await app.saveProject();

  await page.reload();
  await page.waitForFunction(() => window.__tracewellReady === true);
  await app.openProject(path);
  const report = page.getByTestId('tw-open-report');
  await expect(report).toContainText('verified');
  for (const ok of await report.locator('li').evaluateAll((items) => items.map((i) => i.getAttribute('data-ok'))))
    expect(ok).toBe('true');
  await report.getByRole('button', { name: 'Close' }).click();

  expect(await app.issueCounts()).toEqual(counts);
  await page.getByRole('tab', { name: 'Log' }).click();
  await expect(page.locator('tr[data-action]')).toHaveCount(auditRows + 1);
  expect((await app.statusText()).replace(/Unsaved|Saved \S+ UTC/, '')).toBe(
    status.replace(/Unsaved|Saved \S+ UTC/, ''),
  );
});
