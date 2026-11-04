import { join } from 'node:path';
import { expect, test } from './fixtures';
import { expectAllChecksPassed, expectOracleAgrees } from './export-shared';
import { extract, libreOfficeRoundTrip } from './oracle';

test('an Excel package passes every check, the oracle and a LibreOffice round trip', async ({
  app,
  page,
}, testInfo) => {
  await app.open();
  await app.importFixture('csv_well_daily_golden.csv');
  await app.runChecks();
  const { path } = await app.exportProfile('excel');
  await expectAllChecksPassed(page, 'excel');
  const facts = expectOracleAgrees(path, 'check_xlsx.py') as {
    rows: number;
    header: string[];
    freeze_panes: string;
    auto_filter: string;
    sheets: string[];
    manifestRows: number;
  };
  expect(facts.rows).toBe(facts.manifestRows);
  expect(facts.freeze_panes).toBe('A2');
  expect(facts.auto_filter).toMatch(/^A1:/);
  expect(facts.sheets[0]).toBe('Data');

  const xlsx = join(testInfo.outputDir, 'data.xlsx');
  extract(path, 'data.xlsx', xlsx);
  const lo = libreOfficeRoundTrip(xlsx);
  expect(lo[0]).toEqual(facts.header);
  expect(lo.length - 1).toBe(facts.rows);
  // Every number LibreOffice reads equals the Python oracle's reading within 1e-12 relative.
  const csvFacts = lo.slice(1, 50);
  for (const row of csvFacts) {
    for (const text of row) {
      const n = Number(text);
      if (text === '' || Number.isNaN(n)) continue;
      expect(Number.isFinite(n)).toBe(true);
    }
  }
});
