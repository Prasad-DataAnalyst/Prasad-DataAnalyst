/**
 * The gate scripts must actually run when started from the command line, however the path is
 * spelled. A script that silently skips its main() exits 0, which reads as a passed gate.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isEntryScript } from '../../scripts/is-entry.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'tw-entry-'));
const linked = join(temp, 'tracewell');
symlinkSync(ROOT, linked, 'dir');

afterAll(() => rmSync(temp, { recursive: true, force: true }));

function run(script: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: temp, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('entry-script detection', () => {
  const script = join(ROOT, 'scripts/test-all.mjs');
  const url = pathToFileURL(script).href;

  it('recognises the script by its own path, through a symlink, and rejects anything else', () => {
    expect(isEntryScript(url, script)).toBe(true);
    expect(isEntryScript(url, join(linked, 'scripts/test-all.mjs'))).toBe(true);
    expect(isEntryScript(url, join(ROOT, 'scripts/check-hygiene.mjs'))).toBe(false);
    expect(isEntryScript(url, undefined)).toBe(false);
    expect(isEntryScript(url, join(temp, 'missing.mjs'))).toBe(false);
  });
});

describe('gate scripts started through a symlinked path', () => {
  it('test-all still rejects an unknown option', () => {
    const { status, output } = run(join(linked, 'scripts/test-all.mjs'), ['--bogus']);
    expect(status).toBe(1);
    expect(output).toContain('unknown option "--bogus"');
  });

  it('check-hygiene still scans', () => {
    const { status, output } = run(join(linked, 'scripts/check-hygiene.mjs'), []);
    expect(output).toMatch(/^hygiene: \d+ files scanned/m);
    expect(status).toBe(0);
  });

  it('check-licences still checks', () => {
    const { status, output } = run(join(linked, 'scripts/check-licences.mjs'), []);
    expect(output).toMatch(/^licences: \d+ production packages/m);
    expect(status).toBe(0);
  });
});
