import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Mirrors isTestFile() in tests/architecture/import-graph.ts, plus the test-only folders.
const TEST_FILES = [
  '**/*.{test,spec}.{ts,tsx,js,mjs}',
  '**/__tests__/**',
  '**/__fixtures__/**',
  'tests/**',
  'fixtures/**',
];

// Modules whose output must be a pure function of their inputs (SAD section 2.1, goal 6). The
// worker entry is app wiring: it is where the real clock and ID source are created and injected.
const ENGINE_CODE = [
  'src/model/**',
  'src/io/**',
  'src/units/**',
  'src/geo/**',
  'src/engine-api/**',
  'src/formats/**',
  'src/detect/**',
  'src/table/**',
  'src/audit/**',
  'src/ingest/**',
  'src/rules/**',
  'src/steps/**',
  'src/export/**',
  'src/project/**',
  'src/engine/**',
];

const INJECT = 'Engine code must use the injected Clock or IdSource (SAD section 2.1, goal 6).';

const LOCAL =
  "Engine output must not depend on the machine's time zone or locale: use the UTC methods (getUTCHours, Date.UTC) " +
  'or pass an explicit locale and timeZone (SAD section 2.1, goal 6).';

// Date methods that read or write local time; their getUTC*/setUTC* twins are the safe ones.
const LOCAL_TIME_METHODS =
  '/^((get|set)(FullYear|Month|Date|Hours|Minutes|Seconds|Milliseconds)|getDay|getYear|getTimezoneOffset|toDateString|toTimeString)$/';

// Member expressions, not calls, so passing `Date.now` or `Math.random` as a value is caught too.
const DATE = ":matches([object.name='Date'], [object.property.name='Date'])";

const purityRules = {
  'no-restricted-syntax': [
    'error',
    { selector: `MemberExpression[property.name='now']${DATE}`, message: INJECT },
    { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: INJECT },
    { selector: "CallExpression[callee.name='Date']", message: INJECT },
    { selector: "MemberExpression[object.name='Math'][property.name='random']", message: INJECT },
    // A monotonic clock is still a clock: progress throttling uses the injected one.
    { selector: "MemberExpression[object.name='performance'][property.name='now']", message: INJECT },
    // getRandomValues is how the app wiring builds its IdSource; nothing else may call it.
    { selector: 'MemberExpression[property.name=/^(randomUUID|getRandomValues)$/]', message: INJECT },
    // The same file must give the same output on every machine, so nothing may depend on the
    // machine's time zone or locale (data without a zone is read as UTC, rule TW-TIME-004).
    { selector: `CallExpression[callee.property.name=${LOCAL_TIME_METHODS}]`, message: LOCAL },
    {
      selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.length=0]',
      message: LOCAL,
    },
    { selector: "NewExpression[callee.name='Date'][arguments.length>1]", message: LOCAL },
    { selector: "[callee.object.name='Intl'][arguments.length=0]", message: LOCAL },
    { selector: "MemberExpression[property.name='resolvedOptions']", message: LOCAL },
  ],
};

const OFFLINE = 'Tracewell has no network code; the production CSP blocks it too (SAD section 12).';

// RTCPeerConnection matters most: CSP connect-src does not govern WebRTC.
const OFFLINE_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
].map((name) => ({ name, message: OFFLINE }));

// tsconfig loads the Node types for tests and scripts, so neither tsc nor no-undef notices these
// in code that must also run in the browser worker.
const NODE_ONLY =
  'Node-only global: this code runs in the browser too (use Uint8Array, TextEncoder or import.meta.env).';
const NODE_GLOBALS = [
  'Buffer',
  'process',
  'global',
  'require',
  'module',
  '__dirname',
  '__filename',
  'setImmediate',
  'clearImmediate',
].map((name) => ({ name, message: NODE_ONLY }));

const offlineProperties = [
  'error',
  { object: 'window', property: 'fetch', message: OFFLINE },
  { object: 'self', property: 'fetch', message: OFFLINE },
  { object: 'globalThis', property: 'fetch', message: OFFLINE },
  { object: 'navigator', property: 'sendBeacon', message: OFFLINE },
];

const browserRules = {
  'no-restricted-globals': ['error', ...OFFLINE_GLOBALS, ...NODE_GLOBALS],
  'no-restricted-properties': offlineProperties,
};

/** The Node-only file adapter may use Node globals, but it is still application code: no network. */
const NODE_ENTRY = 'src/io/node.ts';
const nodeEntryRules = {
  'no-restricted-globals': ['error', ...OFFLINE_GLOBALS],
  'no-restricted-properties': offlineProperties,
};

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', 'playwright-report/', 'test-results/', 'node_modules/', 'fixtures/messy/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Promise misuse is the classic way for a job's failure to vanish, so these rules use type information.
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  { files: ['src/**'], ignores: [...TEST_FILES, NODE_ENTRY], rules: browserRules },
  { files: [NODE_ENTRY], rules: nodeEntryRules },
  { files: ENGINE_CODE, ignores: [...TEST_FILES, 'src/engine/worker.ts'], rules: purityRules },
  { files: ['src/engine/worker.ts'], languageOptions: { globals: { ...globals.worker } } },
  {
    files: ['src/ui-shell/**/*.{ts,tsx}', 'src/ui-views/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },
  {
    files: [...TEST_FILES, 'scripts/**', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
]);
