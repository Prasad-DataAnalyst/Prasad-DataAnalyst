import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Alias, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Folder of every module that other code may import as `@tw/<name>` (SAD section 5.2).
 * tsconfig.json mirrors this map; tests/architecture/boundaries.test.ts checks that both agree.
 */
export const TW_MODULE_DIRS: Readonly<Record<string, string>> = {
  model: 'src/model',
  io: 'src/io',
  units: 'src/units',
  geo: 'src/geo',
  'engine-api': 'src/engine-api',
  fixtures: 'fixtures',
  'formats-csv': 'src/formats/csv',
  'formats-xlsx': 'src/formats/xlsx',
  'formats-geojson': 'src/formats/geojson',
  'formats-parquet': 'src/formats/parquet',
  detect: 'src/detect',
  table: 'src/table',
  audit: 'src/audit',
  ingest: 'src/ingest',
  rules: 'src/rules',
  steps: 'src/steps',
  export: 'src/export',
  project: 'src/project',
  engine: 'src/engine',
  'ui-shell': 'src/ui-shell',
  'ui-views': 'src/ui-views',
  app: 'src/app',
};

/**
 * Node-only entry points. They sit outside the browser bundle's module graph and the boundary
 * test only lets tests, fixtures and the conformance suite import them.
 */
export const TW_NODE_ENTRIES: Readonly<Record<string, string>> = {
  '@tw/io/node': 'src/io/node.ts',
};

/** Content Security Policy of the production build (SAD section 12). */
export const TW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Exact-match aliases. A plain string alias would also rewrite `@tw/io/zip` to a path inside
 * `index.ts`; anchoring each one makes deep imports fail to resolve, as the SAD requires.
 */
export function twAliases(root: string = ROOT): Alias[] {
  const entries: [string, string][] = [
    ...Object.entries(TW_NODE_ENTRIES),
    ...Object.entries(TW_MODULE_DIRS).map(([name, dir]): [string, string] => [`@tw/${name}`, `${dir}/index.ts`]),
  ];
  return entries.map(([specifier, file]) => ({
    find: new RegExp(`^${escapeRegExp(specifier)}$`),
    replacement: `${root.replace(/\/$/, '')}/${file}`,
  }));
}

/**
 * Injects the CSP meta tag into index.html at build time only: the development server relies on
 * inline styles for hot reloading, which the policy would block.
 */
export function twCsp(): Plugin & { transformIndexHtml(html: string): string } {
  return {
    name: 'tw-csp',
    apply: 'build',
    transformIndexHtml(html: string): string {
      // HTML attribute names and this value are case-insensitive, and quotes are optional.
      if (/http-equiv\s*=\s*["']?content-security-policy/i.test(html)) {
        throw new Error('tw-csp: index.html already declares a Content-Security-Policy; keep a single source.');
      }
      const charset = /<meta\s+charset=["'][^"']*["']\s*\/?>/i.exec(html);
      if (!charset) {
        throw new Error('tw-csp: index.html must declare <meta charset> first so the CSP can follow it.');
      }
      const insertAt = charset.index + charset[0].length;
      const meta = `\n    <meta http-equiv="Content-Security-Policy" content="${TW_CSP}" />`;
      return html.slice(0, insertAt) + meta + html.slice(insertAt);
    },
  };
}

interface PackageJson {
  version: string;
  author?: string | { name?: string };
}

/** Owner and version come from package.json so the About screen cannot drift from the package. */
export function appEnv(root: string = ROOT): { VITE_OWNER: string; VITE_APP_VERSION: string } {
  const pkg = JSON.parse(readFileSync(`${root.replace(/\/$/, '')}/package.json`, 'utf8')) as PackageJson;
  const owner = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  if (!owner) throw new Error('package.json must name the author (owner) of Tracewell.');
  return { VITE_OWNER: owner, VITE_APP_VERSION: pkg.version };
}

const env = appEnv();

export default defineConfig({
  plugins: [react(), twCsp()],
  resolve: { alias: twAliases() },
  define: {
    'import.meta.env.VITE_OWNER': JSON.stringify(env.VITE_OWNER),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(env.VITE_APP_VERSION),
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // Every asset stays a same-origin file, so the CSP never has to allow inline fonts or scripts.
    assetsInlineLimit: 0,
    // Chromium, WebView2 and WebKitGTK support modulepreload natively; the polyfill would only
    // add fetch() calls to a bundle that otherwise has no network code.
    modulePreload: { polyfill: false },
  },
  server: { host: '127.0.0.1' },
});
