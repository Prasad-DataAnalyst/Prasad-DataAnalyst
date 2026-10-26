import AxeBuilder from '@axe-core/playwright';
import { fixturePath } from './files';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function expectNoSeriousViolations(page: Page, where: string): Promise<void> {
  // The axe package is typed against a newer Playwright; the page object is the same at run time.
  const results = await new AxeBuilder({
    page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'],
  }).analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ') ?? ''}`);
  expect(serious, where).toEqual([]);
}

test('the start screen, data grid, issues register and export centre have no serious violations', async ({
  app,
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('tw-profile-name').waitFor();
  await expectNoSeriousViolations(page, 'profile dialog');
  await page.getByTestId('tw-profile-name').fill('Prasad');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__tracewellReady === true);
  await expectNoSeriousViolations(page, 'empty workbench');

  await app.importFixture('csv_well_daily_golden.csv');
  await expectNoSeriousViolations(page, 'data grid');
  await app.runChecks();
  await app.menu('View', 'Issues register');
  await expect(page.getByTestId('tw-issues-view')).toBeVisible();
  await expectNoSeriousViolations(page, 'issues register');
  await page.keyboard.press('Control+e');
  await expect(page.getByTestId('tw-export-centre')).toBeVisible();
  await expectNoSeriousViolations(page, 'export centre');
});

test('keyboard only: import, check and export', async ({ app, page }) => {
  await app.open();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(fixturePath('csv_null_markers.csv'));
  await page.getByTestId('tw-import-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tw-grid')).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.locator('[data-stage="check"]')).toHaveAttribute('data-state', 'done');

  // Move through the grid and edit with the keyboard.
  await page.locator('[role="gridcell"][tabindex="0"]').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('F2');
  await expect(page.getByTestId('tw-cell-editor')).toBeFocused();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+e');
  await page.getByTestId('tw-export-csv').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tw-export-card-csv').getByTestId('tw-export-status')).toHaveAttribute(
    'data-state',
    'validated',
    {
      timeout: 60_000,
    },
  );
});
