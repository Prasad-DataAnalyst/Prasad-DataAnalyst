/** Unit tests of the licence classifier in scripts/check-licences.mjs (SAD section 14). */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED,
  classifyPackage,
  declaredLicence,
  formatReport,
  installedPackages,
  isAllowedExpression,
} from '../../scripts/check-licences.mjs';

describe('licence classifier', () => {
  it('passes MIT', () => {
    expect(classifyPackage({ name: 'a', version: '1.0.0', license: 'MIT' })).toEqual({
      name: 'a',
      version: '1.0.0',
      licence: 'MIT',
      allowed: true,
    });
  });

  it("fails 'GPL-3.0'", () => {
    expect(classifyPackage({ name: 'b', version: '2.0.0', license: 'GPL-3.0' }).allowed).toBe(false);
  });

  it('passes the legacy licenses array form, read as alternatives', () => {
    const pkg = { name: 'c', version: '0.1.0', licenses: [{ type: 'MIT', url: 'https://example.invalid/mit' }] };
    expect(classifyPackage(pkg)).toMatchObject({ licence: 'MIT', allowed: true });
    const dual = { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] };
    expect(declaredLicence(dual)).toBe('(MIT OR Apache-2.0)');
    expect(classifyPackage(dual).allowed).toBe(true);
  });

  it('passes the legacy licence object form', () => {
    expect(classifyPackage({ license: { type: 'BSD-3-Clause', url: 'https://example.invalid' } }).allowed).toBe(true);
  });

  it('accepts every entry of the allow-list as written', () => {
    for (const licence of ALLOWED) expect(isAllowedExpression(licence), licence).toBe(true);
  });

  it('evaluates SPDX expressions: OR needs one allowed side, AND needs both', () => {
    expect(isAllowedExpression('(MIT OR GPL-3.0)')).toBe(true);
    expect(isAllowedExpression('MIT AND BSD-2-Clause')).toBe(true);
    expect(isAllowedExpression('(MIT AND GPL-3.0)')).toBe(false);
    expect(isAllowedExpression('(ISC OR (MIT AND LGPL-2.1))')).toBe(true);
  });

  it('refuses exceptions, unknown, missing and malformed licences', () => {
    expect(isAllowedExpression('GPL-2.0 WITH Classpath-exception-2.0')).toBe(false);
    expect(isAllowedExpression('UNLICENSED')).toBe(false);
    expect(isAllowedExpression('(MIT')).toBe(false);
    expect(isAllowedExpression('MIT OR')).toBe(false);
    expect(classifyPackage({ name: 'd', version: '1.0.0' })).toMatchObject({ licence: 'UNKNOWN', allowed: false });
    expect(classifyPackage({ licenses: [] }).allowed).toBe(false);
  });
});

describe('production tree', () => {
  it('lists each installed package once, skips unmet optional peers and keeps missing packages', () => {
    const tree = {
      dependencies: {
        react: { version: '19.3.0', license: 'MIT', path: '/x/react' },
        zustand: {
          version: '5.0.15',
          license: 'MIT',
          dependencies: { react: { version: '19.3.0', license: 'MIT' }, immer: {} },
        },
        saxes: { required: '6.0.0', missing: true },
      },
    };
    expect(installedPackages(tree)).toEqual([
      { name: 'react', version: '19.3.0', path: '/x/react', license: 'MIT' },
      { name: 'saxes', version: '6.0.0', missing: true },
      { name: 'zustand', version: '5.0.15', path: undefined, license: 'MIT' },
    ]);
  });

  it('checks the dependencies of a package that npm first printed as a deduped, childless entry', () => {
    // Real `npm ls --all --json` shape: react-dom appears under @tanstack/react-virtual without its
    // own dependencies (deduped) before the full top-level entry that lists scheduler.
    const tree = {
      dependencies: {
        '@tanstack/react-virtual': {
          version: '3.14.13',
          license: 'MIT',
          dependencies: { 'react-dom': { version: '19.3.0', license: 'MIT' } },
        },
        'react-dom': {
          version: '19.3.0',
          license: 'MIT',
          dependencies: { scheduler: { version: '0.28.0', license: 'GPL-3.0' } },
        },
      },
    };
    const names = installedPackages(tree).map((p) => `${p.name}@${p.version}`);
    expect(names).toEqual(['@tanstack/react-virtual@3.14.13', 'react-dom@19.3.0', 'scheduler@0.28.0']);
  });

  it('terminates on a dependency cycle', () => {
    interface Node {
      version: string;
      license: string;
      dependencies: Record<string, Node>;
    }
    const a: Node = { version: '1.0.0', license: 'MIT', dependencies: {} };
    a.dependencies.b = { version: '1.0.0', license: 'MIT', dependencies: { a } };
    expect(installedPackages({ dependencies: { a } }).map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('reports every offender with its licence', () => {
    const text = formatReport([
      { name: 'ok', version: '1.0.0', licence: 'MIT', allowed: true },
      { name: 'bad', version: '2.0.0', licence: 'GPL-3.0', allowed: false },
    ]);
    expect(text).toContain('1 of 2 production packages failed the licence gate');
    expect(text).toContain('bad@2.0.0: GPL-3.0');
  });
});
