// @ts-check
/**
 * The single test command (SAD section 13.4).
 *
 * Usage: node scripts/test-all.mjs [--slow] [--skip-e2e]
 *
 * Runs, in order and stopping at the first failure: hygiene, licences, typecheck, lint, vitest,
 * build, playwright. `--slow` runs only the slow suites (Vitest and the Playwright `@slow` specs)
 * with TW_SLOW=1. `--skip-e2e` leaves out Playwright. Prints a summary table and exits 0 or 1.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntryScript } from './is-entry.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const USAGE = 'usage: node scripts/test-all.mjs [--slow] [--skip-e2e]';

/**
 * @typedef {{ slow: boolean; skipE2e: boolean }} Options
 * @typedef {{ name: string; npmArgs: string[]; env: Record<string, string> }} Stage
 * @typedef {'passed' | 'failed' | 'not run'} Outcome
 * @typedef {{ name: string; outcome: Outcome; seconds: number }} StageResult
 * @typedef {(stage: Stage) => boolean} StageRunner   returns true when the stage passed
 */

/**
 * @param {readonly string[]} argv arguments after the script name
 * @returns {Options}
 */
export function parseArgs(argv) {
  const options = { slow: false, skipE2e: false };
  for (const arg of argv) {
    if (arg === '--slow') options.slow = true;
    else if (arg === '--skip-e2e') options.skipE2e = true;
    else throw new Error(`unknown option "${arg}"\n${USAGE}`);
  }
  return options;
}

// The browsers are preinstalled; the suite must never try to download them.
const E2E_ENV = { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers' };

/**
 * Each stage calls the matching npm script, so every command is defined once, in package.json.
 * @param {Options} options
 * @returns {Stage[]}
 */
export function planStages(options) {
  /** @type {Stage[]} */
  const stages = options.slow
    ? [
        { name: 'vitest', npmArgs: ['run', 'test:unit'], env: { TW_SLOW: '1' } },
        {
          name: 'playwright',
          npmArgs: ['run', 'test:e2e', '--', '--grep', '@slow'],
          env: { ...E2E_ENV, TW_SLOW: '1' },
        },
      ]
    : [
        { name: 'hygiene', npmArgs: ['run', 'check:hygiene'], env: {} },
        { name: 'licences', npmArgs: ['run', 'check:licences'], env: {} },
        { name: 'typecheck', npmArgs: ['run', 'typecheck'], env: {} },
        { name: 'lint', npmArgs: ['run', 'lint'], env: {} },
        { name: 'vitest', npmArgs: ['run', 'test:unit'], env: {} },
        { name: 'build', npmArgs: ['run', 'build'], env: {} },
        { name: 'playwright', npmArgs: ['run', 'test:e2e'], env: E2E_ENV },
      ];
  return options.skipE2e ? stages.filter((s) => s.name !== 'playwright') : stages;
}

/**
 * Runs stages in order and stops at the first failure; later stages are reported as not run.
 * @param {Stage[]} stages
 * @param {StageRunner} runStage
 * @param {() => number} [nowMs] monotonic clock in milliseconds
 * @returns {StageResult[]}
 */
export function runStages(stages, runStage, nowMs = () => performance.now()) {
  /** @type {StageResult[]} */
  const results = [];
  let failed = false;
  for (const stage of stages) {
    if (failed) {
      results.push({ name: stage.name, outcome: 'not run', seconds: 0 });
      continue;
    }
    const started = nowMs();
    const passed = runStage(stage);
    results.push({ name: stage.name, outcome: passed ? 'passed' : 'failed', seconds: (nowMs() - started) / 1000 });
    failed = !passed;
  }
  return results;
}

/**
 * @param {StageResult[]} results
 * @returns {string}
 */
export function formatSummary(results) {
  const rows = results.map((r) => [r.name, r.outcome, r.outcome === 'not run' ? '-' : `${r.seconds.toFixed(1)} s`]);
  const table = [['Stage', 'Result', 'Time'], ...rows];
  const widths = [0, 1, 2].map((col) => Math.max(...table.map((row) => (row[col] ?? '').length)));
  const line = (/** @type {string[]} */ row) =>
    row
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join('  ')
      .trimEnd();
  const ok = results.every((r) => r.outcome === 'passed');
  return [
    line(table[0] ?? []),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(line),
    '',
    ok ? 'All stages passed.' : 'FAILED.',
  ].join('\n');
}

/**
 * Why a finished stage failed, or null when it passed. A command that never started (npm missing)
 * or was killed prints nothing itself, so the reason is stated here rather than left blank.
 * @param {{ status: number | null; signal: string | null; error?: Error }} result
 * @returns {string | null}
 */
export function stageFailure(result) {
  if (result.error) return `could not start: ${result.error.message}`;
  if (result.status === 0) return null;
  if (result.status === null) return `killed by ${result.signal ?? 'an unknown signal'}`;
  return `exit code ${result.status}`;
}

/** @type {StageRunner} */
function runWithNpm(stage) {
  console.log(`\n=== ${stage.name}: npm ${stage.npmArgs.join(' ')}`);
  const result = spawnSync('npm', stage.npmArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...stage.env },
  });
  const failure = stageFailure(result);
  if (failure) console.error(`=== ${stage.name} failed: ${failure}`);
  return failure === null;
}

/**
 * @param {readonly string[]} argv
 * @returns {number} process exit code
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const results = runStages(planStages(options), runWithNpm);
  console.log(`\n${formatSummary(results)}`);
  return results.every((r) => r.outcome === 'passed') ? 0 : 1;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
