import { expect, test } from './fixtures';

test('conventions chosen in the File menu show in the status bar, and an unchanged choice is refused', async ({
  app,
  page,
}) => {
  await app.open();
  await app.importFixture('csv_well_daily_golden.csv');
  const status = page.getByTestId('tw-status-conventions');
  await expect(status).toHaveText('Conventions: not set');
  await app.menu('File', 'Conventions…');
  const dialog = page.getByTestId('tw-conventions-dialog');
  await dialog.getByTestId('tw-conventions-conditions').selectOption('std-15C-101.325kPa');
  await dialog.getByTestId('tw-conventions-energy').selectOption('MMBtu');
  await dialog.getByTestId('tw-conventions-metering').selectOption('15.55');
  await dialog.getByTestId('tw-conventions-factor').fill('51.9');
  await dialog.getByTestId('tw-conventions-source').fill('Sales contract, clause 12.3');
  await dialog.getByTestId('tw-dialog-apply').click();
  await app.giveReason('Per the sales contract');
  await expect(dialog).toBeHidden();
  await expect(status).toHaveText('Conventions: 15 °C / 101.325 kPa · MMBtu · metering 15.55 °C · 51.9 MMBtu/t');
  await expect(status).toHaveAttribute('title', /standard conditions 15 °C and 101\.325 kPa/);
  await app.menu('File', 'Conventions…');
  await dialog.getByTestId('tw-dialog-apply').click();
  await app.giveReason('No change at all');
  await expect(dialog.getByText('The project already works to these conventions.')).toBeVisible();
});
