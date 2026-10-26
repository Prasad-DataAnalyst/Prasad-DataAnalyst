/**
 * Fixture files for the browser tests. Read straight from fixtures/messy rather than through
 * '@tw/fixtures', whose run-time imports reach engine sources that Playwright's loader does not
 * compile; the names are still checked against the fixture list by the type.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureName } from '@tw/fixtures';

const MESSY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'messy');

export function fixturePath(name: FixtureName): string {
  return join(MESSY, name);
}

export interface Expectation {
  rowCount: number;
  columns: { name: string; type: string; unit: string | null; role: string }[];
  issues: Record<string, number>;
}

export function fixtureExpectation(name: FixtureName): Expectation {
  return JSON.parse(readFileSync(join(MESSY, `${name}.expected.json`), 'utf8')) as Expectation;
}
