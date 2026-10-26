import { describe, expect, it } from 'vitest';
import { fixtureExpectation, fixtureSource } from '@tw/fixtures';
import { importSource, previewSource } from './index';
import { context } from './__fixtures__/helpers';

describe('memory budget', () => {
  it('stops at the budget and keeps a partial dataset with a TW-IMP-006 note', async () => {
    const name = 'csv_well_daily_golden.csv';
    const src = fixtureSource(name);
    const preview = await previewSource(src);
    const outcome = await importSource(src, 'd1', preview.spec, context({ memoryBudgetBytes: 1 }));
    expect(outcome.partial).toBe(true);
    expect(outcome.dataset.schema.partial).toBe(true);
    expect(outcome.notes.map((n) => n.code)).toContain('TW-IMP-006');
    expect(outcome.dataset.rowCount).toBeGreaterThan(0);
    expect(outcome.dataset.rowCount).toBeLessThanOrEqual(fixtureExpectation(name).rowCount);
  });

  it('still records the SHA-256 of the whole original after stopping early', async () => {
    const src = fixtureSource('csv_well_daily_golden.csv');
    const preview = await previewSource(src);
    const full = await importSource(src, 'd1', preview.spec, context());
    const cut = await importSource(src, 'd1', preview.spec, context({ memoryBudgetBytes: 1 }));
    expect(cut.sha256).toBe(full.sha256);
  });
});
