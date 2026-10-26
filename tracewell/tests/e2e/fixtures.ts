/**
 * The shared end-to-end fixture: every test runs against the production build with an offline
 * guard (any request leaving the local origin fails the test) and console-error capture, and drives
 * the workbench through AppDriver, which uses only the stable test hooks and accessible roles.
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { FixtureName } from '@tw/fixtures';
import { fixturePath } from './files';

export { expect } from '@playwright/test';

export const ORIGIN = 'http://127.0.0.1:4173';

export type ExportProfileId = 'excel' | 'csv' | 'geojson';

/** The filter builder's form, as the Filter dialog holds it. */
export interface FilterFormState {
  combinator: 'all' | 'any';
  conditions: { columnId: string; op: string; value?: string; value2?: string; values?: string }[];
}

export interface AppDriver {
  page: Page;
  open(o?: { profile?: boolean }): Promise<void>;
  importFixture(name: FixtureName, o?: { acceptPreview?: boolean }): Promise<void>;
  runChecks(): Promise<void>;
  columnId(name: string): Promise<string>;
  cell(rowIndex: number, columnName: string): Promise<Locator>;
  editCell(rowIndex: number, columnName: string, value: string, reason: string): Promise<void>;
  giveReason(reason: string): Promise<void>;
  convertColumn(columnName: string, toUnit: string, reason: string): Promise<void>;
  addFilter(form: FilterFormState, reason: string): Promise<void>;
  menu(menu: string, item: string): Promise<void>;
  exportProfile(profile: ExportProfileId): Promise<{ path: string; fileName: string }>;
  saveProject(): Promise<{ path: string }>;
  openProject(path: string): Promise<void>;
  statusText(): Promise<string>;
  issueCounts(): Promise<Record<string, number>>;
}

function escape(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

export const test = base.extend<{ app: AppDriver; offlineGuard: { requests: string[] }; consoleErrors: string[] }>({
  offlineGuard: [
    async ({ page }, use) => {
      const requests: string[] = [];
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith(`${ORIGIN}/`) || url === ORIGIN) await route.continue();
        else {
          requests.push(url);
          await route.abort();
        }
      });
      await use({ requests });
      expect(requests, 'requests that left this computer').toEqual([]);
    },
    { auto: true },
  ],
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      await use(errors);
      expect(errors, 'console errors').toEqual([]);
    },
    { auto: true },
  ],
  app: async ({ page }, use, testInfo) => {
    const app: AppDriver = {
      page,
      async open(o = {}) {
        await page.goto('/');
        if (o.profile !== false) {
          const name = page.getByTestId('tw-profile-name');
          await name.waitFor();
          await name.fill('Prasad');
          await page.getByRole('button', { name: 'Start' }).click();
        }
        await page.waitForFunction(() => window.__tracewellReady === true);
      },
      async importFixture(name, o = {}) {
        const chooser = page.waitForEvent('filechooser');
        await page.keyboard.press('Control+i');
        await (await chooser).setFiles(fixturePath(name));
        await expect(page.getByTestId('tw-import-view')).toBeVisible();
        if (o.acceptPreview === false) return;
        await page.getByTestId('tw-import-button').click();
        await expect(page.getByTestId('tw-grid')).toBeVisible();
        await expect(page.locator('[role="gridcell"]').first()).not.toBeEmpty();
      },
      async runChecks() {
        await page.locator('[data-stage="check"]').click();
        await expect(page.locator('[data-stage="check"]')).toHaveAttribute('data-state', 'done');
      },
      async columnId(name) {
        const header = page
          .locator('[role="columnheader"]')
          .filter({ has: page.locator('.tw-colhead-text', { hasText: escape(name) }) })
          .first();
        const id = await header.getAttribute('data-testid');
        if (id === null) throw new Error(`no column ${name}`);
        return id.replace(/^tw-header-/, '');
      },
      async cell(rowIndex, columnName) {
        return page.getByTestId(`tw-cell-${rowIndex}-${await app.columnId(columnName)}`);
      },
      async giveReason(reason) {
        const box = page.getByTestId('tw-reason-input');
        await box.fill(reason);
        await page.getByRole('button', { name: 'Record' }).click();
        await expect(box).toBeHidden();
      },
      async editCell(rowIndex, columnName, value, reason) {
        const cell = await app.cell(rowIndex, columnName);
        await cell.click();
        await page.keyboard.press('Enter');
        const editor = page.getByTestId('tw-cell-editor');
        await editor.fill(value);
        await editor.press('Enter');
        await app.giveReason(reason);
        await expect(await app.cell(rowIndex, columnName)).toHaveClass(/tw-cell-edited/);
      },
      async convertColumn(columnName, toUnit, reason) {
        const id = await app.columnId(columnName);
        await page.getByTestId(`tw-header-menu-${id}`).click();
        await page.getByTestId('tw-header-action-convert').click();
        await page.getByTestId('tw-convert-unit').fill(toUnit);
        await expect(page.getByTestId('tw-convert-preview')).toContainText('Formula');
        await page.getByTestId('tw-convert-dialog').getByTestId('tw-dialog-apply').click();
        await app.giveReason(reason);
        await expect(page.getByTestId('tw-convert-dialog')).toBeHidden();
      },
      async addFilter(form, reason) {
        await app.menu('Data', 'Filter…');
        const dialog = page.getByTestId('tw-filter-dialog');
        await dialog.getByTestId('tw-filter-combinator').selectOption(form.combinator);
        for (let i = 0; i < form.conditions.length; i++) {
          const x = form.conditions[i] as FilterFormState['conditions'][number];
          if (i > 0) await dialog.getByTestId('tw-filter-add').click();
          await dialog.getByTestId(`tw-filter-${i}-column`).selectOption(x.columnId);
          await dialog.getByTestId(`tw-filter-${i}-op`).selectOption(x.op);
          if (x.value !== undefined) await dialog.getByTestId(`tw-filter-${i}-value`).fill(x.value);
          if (x.value2 !== undefined) await dialog.getByTestId(`tw-filter-${i}-value2`).fill(x.value2);
          if (x.values !== undefined) await dialog.getByTestId(`tw-filter-${i}-values`).fill(x.values);
        }
        await expect(dialog.getByTestId('tw-filter-preview')).toContainText('keeps');
        await dialog.getByTestId('tw-dialog-apply').click();
        await app.giveReason(reason);
        await expect(dialog).toBeHidden();
      },
      async menu(menu, item) {
        await page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).click();
        await page.getByRole('menu', { name: menu }).getByRole('menuitem', { name: item }).click();
      },
      async exportProfile(profile) {
        await page.keyboard.press('Control+e');
        const card = page.getByTestId(`tw-export-card-${profile}`);
        await card.getByTestId(`tw-export-${profile}`).click();
        await expect(card.getByTestId('tw-export-status')).toHaveAttribute('data-state', 'validated', {
          timeout: 60_000,
        });
        const download = page.waitForEvent('download');
        await card.getByTestId('tw-save-package').click();
        const d = await download;
        const fileName = d.suggestedFilename();
        const path = testInfo.outputPath(fileName);
        await d.saveAs(path);
        return { path, fileName };
      },
      async saveProject() {
        const download = page.waitForEvent('download');
        await page.keyboard.press('Control+s');
        const d = await download;
        const path = testInfo.outputPath(d.suggestedFilename());
        await d.saveAs(path);
        return { path };
      },
      async openProject(path) {
        const chooser = page.waitForEvent('filechooser');
        await page.keyboard.press('Control+o');
        await (await chooser).setFiles(path);
        await expect(page.getByTestId('tw-open-report')).toBeVisible({ timeout: 60_000 });
      },
      async statusText() {
        return page.getByRole('status', { name: 'Status' }).innerText();
      },
      async issueCounts() {
        const panel = page.getByTestId('tw-issues-panel');
        await page.getByRole('tab', { name: 'Issues' }).click();
        const rows = panel.locator('tr[data-rule]');
        await expect(rows.first()).toBeVisible();
        const counts: Record<string, number> = {};
        for (const row of await rows.all()) {
          const rule = (await row.getAttribute('data-rule')) ?? '';
          const open = Number((await row.locator('td').nth(4).innerText()).replace(/,/g, ''));
          counts[rule] = (counts[rule] ?? 0) + open;
        }
        return counts;
      },
    };
    await use(app);
  },
});

declare global {
  interface Window {
    __tracewellReady?: boolean;
  }
}
