import { expect, test } from './fixtures';
import { expectAllChecksPassed, expectOracleAgrees } from './export-shared';

test('a CSV package passes every check and the oracle', async ({ app, page }) => {
  await app.open();
  await app.importFixture('csv_semicolon_decimalcomma_cp1252.csv');
  await app.runChecks();
  const { path } = await app.exportProfile('csv');
  await expectAllChecksPassed(page, 'csv');
  const facts = expectOracleAgrees(path, 'check_csv.py') as {
    bom: boolean;
    rows: number;
    manifestRows: number;
    ragged: number[];
    header: string[];
  };
  // SAD section 10.1: UTF-8 without a byte-order mark, CRLF line ends.
  expect(facts.bom).toBe(false);
  expect((facts as { crlf?: boolean }).crlf).toBe(true);
  expect(facts.rows).toBe(facts.manifestRows);
  expect(facts.ragged).toEqual([]);
  expect(facts.header).toContain('Förderrate [m3/d]');
});
