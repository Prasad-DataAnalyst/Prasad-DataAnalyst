/**
 * The key engine test (SAD section 8.1): a full session, saved and opened in a fresh engine, is
 * rebuilt exactly from the originals and the audit log.
 */
import { describe, expect, it } from 'vitest';
import { readTwp } from '@tw/project';
import type { AuditEntry, ExportResult, Issue, RowWindow, SaveResult } from '@tw/model';
import type { LocalEngine } from './engine';
import { awaitJob, checked, columnId, issueOf, newEngine, open, withProject } from './__fixtures__/session';

async function everything(engine: LocalEngine, datasetId: string) {
  const issues: Issue[] = (await engine.listIssues({ limit: 1000 })).items;
  const audit: AuditEntry[] = (await engine.listAudit({ limit: 1000 })).items;
  const rows = async (stage: 'working' | 'output'): Promise<RowWindow> =>
    engine.getRows({ datasetId, stage, offset: 0, limit: 1000 });
  return {
    issues,
    audit,
    working: await rows('working'),
    output: await rows('output'),
    workingSchema: await engine.getSchema(datasetId, 'working'),
    outputSchema: await engine.getSchema(datasetId, 'output'),
    project: await engine.getProject(),
  };
}

describe('replay', () => {
  it('rebuilds a full scripted session exactly from the saved project', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_well_daily_golden.csv');
    const id = ds.id;
    const pressure = await columnId(engine, id, 'Pressure');
    const temperature = await columnId(engine, id, 'Temperature');
    const well = await columnId(engine, id, 'well_id');

    // Edit, edit again elsewhere and revert the second edit.
    await engine.decide({
      kind: 'edit_cell',
      datasetId: id,
      rowId: 0,
      columnId: pressure,
      value: { text: '1861.5' },
      reason: 'Gauge re-read',
    });
    const [second] = await engine.decide({
      kind: 'edit_cell',
      datasetId: id,
      rowId: 4,
      columnId: pressure,
      value: { value: 2000 },
      reason: 'Typed in error',
    });
    await engine.decide({ kind: 'revert', seq: (second as AuditEntry).seq, reason: 'Wrong row' });

    // Accept one duplicate-key row, exclude the other, and comment.
    const dup = await issueOf(engine, id, 'TW-DQ-003');
    const [first, other] = [dup.openRows.ranges[0]?.[0] as number, dup.openRows.ranges.at(-1)?.[1] as number];
    await engine.decide({
      kind: 'accept_issue',
      issueId: dup.id,
      rows: [first],
      reason: 'Re-sent reading, same value',
    });
    await engine.decide({ kind: 'exclude_rows', datasetId: id, rows: [other], reason: 'Duplicate transmission' });
    await engine.decide({ kind: 'comment_issue', issueId: dup.id, text: 'Checked with the field team.' });

    // Convert, filter, override a unit and set the project area.
    await awaitJob(
      engine,
      await engine.applyStep(
        id,
        { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'replace' },
        'Report in kPa',
      ),
    );
    await awaitJob(
      engine,
      await engine.applyStep(
        id,
        { kind: 'filter', predicate: { column: well, op: 'ne', value: 'NS-B03' } },
        'NS-B03 is shut in',
      ),
    );
    await engine.decide({
      kind: 'override_detection',
      datasetId: id,
      columnId: temperature,
      property: 'unit',
      value: 'degC',
      reason: 'Logger records Celsius',
    });
    await engine.decide({ kind: 'set_project_area', bbox: [1.5, 57.3, 2.0, 57.7], reason: 'Licence block' });

    const exported = await awaitJob<ExportResult>(engine, await engine.exportData({ datasetId: id, profile: 'csv' }));
    expect(exported.ok).toBe(true);
    const saved = await awaitJob<SaveResult>(engine, await engine.saveProject());
    const before = await everything(engine, id);
    expect(before.project.dirty).toBe(false);
    expect(before.project.exports).toHaveLength(1);
    // The session really changed things, so the comparison below is not between two empty states.
    const dupAfter = before.issues.find((i) => i.id === dup.id);
    // Excluding one of the two rows leaves the other unique, so it counts as fixed, not accepted.
    expect(dupAfter?.counts).toEqual({ flagged: 2, open: 0, accepted: 0, excluded: 1, fixed: 1 });
    expect(dupAfter?.status).toBe('resolved');
    expect(dupAfter?.comments).toHaveLength(1);
    expect(before.output.totalRows).toBeLessThan(before.working.totalRows);
    expect(before.working.rows[0]?.edited).toContain(true);
    expect(before.workingSchema.columns.find((c) => c.id === `${pressure}~kPa`)?.unit.value).toBe('kPa');
    expect(before.workingSchema.columns.find((c) => c.id === temperature)?.unit).toMatchObject({
      value: 'degC',
      source: 'user',
    });
    expect(before.audit.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'entry.revert',
        'issue.accept',
        'rows.exclude',
        'step.apply',
        'detection.override',
        'project.area',
        'export.create',
        'project.save',
      ]),
    );

    const reopened = await open(saved.bytes as Uint8Array, newEngine());
    expect(reopened.report.readOnly).toBe(false);
    expect(reopened.report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(reopened.report.checks.map((c) => c.id)).toEqual([
      'zip',
      'mimetype',
      'format-version',
      'manifest-schema',
      'entry-checksum',
      'original-checksum',
      'audit-chain',
      'replay-digest',
    ]);
    const after = await everything(reopened.engine, id);
    expect(after).toEqual(before);
    expect(reopened.report.project).toEqual(before.project);
    expect(await reopened.engine.verifyAudit()).toEqual({ ok: true, entries: before.audit.length });
  });

  it('records the dataset digests that the rebuilt project reproduces', async () => {
    const engine = await withProject();
    await checked(engine, 'csv_duplicates_rows_and_keys.csv');
    const saved = await awaitJob<SaveResult>(engine, await engine.saveProject());
    const manifest = readTwp(saved.bytes as Uint8Array).manifest;
    expect(manifest?.datasets).toHaveLength(1);
    const save = (await engine.listAudit({ action: ['project.save'] })).items[0];
    expect((save?.payload as { datasets: unknown }).datasets).toEqual(manifest?.datasets);

    const first = await open(saved.bytes as Uint8Array);
    const again = await awaitJob<SaveResult>(first.engine, await first.engine.saveProject());
    expect(readTwp(again.bytes as Uint8Array).manifest?.datasets).toEqual(manifest?.datasets);
  });

  it('saves the same bytes for the same session', async () => {
    const save = async () => {
      const engine = await withProject();
      await checked(engine, 'csv_null_markers.csv');
      return (await awaitJob<SaveResult>(engine, await engine.saveProject())).sha256;
    };
    expect(await save()).toBe(await save());
  });
});
