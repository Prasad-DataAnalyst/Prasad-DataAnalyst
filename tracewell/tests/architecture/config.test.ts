/**
 * Build and supply-chain configuration: the production CSP (SAD section 12), exact `@tw/*`
 * aliases (SAD section 5.2), owner and version constants, the offline index.html shell, and exact
 * dependency pins (SAD section 14).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TW_CSP, TW_MODULE_DIRS, appEnv, twAliases, twCsp } from '../../vite.config';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, 'utf8');

function sadText(): string {
  const path = [`${ROOT}docs/tracewell-architecture.md`, `${ROOT}../docs/tracewell-architecture.md`].find(existsSync);
  if (!path) throw new Error('Software Architecture Document not found');
  return readFileSync(path, 'utf8');
}

/** The CSP as written in SAD section 12, with its line break folded into a space. */
function sadCsp(): string {
  const section = sadText().split('## 12.')[1] ?? '';
  const block = /```text\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  return block.trim().replace(/\s+/g, ' ');
}

const SHELL =
  '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n    <title>T</title>\n  </head>\n</html>\n';

describe('CSP plugin', () => {
  it('uses the policy written in SAD section 12', () => {
    expect(sadCsp()).toContain("default-src 'self'");
    expect(TW_CSP).toBe(sadCsp());
  });

  it('applies at build time only', () => {
    const plugin = twCsp();
    expect(plugin.name).toBe('tw-csp');
    expect(plugin.apply).toBe('build');
  });

  it('injects the meta tag straight after <meta charset>, before any script', () => {
    const html = twCsp().transformIndexHtml(SHELL);
    const meta = `<meta http-equiv="Content-Security-Policy" content="${TW_CSP}" />`;
    expect(html).toContain(meta);
    expect(html.indexOf(meta)).toBeGreaterThan(html.indexOf('<meta charset="UTF-8" />'));
    expect(html.indexOf(meta)).toBeLessThan(html.indexOf('<title>'));
    expect(html.replace(`\n    ${meta}`, '')).toBe(SHELL);
  });

  it('refuses a page without <meta charset> or with a second policy', () => {
    expect(() => twCsp().transformIndexHtml('<html><head></head></html>')).toThrow(/charset/);
    const twice = twCsp().transformIndexHtml(SHELL);
    expect(() => twCsp().transformIndexHtml(twice)).toThrow(/already declares/);
  });

  it('recognises a hand-written policy however its attribute is quoted or cased', () => {
    for (const attr of [
      "http-equiv='Content-Security-Policy'",
      'http-equiv="content-security-policy"',
      'HTTP-EQUIV = "CONTENT-SECURITY-POLICY"',
      'http-equiv=Content-Security-Policy',
    ]) {
      const html = SHELL.replace('<title>', `<meta ${attr} content="default-src *" />\n    <title>`);
      expect(() => twCsp().transformIndexHtml(html), attr).toThrow(/already declares/);
    }
  });

  it('works on the real index.html', () => {
    expect(twCsp().transformIndexHtml(read('index.html'))).toContain('Content-Security-Policy');
  });
});

describe('module aliases', () => {
  const aliases = twAliases('/repo');
  const resolveAlias = (specifier: string): string | null => {
    const alias = aliases.find((a) => (a.find as RegExp).test(specifier));
    return alias ? specifier.replace(alias.find, alias.replacement) : null;
  };

  it('resolves each @tw/<module> to its index.ts', () => {
    for (const [name, dir] of Object.entries(TW_MODULE_DIRS)) {
      expect(resolveAlias(`@tw/${name}`)).toBe(`/repo/${dir}/index.ts`);
    }
    expect(resolveAlias('@tw/formats-csv')).toBe('/repo/src/formats/csv/index.ts');
  });

  it('resolves the Node-only io entry and nothing deeper', () => {
    expect(resolveAlias('@tw/io/node')).toBe('/repo/src/io/node.ts');
    expect(resolveAlias('@tw/io/zip')).toBeNull();
    expect(resolveAlias('@tw/model/canonical')).toBeNull();
    expect(resolveAlias('@tw/modelx')).toBeNull();
  });
});

describe('application shell and constants', () => {
  it('takes the owner and version from package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(appEnv()).toEqual({ VITE_OWNER: 'Prasad (Prasad-DataAnalyst)', VITE_APP_VERSION: pkg.version });
  });

  it('exposes the same constants to code under test through import.meta.env', () => {
    expect(import.meta.env.VITE_OWNER).toBe('Prasad (Prasad-DataAnalyst)');
    expect(import.meta.env.VITE_APP_VERSION).toBe(appEnv().VITE_APP_VERSION);
  });

  it('index.html loads nothing from outside the origin', () => {
    const html = read('index.html');
    expect(html).toContain('<title>Tracewell</title>');
    expect(html).toContain('<script type="module" src="/src/app/main.tsx"></script>');
    expect(html).not.toMatch(/(?:src|href)=["'](?:https?:)?\/\//i);
    expect(html).not.toContain('Content-Security-Policy');
  });

  it('names the owner in LICENSE, NOTICE and README', () => {
    for (const file of ['NOTICE', 'README.md']) expect(read(file), file).toContain('Prasad (Prasad-DataAnalyst)');
    expect(read('LICENSE')).toContain('Apache License');
    expect(read('LICENSE')).toContain('Prasad (Prasad-DataAnalyst)');
  });
});

describe('dependencies', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    engines: { node: string };
  };

  it('pins every dependency to an exact version', () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('keeps Playwright on the release that matches the preinstalled Chromium 1194', () => {
    expect(pkg.devDependencies['@playwright/test']).toBe('1.56.1');
  });

  it('keeps the runtime dependency count small (SAD section 14: 13 runtime packages)', () => {
    expect(Object.keys(pkg.dependencies)).toHaveLength(13);
  });

  it('saves exact versions and enforces the Node engine', () => {
    const npmrc = read('.npmrc');
    expect(npmrc).toMatch(/^save-exact=true$/m);
    expect(npmrc).toMatch(/^engine-strict=true$/m);
    expect(pkg.engines.node).toBe('>=22.12');
  });
});
