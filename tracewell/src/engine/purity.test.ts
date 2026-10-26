/**
 * Engine output must be a pure function of its inputs (SAD section 2.1, goal 6): no module that
 * builds project state may read the machine's clock or randomness. Only the worker entry, which is
 * app wiring, creates the real clock and ID source to inject.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The package root, two folders above this file (src/engine).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES = ['engine', 'ingest', 'rules', 'steps', 'export', 'project', 'audit'];
const ALLOWED = new Set(['src/engine/worker.ts']);
const FORBIDDEN = ['Date.now', 'new Date()', 'Math.random'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('engine purity', () => {
  it.each(MODULES)('src/%s reads no clock or randomness of its own', (module) => {
    const offenders = sources(join(ROOT, 'src', module)).flatMap((path) => {
      const file = relative(ROOT, path).split('\\').join('/');
      if (ALLOWED.has(file)) return [];
      const text = readFileSync(path, 'utf8');
      return FORBIDDEN.filter((f) => text.includes(f)).map((f) => `${file}: ${f}`);
    });
    expect(offenders).toEqual([]);
  });

  it('the worker entry is the one place the real clock is created', () => {
    const worker = readFileSync(join(ROOT, 'src/engine/worker.ts'), 'utf8');
    expect(worker).toContain('new Date()');
  });
});
