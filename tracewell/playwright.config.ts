import { defineConfig } from '@playwright/test';
import type { EngineKind } from './tests/e2e/fixtures';

// Chromium 1194 is preinstalled for @playwright/test 1.56.1; the suite never downloads browsers.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const ORIGIN = 'http://127.0.0.1:4173';

// The native project runs every test that does not need the Lite engine's own formats (@lite).
const SLOW = process.env.TW_SLOW ? [] : ['@slow'];

export default defineConfig<{ engine: EngineKind }>({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  // Benchmarks and the 1 M-row import only run with `npm run test:slow` (TW_SLOW=1). The key is
  // left out rather than set to undefined because exactOptionalPropertyTypes forbids that.
  ...(process.env.TW_SLOW ? {} : { grepInvert: /@slow/ }),
  workers: 2,
  retries: 0,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', acceptDownloads: true, engine: 'lite' } },
    {
      // The same production build, its engine the native one through the host bridge (SAD decision D-14).
      name: 'native',
      use: { browserName: 'chromium', acceptDownloads: true, engine: 'native' },
      grepInvert: new RegExp(['@lite', ...SLOW].join('|')),
    },
  ],
  webServer: {
    // Tests run against the real production build, CSP included, never the development server.
    command: 'npm run build && npm run preview',
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
