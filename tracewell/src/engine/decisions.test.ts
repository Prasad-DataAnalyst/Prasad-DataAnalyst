/** Decisions are validated before anything is written, then logged and applied. */
import { describe, expect, it } from 'vitest';
import { fixtureBytes } from '@tw/fixtures';
import type { AuditEntry, Decision } from '@tw/model';
import type { LocalEngine } from './engine';
import {
  awaitJob,
  columnId,
  importFixture,
  issueOf,
  open,
  savedProject,
  withProject,
  checked,
} from './__fixtures__/session';
import { rewriteTwp, setText, text } from './__fixtures__/twp';

async function setup(): Promise<{ engine: LocalEngine; id: string; pressure: string }> {
  const engine = await withProject();
  const ds = await importFixture(engine, 'csv_null_markers.csv');
  return { engine, id: ds.id, pressure: await columnId(engine, ds.id, 'Pressure') };
}

function edit(id: string, columnId: string, text: string, reason = 'Field sheet value'): Decision {
  return { kind: 'edit_cell', datasetId: id, rowId: 3, columnId, value: { text }, reason };
}

describe('decisions', () => {
  it.each(['', '  a '])('edit_cell with reason %j is refused with REASON_REQUIRED', async (reason) => {
    const { engine, id, pressure } = await setup();
    const before = (await engine.getProject()).auditHead;
    await expect(engine.decide(edit(id, pressure, '1500', reason))).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect((await engine.getProject()).auditHead).toEqual(before);
  });

  it('an unknown dataset, row or column gives NOT_FOUND', async () => {
    const { engine, id, pressure } = await setup();
    await expect(engine.decide(edit('d9', pressure, '1500'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.decide({ ...edit(id, pressure, '1500'), rowId: 10_000 } as Decision)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(engine.decide(edit(id, 'c99', '1500'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("text 'abc' in a number column gives INVALID_INPUT with a fix", async () => {
    const { engine, id, pressure } = await setup();
    const err = await engine.decide(edit(id, pressure, 'abc')).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('number') });
  });

  it('a valid edit is logged with old, new, reason, actor and locator, and shows as edited', async () => {
    const { engine, id, pressure } = await setup();
    const [entry] = await engine.decide(edit(id, pressure, '1508.6'));
    expect(entry).toMatchObject({
      action: 'cell.edit',
      target: { datasetId: id, rowId: 3, columnId: pressure, locator: 'line 5, field 3' },
      old: 1508.1,
      new: 1508.6,
      reason: 'Field sheet value',
      actor: { kind: 'user', name: 'Prasad', role: 'Analyst' },
    });
    const rows = await engine.getRows({ datasetId: id, stage: 'working', offset: 3, limit: 1, columns: [pressure] });
    expect(rows.rows[0]).toMatchObject({ rowId: 3, cells: [1508.6], edited: [true], locator: 'line 5' });
  });

  it('a revert is logged as entry.revert and restores the value', async () => {
    const { engine, id, pressure } = await setup();
    const [entry] = await engine.decide(edit(id, pressure, '1508.6'));
    const [revert] = await engine.decide({ kind: 'revert', seq: (entry as AuditEntry).seq, reason: 'Wrong row' });
    expect(revert).toMatchObject({ action: 'entry.revert', target: { seq: (entry as AuditEntry).seq } });
    const rows = await engine.getRows({ datasetId: id, stage: 'working', offset: 3, limit: 1, columns: [pressure] });
    expect(rows.rows[0]).toMatchObject({ cells: [1508.1], edited: [false] });
    await expect(
      engine.decide({ kind: 'revert', seq: (entry as AuditEntry).seq, reason: 'Again' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('an edit replaced by a later edit cannot be reverted on its own', async () => {
    const { engine, id, pressure } = await setup();
    const [first] = await engine.decide(edit(id, pressure, '1508.6'));
    await engine.decide(edit(id, pressure, '1508.7'));
    await expect(
      engine.decide({ kind: 'revert', seq: (first as AuditEntry).seq, reason: 'Undo' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('a source.add entry cannot be reverted', async () => {
    const { engine } = await setup();
    const add = (await engine.listAudit({ action: ['source.add'] })).items[0] as AuditEntry;
    await expect(engine.decide({ kind: 'revert', seq: add.seq, reason: 'Remove it' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('a converted column cannot be edited, and a step others depend on cannot be removed', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_well_daily_golden.csv');
    const pressure = await columnId(engine, ds.id, 'Pressure');
    await awaitJob(
      engine,
      await engine.applyStep(
        ds.id,
        { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'add_column' },
        'kPa too',
      ),
    );
    const derived = `${pressure}~kPa`;
    await expect(engine.decide(edit(ds.id, derived, '1'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await awaitJob(
      engine,
      await engine.applyStep(
        ds.id,
        { kind: 'filter', predicate: { column: derived, op: 'gt', value: 12_000 } },
        'High only',
      ),
    );
    await expect(engine.removeStep(ds.id, 's1', 'No longer needed')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await engine.removeStep(ds.id, 's2', 'Filter not needed');
    await engine.removeStep(ds.id, 's1', 'Conversion not needed');
    expect((await engine.getProject()).datasets[0]?.steps).toEqual([]);
  });

  it('every change to a read-only project is refused with READ_ONLY_PROJECT', async () => {
    const { bytes, datasetId } = await savedProject();
    const tampered = rewriteTwp(bytes, (files) => {
      setText(files, 'audit.jsonl', text(files, 'audit.jsonl').replace('Report in kPa', 'Report in psi'));
    });
    const { engine, report } = await open(tampered);
    expect(report.readOnly).toBe(true);
    const pressure = 'c2';
    const issue = (await engine.listIssues({ datasetId, limit: 1 })).items[0];
    const refused = { code: 'READ_ONLY_PROJECT' };
    const decisions: Decision[] = [
      { kind: 'edit_cell', datasetId, rowId: 0, columnId: pressure, value: { value: 1 }, reason: 'Change it' },
      { kind: 'accept_issue', issueId: issue?.id ?? 'I-x', rows: 'all', reason: 'Accept it' },
      { kind: 'exclude_rows', datasetId, rows: [0], reason: 'Exclude it' },
      { kind: 'comment_issue', issueId: issue?.id ?? 'I-x', text: 'Note' },
      { kind: 'override_detection', datasetId, columnId: pressure, property: 'unit', value: 'kPa', reason: 'Unit' },
      { kind: 'set_project_area', bbox: null, reason: 'Clear it' },
      { kind: 'revert', seq: 1, reason: 'Undo it' },
    ];
    for (const d of decisions) await expect(engine.decide(d), d.kind).rejects.toMatchObject(refused);
    const file = { kind: 'bytes' as const, bytes: fixtureBytes('csv_pipe_delimited.csv'), name: 'x.csv' };
    await expect(engine.importFile(file)).rejects.toMatchObject(refused);
    await expect(engine.runChecks(datasetId)).rejects.toMatchObject(refused);
    await expect(
      engine.applyStep(datasetId, { kind: 'select_columns', columnIds: ['c0'] }, 'Keep one'),
    ).rejects.toMatchObject(refused);
    await expect(engine.removeStep(datasetId, 's1', 'Remove it')).rejects.toMatchObject(refused);
    await expect(engine.exportData({ datasetId, profile: 'csv' })).rejects.toMatchObject(refused);
    await expect(engine.saveProject()).rejects.toMatchObject(refused);
    // Reading still works, so the project can be inspected.
    expect((await engine.getRows({ datasetId, stage: 'working', offset: 0, limit: 5 })).rows).toHaveLength(5);
  });

  it('accepting rows that are not open is refused', async () => {
    const engine = await withProject();
    const ds = await checked(engine, 'csv_duplicates_rows_and_keys.csv');
    const dup = await issueOf(engine, ds.id, 'TW-DQ-003');
    await expect(
      engine.decide({ kind: 'accept_issue', issueId: dup.id, rows: [0], reason: 'Fine' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('import settings', () => {
  it('records a changed delimiter as its own detection.override entry after the detected import', async () => {
    const engine = await withProject();
    const bytes = fixtureBytes('csv_semicolon_decimalcomma_cp1252.csv');
    const preview = await engine.sniff({ kind: 'bytes', bytes, name: 'semi.csv' });
    const options = preview.sniff.options;
    if (options.format !== 'csv') throw new Error('expected CSV');
    const chosen = { ...options, csv: { ...options.csv, delimiter: ',' as const } };
    const repreview = await engine.sniff({ kind: 'bytes', bytes, name: 'semi.csv' }, { options: chosen });
    expect(repreview.columns.length).not.toBe(preview.columns.length);
    await expect(
      awaitJob(engine, await engine.importFile({ kind: 'bytes', bytes, name: 'semi.csv' }, { options: chosen })),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const ds = await awaitJob<{ id: string; columnCount: number }>(
      engine,
      await engine.importFile(
        { kind: 'bytes', bytes, name: 'semi.csv' },
        { options: chosen, overrideReason: 'Testing the comma' },
      ),
    );
    expect(ds.columnCount).toBe(repreview.columns.length);
    const overrides = (await engine.listAudit({ action: ['detection.override'] })).items;
    expect(overrides).toEqual([
      expect.objectContaining({ old: ';', new: ',', reason: 'Testing the comma', payload: { property: 'delimiter' } }),
    ]);
  });
});
