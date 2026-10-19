import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Shares aliases and build-time constants with the app build, so tests resolve modules exactly as
// the browser bundle does. Tests run in Node; UI rendering is covered by the Playwright suite.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: [
        'src/**/*.test.{ts,tsx}',
        'fixtures/**/*.test.ts',
        'tests/architecture/**/*.test.ts',
        'tests/conformance/**/*.test.ts',
        'tests/oracle/**/*.test.ts',
      ],
      exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__fixtures__/**'],
        reporter: ['text-summary', 'html'],
        reportsDirectory: 'coverage',
      },
    },
  }),
);
