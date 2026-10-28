/** Unit tests of the single test command, scripts/test-all.mjs (SAD section 13.4). */
import { describe, expect, it } from 'vitest';
import { formatSummary, parseArgs, planStages, runStages, stageFailure } from '../../scripts/test-all.mjs';

const names = (stages: { name: string }[]): string[] => stages.map((s) => s.name);

describe('test-all', () => {
  it('parses its three options and rejects anything else', () => {
    expect(parseArgs([])).toEqual({ slow: false, skipE2e: false, skipNative: false });
    expect(parseArgs(['--slow', '--skip-e2e', '--skip-native'])).toEqual({
      slow: true,
      skipE2e: true,
      skipNative: true,
    });
    expect(() => parseArgs(['--fast'])).toThrow(/unknown option "--fast"/);
  });

  it('runs the stages in the SAD order through the npm scripts', () => {
    const stages = planStages({ slow: false, skipE2e: false, skipNative: false });
    expect(names(stages)).toEqual([
      'hygiene',
      'licences',
      'typecheck',
      'lint',
      'native',
      'vitest',
      'build',
      'playwright',
    ]);
    expect(stages.map((s) => s.npmArgs.join(' '))).toEqual([
      'run check:hygiene',
      'run check:licences',
      'run typecheck',
      'run lint',
      'run test:native',
      'run test:unit',
      'run build',
      'run test:e2e',
    ]);
    expect(stages.at(-1)?.env.PLAYWRIGHT_BROWSERS_PATH).toBeTruthy();
  });

  it('--slow runs the slow Vitest and Playwright suites with TW_SLOW=1', () => {
    const stages = planStages({ slow: true, skipE2e: false, skipNative: false });
    expect(names(stages)).toEqual(['vitest', 'playwright']);
    expect(stages.every((s) => s.env.TW_SLOW === '1')).toBe(true);
    expect(stages[1]?.npmArgs).toEqual(['run', 'test:e2e', '--', '--grep', '@slow']);
  });

  it('--skip-e2e leaves out Playwright', () => {
    expect(names(planStages({ slow: false, skipE2e: true, skipNative: false }))).not.toContain('playwright');
    expect(names(planStages({ slow: true, skipE2e: true, skipNative: false }))).toEqual(['vitest']);
  });

  it('--skip-native leaves out the Rust stage and nothing else', () => {
    const all = names(planStages({ slow: false, skipE2e: false, skipNative: false }));
    expect(names(planStages({ slow: false, skipE2e: false, skipNative: true }))).toEqual(
      all.filter((n) => n !== 'native'),
    );
  });

  it('stops at the first failure and reports later stages as not run', () => {
    const ran: string[] = [];
    let now = 0;
    const results = runStages(
      planStages({ slow: false, skipE2e: false, skipNative: false }),
      (stage) => {
        ran.push(stage.name);
        now += 1500;
        return stage.name !== 'typecheck';
      },
      () => now,
    );
    expect(ran).toEqual(['hygiene', 'licences', 'typecheck']);
    expect(results.map((r) => r.outcome)).toEqual([
      'passed',
      'passed',
      'failed',
      'not run',
      'not run',
      'not run',
      'not run',
      'not run',
    ]);
    expect(results[0]?.seconds).toBe(1.5);
  });

  it('says why a stage failed when its command could not run at all', () => {
    expect(stageFailure({ status: 0, signal: null })).toBeNull();
    expect(stageFailure({ status: 2, signal: null })).toBe('exit code 2');
    expect(stageFailure({ status: null, signal: 'SIGKILL' })).toBe('killed by SIGKILL');
    expect(stageFailure({ status: null, signal: null, error: new Error('spawn npm ENOENT') })).toBe(
      'could not start: spawn npm ENOENT',
    );
  });

  it('prints a summary table', () => {
    const text = formatSummary([
      { name: 'hygiene', outcome: 'passed', seconds: 0.42 },
      { name: 'typecheck', outcome: 'failed', seconds: 12 },
      { name: 'lint', outcome: 'not run', seconds: 0 },
    ]);
    expect(text.split('\n')).toEqual([
      'Stage      Result   Time',
      '---------  -------  ------',
      'hygiene    passed   0.4 s',
      'typecheck  failed   12.0 s',
      'lint       not run  -',
      '',
      'FAILED.',
    ]);
    expect(formatSummary([{ name: 'lint', outcome: 'passed', seconds: 1 }])).toMatch(/All stages passed\.$/);
  });
});
