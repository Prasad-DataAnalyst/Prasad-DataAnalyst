/** The data health score (FR-VAL-05): the share of rows no open error or warning concerns. */
import { describe, expect, it } from 'vitest';
import { checked, importFixture, issueOf, withProject } from './__fixtures__/session';
import { healthScore } from './queries';

describe('data health score', () => {
  it('rounds down to one decimal, so 100 means nothing is open', () => {
    expect(healthScore(3, 1)).toBe(66.6);
    expect(healthScore(10_000, 1)).toBe(99.9);
    expect(healthScore(10, 0)).toBe(100);
    expect(healthScore(0, 0)).toBe(100);
    expect(healthScore(7, 7)).toBe(0);
  });

  it('has no score until checks have run', async () => {
    const engine = await withProject();
    const ds = await importFixture(engine, 'csv_null_markers.csv');
    const health = await engine.getHealth(ds.id);
    expect(health).toMatchObject({ checked: false, score: null, affectedRows: 0, rows: ds.rowCount });
    expect(health.categories.every((c) => c.score === null)).toBe(true);
  });

  it('scores the rows that open errors and warnings concern, by category', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_duplicates_rows_and_keys.csv');
    const health = await engine.getHealth(ds.id);
    const uniqueness = health.categories.find((c) => c.category === 'uniqueness');
    expect(health.checked).toBe(true);
    expect(uniqueness?.affectedRows).toBeGreaterThan(0);
    expect(uniqueness?.score).toBe(healthScore(health.rows, uniqueness?.affectedRows ?? 0));
    expect(health.score).toBe(healthScore(health.rows, health.affectedRows));
    expect(health.affectedRows).toBeGreaterThanOrEqual(uniqueness?.affectedRows ?? 0);
    expect(health.categories.find((c) => c.category === 'spatial')).toMatchObject({ score: 100, affectedRows: 0 });
  });

  it('rises as issues are accepted, and counts only the rows not excluded', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_duplicates_rows_and_keys.csv');
    const before = await engine.getHealth(ds.id);
    const dup = await issueOf(engine, ds.id, 'TW-DQ-003');
    await engine.decide({ kind: 'accept_issue', issueId: dup.id, rows: 'all', reason: 'Known double reading' });
    const accepted = await engine.getHealth(ds.id);
    expect(accepted.score ?? 0).toBeGreaterThanOrEqual(before.score ?? 0);
    expect(accepted.categories.find((c) => c.category === 'uniqueness')?.openIssues).toBeLessThan(
      before.categories.find((c) => c.category === 'uniqueness')?.openIssues ?? 0,
    );
    await engine.decide({ kind: 'exclude_rows', datasetId: ds.id, rows: [0], reason: 'Test row' });
    expect((await engine.getHealth(ds.id)).rows).toBe(before.rows - 1);
  });

  it('refuses an unknown dataset', async () => {
    const engine = await withProject();
    await expect(engine.getHealth('d9')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
