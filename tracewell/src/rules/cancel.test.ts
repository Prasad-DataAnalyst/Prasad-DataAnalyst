import { describe, expect, it } from 'vitest';
import { ctxOf, day, viewOf } from './__fixtures__/dataset';
import { GENERIC_DQ, SYSTEM_RULES, runRules } from './index';

describe('runRules', () => {
  const view = viewOf(
    [
      { name: 'date', type: 'date', role: 'time' },
      { name: 'Oil', type: 'number', role: 'measure', unit: 'm3/d', quantity: 'volume_rate' },
    ],
    [
      [day(1), 1],
      [day(2), null],
    ],
  );

  it('stops with CANCELLED when the signal is aborted', async () => {
    const ctl = new AbortController();
    const run = runRules([GENERIC_DQ], ctxOf(view, { signal: ctl.signal, onProgress: () => ctl.abort() }));
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports progress over every runnable rule and skips system rules', async () => {
    const seen: [number, number][] = [];
    const drafts = await runRules([GENERIC_DQ, SYSTEM_RULES], ctxOf(view, { onProgress: (d, t) => seen.push([d, t]) }));
    expect(seen.at(-1)).toEqual([28, 28]);
    expect(drafts.map((d) => d.ruleId)).toContain('TW-DQ-001');
  });

  it('limits column rules to the given columns but still runs dataset rules', async () => {
    const drafts = await runRules([GENERIC_DQ], ctxOf(view), { columns: ['c0'] });
    expect(drafts.some((d) => d.ruleId === 'TW-DQ-001')).toBe(false);
  });
});
