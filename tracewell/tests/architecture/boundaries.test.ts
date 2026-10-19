/**
 * Module boundaries (SAD sections 5.2, 6.1 and 6.2).
 *
 * Each module exports only through its index.ts and is imported as `@tw/<module>`. This test fails
 * on: an `@tw/<m>` import that the allow-list does not permit, a deep import `@tw/<m>/...`, a
 * relative import that crosses a module folder, and an npm or Node import a module may not use.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TW_MODULE_DIRS, TW_NODE_ENTRIES } from '../../vite.config';
import {
  checkBoundaries,
  classify,
  closure,
  formatViolations,
  isSourcePath,
  isTestFile,
  moduleOf,
  parseImports,
  readSourceFiles,
  type BoundaryPolicy,
  type SourceFile,
} from './import-graph';

export type ModuleName =
  | 'model'
  | 'io'
  | 'units'
  | 'geo'
  | 'engine-api'
  | 'fixtures'
  | 'formats-csv'
  | 'formats-xlsx'
  | 'formats-geojson'
  | 'detect'
  | 'table'
  | 'audit'
  | 'ui-shell'
  | 'ingest'
  | 'rules'
  | 'steps'
  | 'export'
  | 'project'
  | 'ui-views'
  | 'engine'
  | 'app'
  | 'conformance'
  | 'e2e';

/** Internal dependencies each module may import; mirrors SAD section 6.1. */
export const ALLOWED: Record<ModuleName, ModuleName[]> = {
  model: [],
  io: ['model'],
  units: ['model'],
  geo: ['model'],
  'engine-api': ['model'],
  fixtures: ['model', 'io'],
  'formats-csv': ['model', 'io'],
  'formats-xlsx': ['model', 'io'],
  'formats-geojson': ['model', 'io'],
  detect: ['model', 'units'],
  table: ['model', 'io'],
  audit: ['model', 'io'],
  'ui-shell': ['model', 'engine-api'],
  ingest: ['model', 'io', 'detect', 'table', 'formats-csv', 'formats-xlsx', 'formats-geojson'],
  rules: ['model', 'table', 'units', 'geo'],
  steps: ['model', 'table', 'units', 'geo'],
  export: ['model', 'io', 'table', 'units', 'geo', 'formats-csv', 'formats-xlsx', 'formats-geojson'],
  project: ['model', 'io'],
  'ui-views': ['model', 'engine-api', 'ui-shell'],
  engine: [
    'model',
    'io',
    'units',
    'geo',
    'engine-api',
    'table',
    'audit',
    'ingest',
    'rules',
    'steps',
    'export',
    'project',
  ],
  app: ['model', 'engine-api', 'ui-shell', 'ui-views', 'engine'],
  conformance: ['model', 'io', 'engine-api', 'engine', 'fixtures'],
  e2e: ['app', 'fixtures'],
};

/**
 * npm packages the implementation plan adds to SAD section 6.1, which lists only each module's
 * distinctive libraries: the React UI modules need react and react-dom themselves, and the e2e
 * suite needs its test runner and accessibility checker.
 */
export const NPM_ADDITIONS: Partial<Record<ModuleName, string[]>> = {
  'ui-shell': ['react-dom'],
  'ui-views': ['react'],
  app: ['react', 'react-dom'],
  e2e: ['@playwright/test', '@axe-core/playwright'],
};

/** npm runtime packages each module may import: SAD section 6.1 plus NPM_ADDITIONS. */
export const ALLOWED_NPM: Record<ModuleName, string[]> = {
  model: ['zod'],
  io: ['fflate', '@noble/hashes'],
  units: [],
  geo: [],
  'engine-api': [],
  fixtures: [],
  'formats-csv': [],
  'formats-xlsx': ['saxes'],
  'formats-geojson': ['@streamparser/json'],
  detect: [],
  table: [],
  audit: [],
  'ui-shell': ['react', 'react-dom', 'zustand', 'react-resizable-panels', 'lucide-react'],
  ingest: [],
  rules: [],
  steps: [],
  export: [],
  project: [],
  'ui-views': ['react', '@tanstack/react-virtual'],
  engine: [],
  app: ['react', 'react-dom'],
  conformance: [],
  e2e: ['@playwright/test', '@axe-core/playwright'],
};

const MODULES = Object.keys(ALLOWED) as ModuleName[];

/** Folder of a module: `formats-csv` lives in src/formats/csv; test suites live under tests/. */
export function moduleDir(name: ModuleName): string {
  if (name === 'fixtures') return 'fixtures';
  if (name === 'conformance' || name === 'e2e') return `tests/${name}`;
  if (name.startsWith('formats-')) return `src/formats/${name.slice('formats-'.length)}`;
  return `src/${name}`;
}

/** Modules the UI must never reach (SAD section 6.2). */
const ENGINE_SIDE: ModuleName[] = [
  'engine',
  'table',
  'rules',
  'formats-csv',
  'formats-xlsx',
  'formats-geojson',
  'ingest',
  'steps',
  'export',
  'project',
  'audit',
];

export const POLICY: BoundaryPolicy = {
  allowed: ALLOWED,
  allowedNpm: ALLOWED_NPM,
  moduleDirs: Object.fromEntries(MODULES.map((m) => [m, moduleDir(m)])),
  nodeEntries: TW_NODE_ENTRIES,
  nodeModules: ['fixtures', 'conformance', 'e2e'],
  testModules: ['conformance', 'e2e'],
  testNpm: ['vitest', 'fast-check', 'papaparse', 'zod'],
};

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The scanned tree: all application code, the fixtures loader and the conformance suite. */
function projectFiles(): SourceFile[] {
  return readSourceFiles(ROOT, ['src', 'fixtures', 'tests/conformance'], ['fixtures/messy', 'fixtures/generators']);
}

// ---------------------------------------------------------------------------------------------
// SAD section 6.1, read from the document itself so the allow-list cannot drift from it.

interface SadRow {
  path: string;
  internal: string[];
  npm: string[];
}

function findSad(): string {
  const candidates = ['docs/tracewell-architecture.md', '../docs/tracewell-architecture.md'].map(
    (rel) => `${ROOT}${rel}`,
  );
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`Software Architecture Document not found; looked in:\n${candidates.join('\n')}`);
  return readFileSync(found, 'utf8');
}

export function parseSadModuleTable(markdown: string): Map<string, SadRow> {
  const start = markdown.indexOf('### 6.1');
  const end = markdown.indexOf('\n### ', start + 1);
  if (start < 0 || end < 0) throw new Error('SAD section 6.1 not found');
  const rows = new Map<string, SadRow>();
  for (const line of markdown.slice(start, end).split('\n')) {
    const cells = /^\|\s*\d+\s*\|\s*([\w-]+)\s*\|(.*)\|(.*)\|\s*$/.exec(line);
    if (!cells) continue;
    const [, name = '', pathCell = '', depsCell = ''] = cells;
    const path = (/`([^`]+)`/.exec(pathCell)?.[1] ?? '').replace(/\/$/, '');
    const deps = depsCell.trim() === 'none' ? [] : depsCell.split(',').map((d) => d.replace(/\(.*?\)/g, '').trim());
    const isModule = (d: string): boolean => /^[a-z][\w-]*$/.test(d) && (d in ALLOWED || d === 'tooling');
    rows.set(name, { path, internal: deps.filter(isModule), npm: deps.filter((d) => !isModule(d)) });
  }
  return rows;
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('allow-list', () => {
  const sad = parseSadModuleTable(findSad());

  it('matches SAD section 6.1 (modules, folders and internal dependencies)', () => {
    expect(sorted(sad.keys())).toEqual(sorted([...MODULES, 'tooling']));
    for (const module of MODULES) {
      const row = sad.get(module);
      expect(row, module).toBeDefined();
      expect(sorted(ALLOWED[module]), module).toEqual(sorted(row?.internal ?? []));
      expect(moduleDir(module), module).toBe(row?.path);
    }
  });

  it('allows exactly the npm packages of SAD section 6.1 plus the documented additions', () => {
    for (const module of MODULES) {
      const expected = new Set([...(sad.get(module)?.npm ?? []), ...(NPM_ADDITIONS[module] ?? [])]);
      expect(sorted(ALLOWED_NPM[module]), module).toEqual(sorted(expected));
    }
  });

  it('only allows npm packages that are production dependencies (e2e: development dependencies)', () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const module of MODULES) {
      const installed = module === 'e2e' ? pkg.devDependencies : pkg.dependencies;
      for (const name of ALLOWED_NPM[module]) expect(installed, `${module} -> ${name}`).toHaveProperty([name]);
    }
  });

  it('is acyclic, so every module can be built after its dependencies', () => {
    for (const module of MODULES) expect(closure(module, ALLOWED).has(module), module).toBe(false);
  });

  it('keeps the UI modules away from the engine side, even transitively (SAD section 6.2)', () => {
    for (const ui of ['ui-shell', 'ui-views'] as const) {
      expect(sorted(closure(ui, ALLOWED)).filter((m) => ENGINE_SIDE.includes(m as ModuleName))).toEqual([]);
    }
  });
});

describe('path aliases', () => {
  const importable = MODULES.filter((m) => m !== 'conformance' && m !== 'e2e');

  it('tsconfig.json maps every importable module, and nothing else, to its index.ts', () => {
    const tsconfig = JSON.parse(readFileSync(`${ROOT}tsconfig.json`, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const expected: Record<string, string[]> = Object.fromEntries(
      importable.map((m) => [`@tw/${m}`, [`./${moduleDir(m)}/index.ts`]]),
    );
    for (const [specifier, file] of Object.entries(TW_NODE_ENTRIES)) expected[specifier] = [`./${file}`];
    expect(tsconfig.compilerOptions.paths).toEqual(expected);
  });

  it('vite.config.ts uses the same module folders', () => {
    expect(TW_MODULE_DIRS).toEqual(Object.fromEntries(importable.map((m) => [m, moduleDir(m)])));
  });
});

describe('import parser', () => {
  it('finds static, type-only, re-export, dynamic, require, import-type and worker URL references', () => {
    const source = [
      "import { a } from '@tw/model';",
      "import type { B } from '@tw/table';",
      "export { c } from './c';",
      "export * from './d';",
      "const e = await import('@tw/io');",
      "const f = require('fflate');",
      "type G = import('zustand').StoreApi<unknown>;",
      "const w = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });",
      "import './side-effect.css';",
    ].join('\n');
    expect(parseImports(source).map((r) => [r.line, r.kind, r.specifier])).toEqual([
      [1, 'import', '@tw/model'],
      [2, 'import', '@tw/table'],
      [3, 'export', './c'],
      [4, 'export', './d'],
      [5, 'dynamic-import', '@tw/io'],
      [6, 'require', 'fflate'],
      [7, 'import-type', 'zustand'],
      [8, 'url', '../engine/worker.ts'],
      [9, 'import', './side-effect.css'],
    ]);
  });

  it('ignores comments, strings and URLs that are not module-relative', () => {
    const source = [
      "// import { x } from '@tw/engine';",
      "/* export * from '@tw/rules'; */",
      'const text = "import { y } from \'@tw/table\'";',
      "const u = new URL('https://example.invalid/');",
      'const t = `require("fflate")`;',
    ].join('\n');
    expect(parseImports(source)).toEqual([]);
  });

  it('parses TSX', () => {
    const source = "import { Grid } from '@tw/ui-shell';\nexport const V = () => <Grid rows={1} />;";
    expect(parseImports(source, 'view.tsx').map((r) => r.specifier)).toEqual(['@tw/ui-shell']);
  });

  it('classifies specifiers', () => {
    expect(classify('@tw/formats-csv', 'src/ingest/a.ts')).toEqual({
      kind: 'module',
      module: 'formats-csv',
      deep: false,
    });
    expect(classify('@tw/io/zip', 'src/ingest/a.ts')).toEqual({ kind: 'module', module: 'io', deep: true });
    expect(classify('../table/x?raw', 'src/rules/a.ts')).toEqual({ kind: 'relative', path: 'src/table/x' });
    expect(classify('node:fs', 'fixtures/index.ts')).toEqual({ kind: 'builtin', name: 'node:fs' });
    expect(classify('path', 'fixtures/index.ts')).toEqual({ kind: 'builtin', name: 'path' });
    expect(classify('@noble/hashes/sha2.js', 'src/io/a.ts')).toEqual({ kind: 'package', name: '@noble/hashes' });
    expect(classify('react-dom/client', 'src/app/main.tsx')).toEqual({ kind: 'package', name: 'react-dom' });
  });

  it('maps paths to modules by the longest folder and recognises test files', () => {
    expect(moduleOf('src/formats/csv/reader.ts', POLICY.moduleDirs)).toBe('formats-csv');
    expect(moduleOf('src/formats/shared.ts', POLICY.moduleDirs)).toBeNull();
    expect(moduleOf('fixtures/index.ts', POLICY.moduleDirs)).toBe('fixtures');
    expect(isTestFile('src/rules/checks.test.ts')).toBe(true);
    expect(isTestFile('src/units/__fixtures__/headers.ts')).toBe(true);
    expect(isTestFile('src/rules/checks.ts')).toBe(false);
  });
});

describe('boundary checker', () => {
  const kinds = (files: SourceFile[]): [string, number, string][] =>
    checkBoundaries(files, POLICY).map((v) => [v.file, v.line, v.kind]);

  it('reports deliberately bad imports in an in-memory file list', () => {
    const files: SourceFile[] = [
      {
        path: 'src/ui-views/grid.tsx',
        source: "import { LocalEngine } from '@tw/engine';\nimport type { View } from '@tw/table';\n",
      },
      { path: 'src/rules/run.ts', source: "import { RowSet } from '@tw/table/rowset';\n" },
      {
        path: 'src/rules/other.ts',
        source: "import { model } from '@tw/model';\nimport { RowSet } from '../table/rowset';\n",
      },
      {
        path: 'src/formats/csv/reader.ts',
        source: "import Papa from 'papaparse';\nimport { readFileSync } from 'node:fs';\n",
      },
      { path: 'src/io/index.ts', source: "export * from './zip';\nexport { nodeFs } from './node';\n" },
      {
        path: 'src/table/index.ts',
        source: "import { nothing } from '@tw/nowhere';\nimport { t } from '@tw/table';\n",
      },
      { path: 'src/formats/shared.ts', source: 'export const x = 1;\n' },
      { path: 'src/geo/bbox.ts', source: "import { RowSet } from '@tw/table';\n" },
    ];
    expect(kinds(files)).toEqual([
      ['src/formats/csv/reader.ts', 1, 'forbidden-package'],
      ['src/formats/csv/reader.ts', 2, 'node-only'],
      ['src/formats/shared.ts', 1, 'outside-module'],
      ['src/geo/bbox.ts', 1, 'forbidden-module'],
      ['src/io/index.ts', 2, 'node-only'],
      ['src/rules/other.ts', 2, 'cross-module-relative'],
      ['src/rules/run.ts', 1, 'deep-import'],
      ['src/table/index.ts', 1, 'unknown-module'],
      ['src/table/index.ts', 2, 'self-import'],
      ['src/ui-views/grid.tsx', 1, 'forbidden-module'],
      ['src/ui-views/grid.tsx', 2, 'forbidden-module'],
    ]);
  });

  it('explains each violation with the rule and the fix', () => {
    const [violation] = checkBoundaries(
      [{ path: 'src/ui-shell/a.ts', source: "import { applyEntry } from '@tw/engine';" }],
      POLICY,
    );
    expect(violation?.message).toContain('ui-shell may not depend on engine');
    expect(violation?.message).toContain('allowed: engine-api, model');
  });

  it('accepts the patterns the plan prescribes', () => {
    const files: SourceFile[] = [
      {
        path: 'src/io/node.ts',
        source: "import { readFile } from 'node:fs/promises';\nimport { bytesSource } from './index';\n",
      },
      {
        path: 'src/io/zip.ts',
        source: "import { zipSync } from 'fflate';\nimport type { Sha256Hex } from '@tw/model';\n",
      },
      {
        path: 'src/units/index.ts',
        source: "import registryText from './registry-2026.1.json?raw';\nexport * from './convert';\n",
      },
      {
        path: 'src/app/main.tsx',
        source:
          "import { createRoot } from 'react-dom/client';\nimport { LocalEngine } from '@tw/engine';\n" +
          "const w = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });\n",
      },
      {
        path: 'src/rules/golden.test.ts',
        source:
          "import { describe } from 'vitest';\nimport fc from 'fast-check';\nimport { fixtureBytes } from '@tw/fixtures';\n" +
          "import { nodeFs } from '@tw/io/node';\nimport { readFileSync } from 'node:fs';\nimport { runChecks } from '@tw/rules';\n",
      },
      {
        path: 'fixtures/index.ts',
        source: "import { readFileSync } from 'node:fs';\nimport { bytesSource } from '@tw/io';\n",
      },
      {
        path: 'tests/conformance/harness.ts',
        source:
          "import { LocalEngine } from '@tw/engine';\nimport { nodeFs } from '@tw/io/node';\nimport { it } from 'vitest';\n",
      },
      { path: 'src/env.d.ts', source: '/// <reference types="vite/client" />\n' },
    ];
    expect(formatViolations(checkBoundaries(files, POLICY))).toBe('');
  });

  it('reports module references it cannot verify because the specifier is computed', () => {
    const files: SourceFile[] = [
      {
        path: 'src/ui-views/lazy.ts',
        source: [
          'const name = "engine";',
          'export const a = import(`@tw/${name}`);',
          "export const b = require('@tw/' + name);",
          'export const c = new URL(`../${name}/worker.ts`, import.meta.url);',
          "export const d = import('@tw/ui-shell');",
        ].join('\n'),
      },
    ];
    expect(kinds(files)).toEqual([
      ['src/ui-views/lazy.ts', 2, 'computed-import'],
      ['src/ui-views/lazy.ts', 3, 'computed-import'],
      ['src/ui-views/lazy.ts', 4, 'computed-import'],
    ]);
  });

  it('checks import.meta.glob patterns like any other import', () => {
    const files: SourceFile[] = [
      {
        path: 'src/rules/packs.ts',
        source: [
          "const own = import.meta.glob('./packs/*.json', { query: '?raw', eager: true });",
          "const other = import.meta.glob(['../table/*.ts', '!../table/*.test.ts']);",
          "const deep = import.meta.glob('@tw/io/*');",
          'const dir = "./packs";',
          'const computed = import.meta.glob(`${dir}/*.json`);',
          'export { own, other, deep, computed };',
        ].join('\n'),
      },
    ];
    expect(
      parseImports(files[0]?.source ?? '')
        .filter((r) => r.kind === 'glob')
        .map((r) => r.specifier),
    ).toEqual(['./packs/*.json', '../table/*.ts', '!../table/*.test.ts', '@tw/io/*']);
    expect(kinds(files)).toEqual([
      ['src/rules/packs.ts', 2, 'cross-module-relative'],
      ['src/rules/packs.ts', 2, 'cross-module-relative'],
      ['src/rules/packs.ts', 3, 'deep-import'],
      ['src/rules/packs.ts', 5, 'computed-import'],
    ]);
  });

  it('scans JavaScript sources too, because tsconfig allows them', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
      expect(isSourcePath(path), path).toBe(true);
    }
    for (const path of ['a.json', 'a.css', 'a.md', 'a.py']) expect(isSourcePath(path), path).toBe(false);
    const files: SourceFile[] = [
      { path: 'src/geo/legacy.js', source: "import { RowSet } from '@tw/table';\n" },
      { path: 'src/ui-views/old.jsx', source: "import { x } from '@tw/engine';\nexport const V = () => <div />;\n" },
      { path: 'src/geo/legacy.test.mjs', source: "import { fixtureBytes } from '@tw/fixtures';\n" },
    ];
    expect(kinds(files)).toEqual([
      ['src/geo/legacy.js', 1, 'forbidden-module'],
      ['src/ui-views/old.jsx', 1, 'forbidden-module'],
    ]);
  });

  it('treats JSX as an import of React, which only the React modules may use', () => {
    const jsx = 'export const V = () => <span>{1}</span>;\n';
    const files: SourceFile[] = [
      { path: 'src/engine-api/stub.tsx', source: jsx },
      { path: 'src/ui-views/cell.tsx', source: jsx },
      { path: 'src/geo/no-jsx.tsx', source: 'export const n = 1;\n' },
    ];
    expect(kinds(files)).toEqual([['src/engine-api/stub.tsx', 1, 'forbidden-package']]);
  });

  it('still keeps UI tests away from the engine', () => {
    const files: SourceFile[] = [
      {
        path: 'src/ui-views/grid.test.ts',
        source: "import { LocalEngine } from '@tw/engine';\nimport { fixtureBytes } from '@tw/fixtures';\n",
      },
    ];
    expect(kinds(files)).toEqual([['src/ui-views/grid.test.ts', 1, 'forbidden-module']]);
  });
});

describe('source tree', () => {
  const files = projectFiles();
  const violations = checkBoundaries(files, POLICY);

  it('scans every module entry point', () => {
    const paths = new Set(files.map((f) => f.path));
    for (const module of MODULES.filter((m) => m !== 'conformance' && m !== 'e2e')) {
      expect(paths.has(`${moduleDir(module)}/index.ts`), module).toBe(true);
    }
  });

  it('has no boundary violations', () => {
    expect(formatViolations(violations)).toBe('');
  });

  it('ui-shell and ui-views have no forbidden imports', () => {
    const ui = violations.filter((v) => ['ui-shell', 'ui-views'].includes(moduleOf(v.file, POLICY.moduleDirs) ?? ''));
    expect(formatViolations(ui)).toBe('');
  });
});
