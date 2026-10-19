/**
 * Behaviour of the project-specific lint rules in eslint.config.js: engine purity (SAD section 2.1,
 * goal 6), offline code (SAD section 12) and browser-only globals. Snippets are linted in memory
 * under the path they would have, so no files are written.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { isTestFile } from './import-graph';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// The snippets are not on disk, so the type-aware rules (which need the TypeScript project) are
// switched off; every rule under test here is syntactic.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: [
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { parserOptions: { projectService: false } },
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        '@typescript-eslint/await-thenable': 'off',
      },
    },
  ],
});

/** Rule IDs reported for `code` linted as if it lived at `path`. */
async function rulesFor(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(`${code}\n`, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

beforeAll(async () => {
  // Loading the configuration once up front keeps the first test inside its timeout.
  await eslint.calculateConfigForFile(`${ROOT}src/io/probe.ts`);
});

describe('engine purity', () => {
  const ENGINE_FILE = 'src/io/probe.ts';
  const forbidden = [
    'export const a = Date.now();',
    'export const a = { now: Date.now };',
    'export const a = globalThis.Date.now();',
    'export const a = new Date();',
    'export const a = Date();',
    'export const a = Math.random();',
    'export const a = [1].map(Math.random);',
    'export const a = crypto.randomUUID();',
    'export const a = crypto.getRandomValues(new Uint8Array(8));',
    'export const a = self.crypto.getRandomValues(new Uint8Array(8));',
    'export const a = performance.now();',
  ];

  it.each(forbidden)('flags %s in engine code', async (code) => {
    expect(await rulesFor(ENGINE_FILE, code)).toContain('no-restricted-syntax');
  });

  it.each([
    'export const a = (d: Date) => d.getHours();',
    'export const a = (d: Date) => d.getDate();',
    'export const a = (d: Date) => d.getFullYear();',
    'export const a = (d: Date) => d.setMinutes(0);',
    'export const a = (d: Date) => d.getTimezoneOffset();',
    'export const a = (d: Date) => d.toLocaleString();',
    'export const a = (n: number) => n.toLocaleString();',
    'export const a = (d: Date) => d.toDateString();',
    'export const a = new Date(2026, 9, 19);',
    'export const a = new Intl.DateTimeFormat();',
    'export const a = Intl.DateTimeFormat().resolvedOptions().timeZone;',
  ])('flags the time-zone or locale dependent %s in engine code', async (code) => {
    expect(await rulesFor('src/detect/dates.ts', code)).toContain('no-restricted-syntax');
  });

  it('allows the UTC methods and explicit locales and time zones', async () => {
    const code = [
      'export const a = (d: Date) => [d.getUTCHours(), d.getUTCDate(), d.getUTCFullYear(), d.toISOString()];',
      "export const b = (n: number) => n.toLocaleString('en-US');",
      "export const c = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London' });",
      'export const d = new Date(Date.UTC(2026, 9, 19));',
    ].join('\n');
    expect(await rulesFor('src/detect/dates.ts', code)).toEqual([]);
  });

  it('allows dates built from data and the injected clock', async () => {
    const code = [
      "export const a = new Date('2026-10-19T08:00:00.000Z');",
      'export const b = Date.UTC(2026, 9, 19);',
      'export function stamp(clock: { now(): Date }): string { return clock.now().toISOString(); }',
    ].join('\n');
    expect(await rulesFor(ENGINE_FILE, code)).toEqual([]);
  });

  it('applies to every engine-side module, including formats and engine', async () => {
    for (const path of ['src/formats/csv/reader.ts', 'src/engine/jobs.ts', 'src/engine-api/stub.ts']) {
      expect(await rulesFor(path, 'export const a = crypto.getRandomValues(new Uint8Array(8));'), path).toContain(
        'no-restricted-syntax',
      );
    }
  });

  it('exempts the worker entry, where the real clock and ID source are wired, and the UI', async () => {
    const code = 'export const a = Date.now();\nexport const b = crypto.getRandomValues(new Uint8Array(8));';
    expect(await rulesFor('src/engine/worker.ts', code)).toEqual([]);
    expect(await rulesFor('src/ui-shell/status-bar.ts', code)).toEqual([]);
  });

  it('exempts tests, recognised the same way as the boundary check recognises them', async () => {
    for (const path of ['src/io/zip.test.ts', 'src/io/zip.spec.ts', 'src/io/__tests__/helpers.ts']) {
      expect(isTestFile(path), path).toBe(true);
      expect(await rulesFor(path, 'export const a = Date.now();'), path).toEqual([]);
    }
  });
});

describe('offline code', () => {
  it.each([
    "export const a = fetch('/x');",
    "export const a = new WebSocket('ws://x');",
    "export const a = navigator.sendBeacon('/x');",
    'export const a = new RTCPeerConnection();',
    "export const a = new WebTransport('https://x');",
  ])('flags %s in application code', async (code) => {
    const rules = await rulesFor('src/ui-views/grid.ts', code);
    expect(rules.some((r) => r === 'no-restricted-globals' || r === 'no-restricted-properties')).toBe(true);
  });
});

describe('browser-only code', () => {
  const nodeGlobals = [
    "export const a = Buffer.from('x');",
    'export const a = process.env.MODE;',
    "export const a = require('fflate');",
    'export const a = __dirname;',
    'export const a = global;',
    'export const a = setImmediate(() => undefined);',
  ];

  it.each(nodeGlobals)('flags the Node global in %s', async (code) => {
    expect(await rulesFor('src/io/sha256.ts', code)).toContain('no-restricted-globals');
    expect(await rulesFor('src/ui-views/grid.tsx', code)).toContain('no-restricted-globals');
  });

  it('allows Node globals in the Node-only io entry, in tests and in fixtures, but not network calls', async () => {
    const code = "export const a = Buffer.from('x');";
    expect(await rulesFor('src/io/node.ts', code)).toEqual([]);
    expect(await rulesFor('src/io/node.ts', "export const a = fetch('/x');")).toContain('no-restricted-globals');
    expect(await rulesFor('src/io/sha256.test.ts', code)).toEqual([]);
    expect(await rulesFor('fixtures/index.ts', code)).toEqual([]);
  });
});
