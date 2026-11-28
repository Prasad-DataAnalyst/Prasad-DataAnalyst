import { expect, test } from './fixtures';

test('a Reviewer signs a dataset off and assigns an issue, and a later edit by the Analyst shows on the stamp', async ({
  app,
  page,
}) => {
  await app.open();
  await app.importFixture('csv_well_daily_golden.csv');
  await app.runChecks();
  const user = page.getByTestId('tw-status-user');
  await expect(user).toHaveText('Prasad · Analyst');
  await expect(page.getByTestId('tw-mode-banner')).toHaveCount(0);

  // Someone else reviews on this computer: a new profile, with the Reviewer role.
  await app.menu('File', 'Switch profile…');
  const dialog = page.getByTestId('tw-profile-dialog');
  await dialog.getByRole('radio', { name: 'A new profile' }).check();
  await dialog.getByTestId('tw-profile-name').fill('Jane');
  await dialog.getByTestId('tw-profile-role').selectOption('Reviewer');
  await dialog.getByRole('button', { name: 'Switch' }).click();
  await expect(user).toHaveText('Jane · Reviewer');
  await expect(page.getByTestId('tw-mode-banner')).toContainText('Reviewer mode.');

  // The data stays as the Analyst left it: no checks, imports or exports from a Reviewer.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Data' }).getByRole('menuitem', { name: 'Run checks' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');

  // Jane assigns the first issue to Prasad, with a reason.
  await page.getByRole('tab', { name: 'Issues' }).click();
  await page.getByTestId('tw-issues-panel').locator('tr[data-rule]').first().click();
  await expect(page.getByTestId('tw-issue-assignee')).toHaveText('Assigned to no one');
  await expect(page.getByTestId('tw-issue-action-accept-all')).toBeDisabled();
  await page.getByTestId('tw-issue-action-assign').click();
  await page.getByTestId('tw-assign-name').fill('Prasad');
  await page.getByTestId('tw-assign-dialog').getByTestId('tw-dialog-apply').click();
  await app.giveReason('He owns the logger');
  await expect(page.getByTestId('tw-issue-assignee')).toHaveText('Assigned to Prasad');

  // And signs the dataset off.
  await app.menu('Review', 'Sign off dataset…');
  const signOff = page.getByTestId('tw-signoff-dialog');
  await signOff.getByRole('textbox').fill('Checked against the field sheets');
  await signOff.getByTestId('tw-dialog-apply').click();
  await expect(signOff).toBeHidden();
  await page
    .getByRole('treeitem')
    .filter({ has: page.locator('.tw-tree-label', { hasText: /^csv_well_daily_golden$/ }) })
    .click();
  const stamps = page.getByTestId('tw-signoffs');
  await expect(stamps).toContainText('Approved by Jane (Reviewer)');
  await expect(stamps).toContainText('The dataset has not changed since.');
  await page.getByRole('tab', { name: 'Log' }).click();
  await expect(page.getByText('Signed off').first()).toBeVisible();

  // Back to the Analyst, whose edit supersedes the stamp.
  await app.menu('File', 'Switch profile…');
  await dialog.getByTestId('tw-profile-choice-0').check();
  await dialog.getByRole('button', { name: 'Switch' }).click();
  await expect(user).toHaveText('Prasad · Analyst');
  await expect(page.getByTestId('tw-mode-banner')).toHaveCount(0);
  await app.editCell(0, 'Pressure', '1860.5', 'Gauge re-read on site');
  await page
    .getByRole('treeitem')
    .filter({ has: page.locator('.tw-tree-label', { hasText: /^csv_well_daily_golden$/ }) })
    .click();
  await expect(stamps).toContainText(/The dataset changed after it, at entry \d+\./);
});
