/**
 * The fixture generators: the text generator reproduces the committed files byte for byte, the
 * shared helpers behave as fixtures/README.md describes, and the large-CSV generator is
 * deterministic (a quick version of the slow test in fixtures.test.ts).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { HEADER, largeCsvChunks, parseArgs, writeLargeCsv } from './generators/gen-large-csv.mjs';
import { buildTextFixtures, firstUtf8MultiByte } from './generators/gen-text-fixtures.mjs';
import { ALL_FIXTURES, hampelFlags, longestRun, mulberry32 } from './generators/shared.mjs';
import { FIXTURE_NAMES, fixtureBytes, type FixtureName } from './index';

const GEN_LARGE = fileURLToPath(new URL('./generators/gen-large-csv.mjs', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'tw-fixture-generators-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('gen-text-fixtures.mjs', () => {
  const built = buildTextFixtures();

  it('builds every fixture but the workbooks, which make_xlsx_fixtures.py writes', () => {
    const text = FIXTURE_NAMES.filter((n) => !n.endsWith('.xlsx') && !n.endsWith('.xls'));
    expect(built.map((f) => f.name).sort()).toEqual([...text].sort());
  });

  it.each(built.map((f) => [f.name, f.bytes] as const))('reproduces %s byte for byte', (name, bytes) => {
    expect(sha256(bytes)).toBe(sha256(fixtureBytes(name as FixtureName)));
  });

  it('finds well-formed UTF-8 sequences and ignores stray high bytes', () => {
    expect(firstUtf8MultiByte(new Uint8Array([0x41, 0xc3, 0xa9]))).toBe(1);
    expect(firstUtf8MultiByte(new Uint8Array([0x28, 0xb0, 0x43, 0xf6, 0x72, 0x80]))).toBe(-1);
    expect(firstUtf8MultiByte(new Uint8Array([0xe2, 0x82]))).toBe(-1);
  });
});

describe('shared generator helpers', () => {
  it('lists the same fixtures as FIXTURE_NAMES, in the same order', () => {
    expect([...ALL_FIXTURES]).toEqual([...FIXTURE_NAMES]);
  });

  it('draws the same numbers for the same seed, in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const draws = Array.from({ length: 1000 }, () => a());
    expect(draws).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(draws.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(draws[0]);
  });

  it('flags a lone spike with the Hampel identifier, and nothing on a straight line', () => {
    const series = [10, 11, 10.5, 11.2, 10.8, 30, 10.9, 11.1, 10.6, 11];
    expect(hampelFlags(series)).toEqual([5]);
    expect(hampelFlags(series, true)).toEqual([5]);
    expect(
      hampelFlags(
        Array.from({ length: 20 }, (_, i) => 100 - 0.85 * i),
        true,
      ),
    ).toEqual([]);
  });

  it('tests the edges only in the strict form', () => {
    const series = [50, 10, 11, 10.5, 11.2, 10.8, 10.9, 11.1];
    expect(hampelFlags(series)).toEqual([]);
    expect(hampelFlags(series, true)).toEqual([0]);
  });

  it('exempts a window with MAD 0 only in the documented form', () => {
    const series = [5, 5, 5, 6, 5, 5, 5];
    expect(hampelFlags(series)).toEqual([]);
    expect(hampelFlags(series, true)).toContain(3);
  });

  it('measures the longest run of identical values', () => {
    expect(longestRun([])).toBe(0);
    expect(longestRun([1, 2, 2, 2, 3, 3])).toBe(3);
    expect(longestRun(['a'])).toBe(1);
  });
});

describe('gen-large-csv.mjs', () => {
  const text = (rows: number, seed: number): string => [...largeCsvChunks(rows, seed)].join('');

  it('gives the same bytes for the same seed and different bytes for another', () => {
    const first = text(2_500, 7);
    expect(sha256(text(2_500, 7))).toBe(sha256(first));
    expect(sha256(text(2_500, 8))).not.toBe(sha256(first));
  });

  it('writes the header, the requested rows and 10 fields per line', () => {
    const lines = text(1_234, 1).split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(1 + 1_234 + 1);
    expect(lines.slice(0, -1).every((l) => l.split(',').length === 10)).toBe(true);
  });

  it('starts a longer file with the rows of a shorter one', () => {
    expect(text(30_000, 3).startsWith(text(12_000, 3))).toBe(true);
  });

  it('streams to disk the same bytes it generates', async () => {
    const out = join(temp, 'small.csv');
    const bytes = await writeLargeCsv({ rows: 25_000, seed: 42, out });
    const written = readFileSync(out);
    expect(bytes).toBe(written.byteLength);
    expect(sha256(written)).toBe(sha256(text(25_000, 42)));
  });

  it('runs from the command line', () => {
    const out = join(temp, 'cli.csv');
    const run = spawnSync(process.execPath, [GEN_LARGE, '--rows', '100', '--seed', '42', '--out', out], {
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('100 rows');
    expect(sha256(readFileSync(out))).toBe(sha256(text(100, 42)));
  });

  it('refuses bad options with a usage line and exit code 1', () => {
    const run = spawnSync(process.execPath, [GEN_LARGE, '--rows', 'many', '--out', join(temp, 'x.csv')], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('usage:');
    expect(() => parseArgs(['--rows', '10'])).toThrow(/--out/);
    expect(() => parseArgs(['--size', '10'])).toThrow(/unknown or incomplete option/);
    expect(parseArgs(['--rows', '10', '--out', 'x.csv'])).toEqual({ rows: 10, seed: 42, out: 'x.csv' });
  });
});
