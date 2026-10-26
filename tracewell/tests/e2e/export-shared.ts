/** Shared assertions of the three export specs: the package and its data agree with independent oracles. */
import { expect, type Page } from '@playwright/test';
import { runOracle } from './oracle';

export async function expectAllChecksPassed(page: Page, profile: string): Promise<void> {
  const list = page.getByTestId(`tw-export-card-${profile}`).getByTestId('tw-validation');
  const checks = list.locator('li');
  expect(await checks.count()).toBeGreaterThan(3);
  for (const ok of await checks.evaluateAll((items) => items.map((i) => i.getAttribute('data-ok'))))
    expect(ok).toBe('true');
}

export function expectOracleAgrees(
  path: string,
  script: 'check_csv.py' | 'check_xlsx.py' | 'check_geojson.py',
): Record<string, unknown> {
  const pkg = runOracle('check_package.py', [path]) as {
    ok: boolean;
    problems: string[];
    columns: { header: string; sha256: string }[];
    rows: number;
    owner: string;
  };
  expect(pkg.problems).toEqual([]);
  expect(pkg.ok).toBe(true);
  expect(pkg.owner).toContain('Prasad');
  const data = runOracle(script, [path]) as { columns: { header: string; sha256: string }[] };
  expect(data.columns.map((c) => c.sha256)).toEqual(pkg.columns.map((c) => c.sha256));
  return { ...data, manifestRows: pkg.rows, manifestColumns: pkg.columns };
}
