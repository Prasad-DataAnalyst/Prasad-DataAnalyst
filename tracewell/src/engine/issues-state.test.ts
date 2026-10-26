/** Issue counts and status follow from flagged, accepted, excluded and fixed rows. */
import { describe, expect, it } from 'vitest';
import { fixtureExpectation } from '@tw/fixtures';
import { checked, columnId, issueOf, issuesOf, withProject } from './__fixtures__/session';

function rowsOf(ranges: [number, number][]): number[] {
  return ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
}

describe('issue states', () => {
  it('counts, accepts and excludes the duplicate-key rows of csv_duplicates_rows_and_keys.csv', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_duplicates_rows_and_keys.csv');
    const expected = fixtureExpectation('csv_duplicates_rows_and_keys.csv').issues['TW-DQ-003'];
    const dup = await issueOf(engine, ds.id, 'TW-DQ-003');
    expect(dup.counts).toEqual({ flagged: expected, open: expected, accepted: 0, excluded: 0, fixed: 0 });
    expect(dup.status).toBe('open');
    expect(dup.openRows.count).toBe(expected);

    const rows = rowsOf(dup.openRows.ranges);
    // The two copies of one key: accepting both leaves them flagged but decided.
    await engine.decide({
      kind: 'accept_issue',
      issueId: dup.id,
      rows: rows.slice(0, 2),
      reason: 'Re-sent, same values',
    });
    const partly = await issueOf(engine, ds.id, 'TW-DQ-003');
    expect(partly.status).toBe('partly_resolved');
    expect(partly.counts.accepted).toBe(2);
    expect(partly.counts.open).toBe((expected ?? 0) - 2);

    await engine.decide({
      kind: 'exclude_rows',
      datasetId: ds.id,
      rows: { issueId: dup.id },
      reason: 'Duplicate transmissions',
    });
    const done = await issueOf(engine, ds.id, 'TW-DQ-003');
    expect(done.status).toBe('resolved');
    expect(done.counts.open).toBe(0);
    expect(done.counts.excluded).toBeGreaterThan(0);
    const occurrences = (await engine.listOccurrences(dup.id, { offset: 0, limit: 100 })).items;
    expect(occurrences.filter((o) => o.state === 'excluded').every((o) => o.decidedBy !== null)).toBe(true);
  });

  it('editing a flagged cell of csv_null_markers.csv to a valid value counts as fixed', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_null_markers.csv');
    const pressure = await columnId(engine, ds.id, 'Pressure');
    const missing = await issueOf(engine, ds.id, 'TW-DQ-001', 'Pressure');
    const row = missing.openRows.ranges[0]?.[0] as number;
    await engine.decide({
      kind: 'edit_cell',
      datasetId: ds.id,
      rowId: row,
      columnId: pressure,
      value: { text: '1511.0' },
      reason: 'Field sheet gives 1511.0',
      issueId: missing.id,
    });
    const after = (await issuesOf(engine, ds.id)).find((i) => i.id === missing.id);
    expect(after?.counts.fixed).toBe(1);
    expect(after?.counts.open).toBe(missing.counts.open - 1);
    expect(after?.status).toBe(after?.counts.open === 0 ? 'resolved' : 'partly_resolved');
    const occurrence = (await engine.listOccurrences(missing.id, { offset: 0, limit: 100 })).items.find(
      (o) => o.rowId === row,
    );
    expect(occurrence).toMatchObject({ state: 'fixed', value: 1511, locator: `line ${row + 2}, field 3` });
  });

  it('shows comments on the issue', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_null_markers.csv');
    const issue = await issueOf(engine, ds.id, 'TW-DQ-006');
    await engine.decide({ kind: 'comment_issue', issueId: issue.id, text: 'The logger writes -999.25 when offline.' });
    const after = await issueOf(engine, ds.id, 'TW-DQ-006');
    expect(after.comments).toEqual([
      {
        seq: expect.any(Number),
        at: expect.any(String),
        by: 'Prasad',
        text: 'The logger writes -999.25 when offline.',
      },
    ]);
  });

  it('marks the worst open severity of each cell in the row window', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_null_markers.csv');
    const missing = await issueOf(engine, ds.id, 'TW-DQ-001', 'Pressure');
    const row = missing.openRows.ranges[0]?.[0] as number;
    const pressure = await columnId(engine, ds.id, 'Pressure');
    const window = await engine.getRows({
      datasetId: ds.id,
      stage: 'working',
      offset: row,
      limit: 1,
      columns: [pressure],
    });
    expect(window.rows[0]?.issue[0]).not.toBeNull();
  });

  it('filters and sorts the issues list', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_null_markers.csv');
    const all = await issuesOf(engine, ds.id);
    const ranks = { error: 3, warning: 2, note: 1 } as const;
    expect(all.map((i) => ranks[i.severity])).toEqual([...all.map((i) => ranks[i.severity])].sort((a, b) => b - a));
    const notes = (await engine.listIssues({ datasetId: ds.id, severity: ['note'] })).items;
    expect(notes.every((i) => i.severity === 'note')).toBe(true);
    const pressure = await columnId(engine, ds.id, 'Pressure');
    const onPressure = (await engine.listIssues({ datasetId: ds.id, columnId: pressure })).items;
    expect(onPressure.length).toBeGreaterThan(0);
    expect(onPressure.every((i) => i.columns.includes(pressure))).toBe(true);
    await expect(engine.listIssues({ sort: 'toString' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
