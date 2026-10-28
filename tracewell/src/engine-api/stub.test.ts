import {
  EngineError,
  schemas,
  type AuditEntry,
  type DatasetSummary,
  type ExportResult,
  type Issue,
  type ProjectOpenReport,
  type SaveResult,
  type StepResult,
  type UserProfile,
} from '@tw/model';
import { describe, expect, it } from 'vitest';
import { fakeEngine } from './__fixtures__/fake-engine';
import { EngineClient } from './client';
import { ENGINE_METHODS, PROTOCOL_VERSION, type EngineApi, type EngineEvent } from './protocol';
import { createStubEngine } from './stub';
import { inProcessTransport } from './transport';

const PROFILE: UserProfile = { id: 'u_test', name: 'Prasad', role: 'Analyst' };
const HEX64 = /^[0-9a-f]{64}$/;
const CSV_FILE = { kind: 'bytes' as const, bytes: new Uint8Array([65]), name: 'more_wells.csv' };

function stubClient(): EngineClient {
  return new EngineClient(inProcessTransport(createStubEngine()));
}

async function rejection(p: Promise<unknown>): Promise<EngineError> {
  const e: unknown = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

async function issueOf(c: EngineClient, ruleId: string): Promise<Issue> {
  const page = await c.listIssues({ ruleId });
  const issue = page.items[0];
  if (issue === undefined) throw new Error(`no ${ruleId} issue`);
  return issue;
}

async function audit(c: EngineClient): Promise<AuditEntry[]> {
  return (await c.listAudit({ limit: 1000 })).items;
}

/** One check per protocol method; the Record type makes leaving a method out a compile error. */
const SHAPES: Record<keyof EngineApi, (c: EngineClient) => Promise<void>> = {
  hello: async (c) => {
    const info = await c.hello();
    expect(info).toMatchObject({ name: 'tracewell-stub', protocol: PROTOCOL_VERSION });
    expect(info.capabilities.exportProfiles).toEqual(['excel', 'csv', 'geojson']);
    expect(info.capabilities.spillToDisk).toBe(false);
  },
  newProject: async (c) => {
    const p = await c.newProject({ name: 'Empty', profile: PROFILE, unitSystem: 'Oilfield' });
    expect(p).toMatchObject({ name: 'Empty', unitSystem: 'Oilfield', datasets: [], readOnly: false, profile: PROFILE });
    expect(p.id).toMatch(/^p_[0-9a-f]{16}$/);
    expect(p.auditHead.seq).toBe(1);
  },
  getProject: async (c) => {
    const p = await c.getProject();
    expect(p.datasets).toHaveLength(1);
    expect(p.datasets[0]).toMatchObject({
      id: 'd1',
      name: 'well_daily',
      rowCount: 10,
      outputRowCount: 10,
      columnCount: 5,
      partial: false,
    });
    expect(p.originals[0]?.fileId).toMatch(HEX64);
    expect(p.auditHead.hash).toMatch(HEX64);
  },
  openProject: async (c) => {
    const report = await c.awaitJob<ProjectOpenReport>(await c.openProject({ kind: 'path', path: '/data/review.twp' }));
    expect(report.readOnly).toBe(false);
    expect(report.checks).toHaveLength(8);
    expect(report.checks.every((x) => x.ok)).toBe(true);
    expect(report.project.name).toBe('review');
  },
  saveProject: async (c) => {
    const handle = await c.saveProject({ kind: 'return-bytes' });
    expect(handle.kind).toBe('save');
    const saved = await c.awaitJob<SaveResult>(handle);
    expect(saved.fileName).toBe('Well_test_review.twp');
    expect(saved.bytes).toBeInstanceOf(Uint8Array);
    expect(saved.bytes?.byteLength).toBe(saved.size);
    expect(saved.sha256).toMatch(HEX64);
    const p = await c.getProject();
    expect(p.dirty).toBe(false);
    expect(p.lastSavedAt).not.toBeNull();
  },
  sniff: async (c) => {
    const preview = await c.sniff(CSV_FILE);
    expect(preview).toMatchObject({ fileName: 'more_wells.csv', estimatedRows: 10, exceedsBudget: false, crs: null });
    expect(preview.sniff.format).toBe('csv');
    expect(preview.columns.map((col) => col.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(preview.rows).toHaveLength(10);
    expect(preview.rows[0]).toEqual(['W-01', { date: '2026-01-01' }, 152.4, 1450.2, 12.5]);
    expect(preview.assumptions.some((a) => a.property === 'encoding')).toBe(true);
  },
  importFile: async (c) => {
    const summary = await c.awaitJob<DatasetSummary>(await c.importFile(CSV_FILE));
    expect(summary).toMatchObject({ id: 'd2', name: 'more_wells', rowCount: 10, columnCount: 5 });
    expect((await c.getProject()).datasets).toHaveLength(2);
  },
  getSchema: async (c) => {
    const schema = await c.getSchema('d1');
    expect(schema).toMatchObject({ datasetId: 'd1', rowCount: 10, crs: null, partial: false });
    expect(schema.columns.map((col) => [col.id, col.type.value, col.unit.value])).toEqual([
      ['c0', 'string', null],
      ['c1', 'date', null],
      ['c2', 'number', 'm3/d'],
      ['c3', 'number', 'psia'],
      ['c4', 'number', '%'],
    ]);
  },
  getRows: async (c) => {
    const w = await c.getRows({ datasetId: 'd1', stage: 'working', offset: 4, limit: 3 });
    expect(w.totalRows).toBe(10);
    expect(w.rows.map((r) => [r.rowId, r.locator])).toEqual([
      [4, 'line 6'],
      [5, 'line 7'],
      [6, 'line 8'],
    ]);
    expect(w.columns.find((col) => col.id === 'c4')?.assumed).toBe(true);
    // Row 4 has a missing THP (warning) that was also a null marker (note): the worst one shows.
    expect(w.rows[0]?.issue).toEqual([null, null, null, 'warning', null]);
    expect(w.rows[2]?.cells[2]).toBe(-4);
    expect(w.rows[2]?.issue[2]).toBe('error');
  },
  getColumnStats: async (c) => {
    expect(await c.getColumnStats('d1', 'c3')).toMatchObject({
      count: 10,
      nulls: 2,
      rawRejected: 0,
      distinct: 8,
      min: 1204,
      max: 1450.2,
    });
    expect(await c.getColumnStats('d1', 'c2')).toMatchObject({ nulls: 0, min: -4, max: 152.4 });
  },
  explainCell: async (c) => {
    const l = await c.explainCell('d1', 4, 'c3');
    expect(l.source).toMatchObject({ fileName: 'well_daily.csv', locator: 'line 6, field 4', rawText: 'NA' });
    expect(l.parse).toMatchObject({ type: 'number', nullMarker: 'NA', ok: true });
    expect(l.current).toBeNull();
    expect(l.history).toEqual([]);
  },
  runChecks: async (c) => {
    const summary = await c.awaitJob(await c.runChecks('d1'));
    expect(summary).toMatchObject({ datasetId: 'd1', issues: 3, bySeverity: { error: 1, warning: 1, note: 1 } });
  },
  listIssues: async (c) => {
    const page = await c.listIssues({});
    expect(page.total).toBe(3);
    expect(page.items.map((i) => [i.ruleId, i.severity, i.columns, i.status, i.counts.open])).toEqual([
      ['TW-DQ-005', 'error', ['c2'], 'open', 1],
      ['TW-DQ-001', 'warning', ['c3'], 'open', 2],
      ['TW-DQ-006', 'note', ['c3'], 'open', 2],
    ]);
    for (const i of page.items) expect(i.id).toMatch(/^I-[0-9a-f]{12}$/);
  },
  listOccurrences: async (c) => {
    const issue = await issueOf(c, 'TW-DQ-001');
    const page = await c.listOccurrences(issue.id, { offset: 0, limit: 10 });
    expect(page.items.map((o) => [o.rowId, o.locator, o.state, o.raw, o.value])).toEqual([
      [4, 'line 6', 'open', 'NA', null],
      [7, 'line 9', 'open', 'NA', null],
    ]);
  },
  getHealth: async (c) => {
    const ds = (await c.getProject()).datasets[0]?.id as string;
    const health = await c.getHealth(ds);
    expect(health).toMatchObject({ datasetId: ds, checked: true });
    expect(health.score).toBeGreaterThan(0);
    expect(health.score).toBeLessThan(100);
    expect(health.categories.map((x) => x.category)).toEqual([
      'completeness',
      'uniqueness',
      'validity',
      'range',
      'units',
      'time',
      'spatial',
      'import',
    ]);
  },
  decide: async (c) => {
    const issue = await issueOf(c, 'TW-DQ-006');
    const entries = await c.decide({
      kind: 'accept_issue',
      issueId: issue.id,
      rows: 'all',
      reason: 'Expected for a shut-in gauge.',
    });
    expect(entries.map((e) => e.action)).toEqual(['issue.accept']);
    expect((await issueOf(c, 'TW-DQ-006')).status).toBe('resolved');
  },
  listAudit: async (c) => {
    const page = await c.listAudit({});
    expect(page.items.map((e) => e.action)).toEqual(['project.create', 'source.add', 'detection.assume', 'check.run']);
    for (const e of page.items) expect(schemas.auditEntry.safeParse(e).success).toBe(true);
    expect((await c.listAudit({ order: 'desc', limit: 1 })).items[0]?.action).toBe('check.run');
  },
  verifyAudit: async (c) => {
    expect(await c.verifyAudit()).toEqual({ ok: true, entries: 4 });
  },
  previewStep: async (c) => {
    const preview = await c.previewStep('d1', { kind: 'convert_unit', columnId: 'c3', toUnit: 'kPa', mode: 'replace' });
    expect(preview.ok).toBe(true);
    expect(preview.method).toMatchObject({ from: 'psia', to: 'kPa' });
    expect(preview.sample).toHaveLength(5);
    expect(preview.sample[0]?.after).toBeCloseTo(1450.2 * 6.894757293168361, 9);
  },
  applyStep: async (c) => {
    const handle = await c.applyStep(
      'd1',
      { kind: 'filter', predicate: { column: 'c0', op: 'eq', value: 'W-01' } },
      'Review well W-01 first.',
    );
    const result = await c.awaitJob<StepResult>(handle);
    expect(result.step).toMatchObject({ id: 's1', kind: 'filter' });
    expect(result.outputRows).toBe(5);
    expect(result.audit.action).toBe('step.apply');
  },
  removeStep: async (c) => {
    await c.awaitJob(
      await c.applyStep('d1', { kind: 'select_columns', columnIds: ['c0', 'c2'] }, 'Only rates matter.'),
    );
    const entry = await c.removeStep('d1', 's1', 'All columns are needed.');
    expect(entry).toMatchObject({ action: 'step.remove', target: { datasetId: 'd1', stepId: 's1' } });
    expect((await c.getSchema('d1', 'output')).columns).toHaveLength(5);
  },
  listUnits: async (c) => {
    expect((await c.listUnits({ compatibleWith: 'psia' })).map((u) => u.code)).toEqual(['kPa', 'bar', 'psia']);
    expect((await c.listUnits({ quantity: 'fraction' })).map((u) => u.code)).toEqual(['fraction', '%']);
    expect(Object.keys((await c.listUnits())[0] ?? {}).sort()).toEqual(['code', 'convention', 'label', 'quantity']);
  },
  listRulePacks: async (c) => {
    const packs = await c.listRulePacks();
    expect(packs).toHaveLength(1);
    for (const p of packs) expect(schemas.rulePack.safeParse(p).success).toBe(true);
  },
  listExportProfiles: async (c) => {
    const statuses = await c.listExportProfiles('d1');
    expect(statuses.map((s) => [s.profile.id, s.available])).toEqual([
      ['excel', true],
      ['csv', true],
      ['geojson', false],
    ]);
    expect(statuses[2]?.reason).toBeTruthy();
    expect(statuses[2]?.fix).toBeTruthy();
  },
  exportData: async (c) => {
    const result = await c.awaitJob<ExportResult>(await c.exportData({ datasetId: 'd1', profile: 'excel' }));
    expect(result.ok).toBe(true);
    expect(result.bytes?.byteLength).toBe(result.size);
    const parsed = schemas.exportManifest.safeParse(result.manifest);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(result.manifest.dataset.columns.map((col) => col.header)).toEqual([
      'Well',
      'Date',
      'Oil rate [m3/d]',
      'THP [psia]',
      'Water cut [%]',
    ]);
    expect((await c.getProject()).exports).toHaveLength(1);
  },
  cancelJob: async (c) => {
    const before = (await audit(c)).length;
    const handle = await c.runChecks('d1');
    await c.cancelJob(handle.jobId);
    expect((await rejection(c.awaitJob(handle))).code).toBe('CANCELLED');
    expect(await audit(c)).toHaveLength(before);
    expect(await c.jobOutcome(handle.jobId)).toEqual({ state: 'cancelled' });
  },
  jobOutcome: async (c) => {
    expect((await rejection(c.jobOutcome('j99'))).code).toBe('NOT_FOUND');
    const handle = await c.runChecks('d1');
    expect(await c.jobOutcome(handle.jobId)).toEqual({ state: 'running', progress: null });
    await c.awaitJob(handle);
    expect(await c.jobOutcome(handle.jobId)).toMatchObject({ state: 'done', result: { issues: 3 } });
  },
};

describe('createStubEngine: a minimal shape check of every method', () => {
  it.each(ENGINE_METHODS)('%s', async (method) => {
    const client = stubClient();
    await SHAPES[method](client);
    client.close();
  });
});

describe('createStubEngine: canned project', () => {
  it('is deterministic: two stubs give identical projects, logs and hashes', async () => {
    const [a, b] = [stubClient(), stubClient()];
    expect(await a.getProject()).toEqual(await b.getProject());
    expect(await audit(a)).toEqual(await audit(b));
    expect((await a.getProject()).createdAt).toBe('2026-10-19T08:00:00.000Z');
  });

  it('structured-clones results through inProcessTransport: a client-side mutation does not reach the stub', async () => {
    const c = stubClient();
    const project = await c.getProject();
    project.name = 'changed';
    project.datasets.length = 0;
    const rows = await c.getRows({ datasetId: 'd1', stage: 'working', offset: 0, limit: 1 });
    rows.rows[0]?.cells.splice(0, 1, 'X');
    const issue = await issueOf(c, 'TW-DQ-001');
    issue.counts.open = 0;
    expect((await c.getProject()).name).toBe('Well test review');
    expect((await c.getProject()).datasets).toHaveLength(1);
    expect((await c.getRows({ datasetId: 'd1', stage: 'working', offset: 0, limit: 1 })).rows[0]?.cells[0]).toBe(
      'W-01',
    );
    expect((await issueOf(c, 'TW-DQ-001')).counts.open).toBe(2);
  });

  it('inProcessTransport copies results and parameters, so neither side can change the other through them', async () => {
    // The stub builds fresh objects for most answers; an engine that returns its own state shows the copy.
    const held = { name: 'kept', datasets: [{ id: 'd1' }] };
    let received: { offset: number } | undefined;
    const impl = fakeEngine({
      getProject: async () => held as never,
      getRows: async (q) => {
        received = q;
        q.offset = 99;
        return {} as never;
      },
    });
    const c = new EngineClient(inProcessTransport(impl));
    const project = await c.getProject();
    expect(project).toEqual(held);
    expect(project).not.toBe(held);
    project.name = 'changed';
    project.datasets.length = 0;
    expect(held).toEqual({ name: 'kept', datasets: [{ id: 'd1' }] });
    const q = { datasetId: 'd1', stage: 'working' as const, offset: 0, limit: 1 };
    await c.getRows(q);
    expect(received).toEqual({ ...q, offset: 99 });
    expect(q.offset).toBe(0);
    c.close();
  });

  it('reports job progress, the change and completion as events, in that order', async () => {
    const c = stubClient();
    const events: EngineEvent['type'][] = [];
    c.onEvent((e) => events.push(e.type));
    await c.awaitJob(await c.runChecks('d1'));
    expect(events).toEqual(['job.progress', 'job.progress', 'job.progress', 'project.changed', 'job.done']);
  });
});

describe('createStubEngine: review decisions', () => {
  it('refuses a missing or too short reason with REASON_REQUIRED and logs nothing', async () => {
    const c = stubClient();
    for (const reason of ['', '  a ']) {
      const e = await rejection(
        c.decide({ kind: 'edit_cell', datasetId: 'd1', rowId: 6, columnId: 'c2', value: { text: '4.0' }, reason }),
      );
      expect(e.code).toBe('REASON_REQUIRED');
      expect(e.fix).toContain('3');
    }
    expect(await audit(c)).toHaveLength(4);
  });

  it('counts visible characters in a reason: emoji halves and zero-width spaces do not make it long enough', async () => {
    const c = stubClient();
    const area = (reason: string) => c.decide({ kind: 'set_project_area', bbox: [1, 50, 3, 52], reason });
    for (const reason of ['a\u{1F44D}', '​​​', 'ok​', '﻿﻿x']) {
      expect((await rejection(area(reason))).code).toBe('REASON_REQUIRED');
    }
    expect(await audit(c)).toHaveLength(4);
    // Three characters outside the Latin alphabet are a valid reason.
    await expect(area('検査済')).resolves.toHaveLength(1);
  });

  it('refuses dates that do not exist and integers beyond 2^53, rather than storing them', async () => {
    const c = stubClient();
    const edit = (columnId: string, value: { text: string } | { value: { date: string } }) =>
      c.decide({ kind: 'edit_cell', datasetId: 'd1', rowId: 0, columnId, value, reason: 'Correct it.' });
    for (const text of ['2026-02-30', '2026-13-01', '2025-02-29']) {
      expect((await rejection(edit('c1', { text }))).code).toBe('INVALID_INPUT');
    }
    expect((await rejection(edit('c1', { value: { date: '2026-02-30' } }))).code).toBe('INVALID_INPUT');
    await expect(edit('c1', { text: '2024-02-29' })).resolves.toMatchObject([{ new: { date: '2024-02-29' } }]);

    await c.decide({
      kind: 'override_detection',
      datasetId: 'd1',
      columnId: 'c2',
      property: 'type',
      value: 'integer',
      reason: 'Whole cubic metres.',
    });
    expect((await rejection(edit('c2', { text: '9007199254740993' }))).code).toBe('INVALID_INPUT');
    await expect(edit('c2', { text: '152' })).resolves.toMatchObject([{ new: 152 }]);
  });

  it('refuses text that does not fit the column with INVALID_INPUT and a fix', async () => {
    const e = await rejection(
      stubClient().decide({
        kind: 'edit_cell',
        datasetId: 'd1',
        rowId: 6,
        columnId: 'c2',
        value: { text: 'abc' },
        reason: 'typo',
      }),
    );
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.fix).toContain('number');
  });

  it('refuses unknown targets with NOT_FOUND and malformed decisions with INVALID_INPUT', async () => {
    const c = stubClient();
    const edit = {
      kind: 'edit_cell' as const,
      datasetId: 'd1',
      rowId: 6,
      columnId: 'c2',
      value: { text: '4' },
      reason: 'typo fix',
    };
    expect((await rejection(c.decide({ ...edit, datasetId: 'd9' }))).code).toBe('NOT_FOUND');
    expect((await rejection(c.decide({ ...edit, rowId: 10 }))).code).toBe('NOT_FOUND');
    expect((await rejection(c.decide({ ...edit, columnId: 'c7' }))).code).toBe('NOT_FOUND');
    expect((await rejection(c.decide({ ...edit, kind: 'rename' } as never))).code).toBe('INVALID_INPUT');
  });

  it('edits a cell, fixing the issue, and reverts the edit with a compensating entry', async () => {
    const c = stubClient();
    const [edit] = await c.decide({
      kind: 'edit_cell',
      datasetId: 'd1',
      rowId: 6,
      columnId: 'c2',
      value: { text: '96.8' },
      reason: 'Sign lost in transfer.',
    });
    expect(edit).toMatchObject({
      action: 'cell.edit',
      old: -4,
      new: 96.8,
      reason: 'Sign lost in transfer.',
      target: { rowId: 6, columnId: 'c2', locator: 'line 8, field 3' },
    });
    expect(edit?.actor).toEqual({ kind: 'user', profileId: 'u_prasad', name: 'Prasad', role: 'Analyst' });
    const fixed = await issueOf(c, 'TW-DQ-005');
    expect(fixed).toMatchObject({ status: 'resolved', counts: { flagged: 1, open: 0, fixed: 1 } });
    const row = (await c.getRows({ datasetId: 'd1', stage: 'working', offset: 6, limit: 1 })).rows[0];
    expect(row?.edited[2]).toBe(true);
    expect((await c.explainCell('d1', 6, 'c2')).history.map((h) => h.action)).toEqual(['cell.edit']);

    const [undo] = await c.decide({ kind: 'revert', seq: edit?.seq ?? 0, reason: 'Wrong row edited.' });
    expect(undo).toMatchObject({ action: 'entry.revert', target: { seq: edit?.seq } });
    expect((await c.getRows({ datasetId: 'd1', stage: 'working', offset: 6, limit: 1 })).rows[0]?.cells[2]).toBe(-4);
    expect((await issueOf(c, 'TW-DQ-005')).status).toBe('open');
    expect((await rejection(c.decide({ kind: 'revert', seq: edit?.seq ?? 0, reason: 'Again please.' }))).code).toBe(
      'INVALID_INPUT',
    );
    expect(await c.verifyAudit()).toMatchObject({ ok: true });
  });

  it('refuses to revert entries that are not revertible, or an edit a later edit replaced', async () => {
    const c = stubClient();
    expect((await rejection(c.decide({ kind: 'revert', seq: 2, reason: 'Not this file.' }))).code).toBe(
      'INVALID_INPUT',
    );
    const base = { kind: 'edit_cell' as const, datasetId: 'd1', rowId: 0, columnId: 'c2' };
    const [first] = await c.decide({ ...base, value: { value: 150 }, reason: 'First pass.' });
    await c.decide({ ...base, value: { value: 151 }, reason: 'Second pass.' });
    const e = await rejection(c.decide({ kind: 'revert', seq: first?.seq ?? 0, reason: 'Undo first.' }));
    expect(e).toMatchObject({ code: 'INVALID_INPUT' });
    expect(e.fix).toContain('later');
  });

  it('refuses to revert an edit while a later edit of the cell is in effect, even one that set the same value', async () => {
    const c = stubClient();
    const base = { kind: 'edit_cell' as const, datasetId: 'd1', rowId: 6, columnId: 'c2' };
    const [first] = await c.decide({ ...base, value: { text: '4' }, reason: 'Sign error in the report.' });
    const [second] = await c.decide({ ...base, value: { text: '5' }, reason: 'Field log says 5.' });
    const [third] = await c.decide({ ...base, value: { text: '4' }, reason: 'The report was right.' });
    const revert = (seq: number | undefined) => c.decide({ kind: 'revert', seq: seq ?? 0, reason: 'Undo this one.' });
    const value = async () =>
      (await c.getRows({ datasetId: 'd1', stage: 'working', offset: 6, limit: 1 })).rows[0]?.cells[2];
    // Reverting the first edit now would silently discard the second and third.
    const e = await rejection(revert(first?.seq));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.fix).toContain('later');
    expect(await value()).toBe(4);
    await revert(third?.seq);
    expect(await value()).toBe(5);
    await revert(second?.seq);
    expect(await value()).toBe(4);
    await revert(first?.seq);
    expect(await value()).toBe(-4);
  });

  it('says an issue has no open rows to exclude, rather than that its rows are already excluded', async () => {
    const c = stubClient();
    const issue = await issueOf(c, 'TW-DQ-006');
    await c.decide({ kind: 'accept_issue', issueId: issue.id, rows: 'all', reason: 'Known shut-in markers.' });
    const e = await rejection(
      c.decide({ kind: 'exclude_rows', datasetId: 'd1', rows: { issueId: issue.id }, reason: 'Drop them.' }),
    );
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toContain('no open rows');
  });

  it('accepts some rows (partly resolved), then excludes the rest (resolved, counted as excluded)', async () => {
    const c = stubClient();
    const issue = await issueOf(c, 'TW-DQ-001');
    await c.decide({ kind: 'accept_issue', issueId: issue.id, rows: [4], reason: 'Gauge was offline.' });
    expect(await issueOf(c, 'TW-DQ-001')).toMatchObject({
      status: 'partly_resolved',
      counts: { open: 1, accepted: 1 },
    });
    await c.decide({ kind: 'exclude_rows', datasetId: 'd1', rows: { issueId: issue.id }, reason: 'Unusable test.' });
    expect(await issueOf(c, 'TW-DQ-001')).toMatchObject({
      status: 'resolved',
      counts: { open: 0, accepted: 1, excluded: 1 },
    });
    expect((await c.getProject()).datasets[0]?.outputRowCount).toBe(9);
  });

  it('writes a renamed column into issue messages exactly as typed, $ signs included', async () => {
    const c = stubClient();
    const name = "THP $& $' $$ gauge";
    await c.decide({
      kind: 'override_detection',
      datasetId: 'd1',
      columnId: 'c3',
      property: 'name',
      value: name,
      reason: 'Match the field sheet.',
    });
    expect((await issueOf(c, 'TW-DQ-001')).message).toBe(`2 missing values in ${name}`);
  });

  it('refuses an issue sort it does not know, including names inherited by every object', async () => {
    const c = stubClient();
    for (const sort of ['constructor', '__proto__', 'toString', 'size']) {
      const e = await rejection(c.listIssues({ sort: sort as never }));
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.fix).toContain('severity');
    }
  });

  it('adds comments to the issue', async () => {
    const c = stubClient();
    const issue = await issueOf(c, 'TW-DQ-005');
    await c.decide({ kind: 'comment_issue', issueId: issue.id, text: 'Ask the field office.' });
    expect((await issueOf(c, 'TW-DQ-005')).comments).toMatchObject([{ by: 'Prasad', text: 'Ask the field office.' }]);
  });

  it('applies a unit override, which re-checks the column, and reverts it', async () => {
    const c = stubClient();
    const [entry] = await c.decide({
      kind: 'override_detection',
      datasetId: 'd1',
      columnId: 'c4',
      property: 'unit',
      value: 'fraction',
      reason: 'Values are fractions.',
    });
    expect(entry).toMatchObject({
      action: 'detection.override',
      old: '%',
      new: 'fraction',
      payload: { property: 'unit' },
    });
    const schema = await c.getSchema('d1');
    expect(schema.columns[4]?.unit).toMatchObject({
      value: 'fraction',
      source: 'user',
      assumed: false,
      overriddenBy: entry?.seq,
    });
    // As fractions, 12.5 to 31.2 are far above 1: the range rule now flags every water-cut value.
    const ranges = (await c.listIssues({ ruleId: 'TW-DQ-005', columnId: 'c4' })).items[0];
    expect(ranges?.counts.open).toBe(10);
    await c.decide({ kind: 'revert', seq: entry?.seq ?? 0, reason: 'Percent after all.' });
    expect((await c.getSchema('d1')).columns[4]?.unit.value).toBe('%');
    expect((await c.listIssues({ ruleId: 'TW-DQ-005', columnId: 'c4' })).items[0]?.status).toBe('resolved');
  });

  it('confirms dataset-level detections but refuses to change them without the file', async () => {
    const c = stubClient();
    // Encoding, the THP null markers and the water-cut unit are assumed.
    expect((await c.getProject()).datasets[0]?.assumptions).toBe(3);
    await c.decide({
      kind: 'override_detection',
      datasetId: 'd1',
      property: 'encoding',
      value: 'utf-8',
      reason: 'Checked the source.',
    });
    expect((await c.getProject()).datasets[0]?.assumptions).toBe(2);
    const e = await rejection(
      c.decide({
        kind: 'override_detection',
        datasetId: 'd1',
        property: 'delimiter',
        value: ';',
        reason: 'Semicolons.',
      }),
    );
    expect(e.code).toBe('INVALID_INPUT');
    const sheet = await rejection(
      c.decide({
        kind: 'override_detection',
        datasetId: 'd1',
        property: 'sheet',
        value: 'Sheet1',
        reason: 'Wrong sheet.',
      }),
    );
    expect(sheet.code).toBe('INVALID_INPUT');
  });

  it('reverting an override restores only that property, keeping later overrides of the column', async () => {
    const c = stubClient();
    const override = (property: 'name' | 'role', value: string) =>
      c.decide({ kind: 'override_detection', datasetId: 'd1', columnId: 'c0', property, value, reason: 'Clearer.' });
    const [named] = await override('name', 'Asset');
    const [roled] = await override('role', 'text');
    await c.decide({ kind: 'revert', seq: named?.seq ?? 0, reason: 'Keep the file name.' });
    let column = (await c.getSchema('d1')).columns[0];
    expect([column?.name, column?.role.value, column?.role.source]).toEqual(['Well', 'text', 'user']);
    await c.decide({ kind: 'revert', seq: roled?.seq ?? 0, reason: 'It is an ID.' });
    column = (await c.getSchema('d1')).columns[0];
    expect([column?.name, column?.role.value, column?.role.source]).toEqual(['Well', 'id', 'detected']);
  });

  it('refuses to revert a type override that a later unit override relies on', async () => {
    const c = stubClient();
    const override = (property: 'type' | 'unit', value: string) =>
      c.decide({ kind: 'override_detection', datasetId: 'd1', columnId: 'c0', property, value, reason: 'Gauge IDs.' });
    const [typed] = await override('type', 'number');
    const [unit] = await override('unit', 'kPa');
    const e = await rejection(c.decide({ kind: 'revert', seq: typed?.seq ?? 0, reason: 'Text after all.' }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.fix).toContain('unit');
    expect((await c.getSchema('d1')).columns[0]).toMatchObject({ type: { value: 'number' }, unit: { value: 'kPa' } });
    await c.decide({ kind: 'revert', seq: unit?.seq ?? 0, reason: 'No unit.' });
    await c.decide({ kind: 'revert', seq: typed?.seq ?? 0, reason: 'Text after all.' });
    expect((await c.getSchema('d1')).columns[0]).toMatchObject({ type: { value: 'string' }, unit: { value: null } });
  });

  it('refuses a type change that an edited cell does not fit, whether by override or by revert', async () => {
    const c = stubClient();
    const typeOverride = (value: string) =>
      c.decide({
        kind: 'override_detection',
        datasetId: 'd1',
        columnId: 'c2',
        property: 'type',
        value,
        reason: 'Retype.',
      });
    const edit = (value: { text: string }) =>
      c.decide({ kind: 'edit_cell', datasetId: 'd1', rowId: 6, columnId: 'c2', value, reason: 'Sign lost.' });
    const [edited] = await edit({ text: '96.8' });
    for (const type of ['integer', 'string']) {
      const e = await rejection(typeOverride(type));
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.message).toContain('row 6');
    }
    expect((await c.getRows({ datasetId: 'd1', stage: 'working', offset: 6, limit: 1 })).columns[2]?.type).toBe(
      'number',
    );

    await c.decide({ kind: 'revert', seq: edited?.seq ?? 0, reason: 'Wrong row.' });
    const [retyped] = await typeOverride('string');
    await edit({ text: 'see field log' });
    const e = await rejection(c.decide({ kind: 'revert', seq: retyped?.seq ?? 0, reason: 'Numbers again.' }));
    expect(e.code).toBe('INVALID_INPUT');
    const w = await c.getRows({ datasetId: 'd1', stage: 'working', offset: 6, limit: 1 });
    expect([w.columns[2]?.type, w.rows[0]?.cells[2]]).toEqual(['string', 'see field log']);
  });

  it('refuses a type change on a column a filter compares, which would empty the output', async () => {
    const c = stubClient();
    const filter = await c.awaitJob<StepResult>(
      await c.applyStep('d1', { kind: 'filter', predicate: { column: 'c3', op: 'gt', value: 1300 } }, 'High THP.'),
    );
    const retype = {
      kind: 'override_detection' as const,
      datasetId: 'd1',
      columnId: 'c3',
      property: 'type' as const,
      value: 'string',
      reason: 'Gauge text.',
    };
    const e = await rejection(c.decide(retype));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.fix).toContain(filter.step.id);
    expect((await c.getSchema('d1', 'output')).rowCount).toBe(4);
    // A unit override reinterprets the values the filter compares, which is what the user asked for.
    await expect(c.decide({ ...retype, property: 'unit', value: 'bar' })).resolves.toHaveLength(1);
  });

  it('sets and reverts the project area', async () => {
    const c = stubClient();
    const [entry] = await c.decide({ kind: 'set_project_area', bbox: [1, 50, 3, 52], reason: 'North Sea block.' });
    expect((await c.getProject()).projectArea).toEqual([1, 50, 3, 52]);
    await c.decide({ kind: 'revert', seq: entry?.seq ?? 0, reason: 'Wrong block.' });
    expect((await c.getProject()).projectArea).toBeNull();
  });
});

describe('createStubEngine: steps', () => {
  it('refuses unsafe conversions in the preview with the units library codes', async () => {
    const c = stubClient();
    const preview = (toUnit: string) =>
      c.previewStep('d1', { kind: 'convert_unit', columnId: 'c3', toUnit, mode: 'replace' });
    expect((await preview('psig')).error?.code).toBe('UNIT_GAUGE_ABSOLUTE');
    expect((await preview('m3/d')).error?.code).toBe('UNIT_DIMENSION');
    expect((await preview('furlong')).error?.code).toBe('UNIT_UNKNOWN');
    expect(
      (await c.previewStep('d1', { kind: 'convert_unit', columnId: 'c2', toUnit: 'stb/d', mode: 'replace' })).error
        ?.code,
    ).toBe('UNIT_CONVENTION');
    expect(
      (
        await rejection(
          c.applyStep('d1', { kind: 'convert_unit', columnId: 'c3', toUnit: 'psig', mode: 'replace' }, 'Gauge please.'),
        )
      ).code,
    ).toBe('UNIT_GAUGE_ABSOLUTE');
  });

  it('converts a column in place, records the method, keeps its issues and explains converted cells', async () => {
    const c = stubClient();
    const result = await c.awaitJob<StepResult>(
      await c.applyStep(
        'd1',
        { kind: 'convert_unit', columnId: 'c3', toUnit: 'kPa', mode: 'replace' },
        'Report in SI.',
      ),
    );
    expect(result).toMatchObject({
      converted: 8,
      nullsSkipped: 2,
      method: { from: 'psia', to: 'kPa' },
      outputRows: 10,
    });
    expect(result.audit.method).toMatchObject({ from: 'psia', to: 'kPa', registryVersion: '2026.1' });
    expect((await c.getSchema('d1')).columns.map((col) => col.id)).toEqual(['c0', 'c1', 'c2', 'c3~kPa', 'c4']);
    expect((await issueOf(c, 'TW-DQ-001')).counts.open).toBe(2);
    const l = await c.explainCell('d1', 0, 'c3~kPa');
    expect(l.source.rawText).toBe('1450.2');
    expect(l.history.map((h) => [h.action, h.method?.to])).toEqual([['step.apply', 'kPa']]);
    expect(l.current).toBeCloseTo(1450.2 * 6.894757293168361, 9);
    const e = await rejection(
      c.decide({
        kind: 'edit_cell',
        datasetId: 'd1',
        rowId: 0,
        columnId: 'c3~kPa',
        value: { value: 1 },
        reason: 'Edit it.',
      }),
    );
    expect(e.code).toBe('INVALID_INPUT');
    expect(
      (
        await rejection(
          c.decide({
            kind: 'override_detection',
            datasetId: 'd1',
            columnId: 'c3',
            property: 'unit',
            value: 'bar',
            reason: 'It was bar.',
          }),
        )
      ).code,
    ).toBe('INVALID_INPUT');
  });

  it("filters a date column with 'in' the way it does with 'eq', instead of matching nothing", async () => {
    const c = stubClient();
    const rows = async (predicate: object) =>
      (await c.previewStep('d1', { kind: 'filter', predicate } as never)).resultingRows;
    expect(await rows({ column: 'c1', op: 'eq', value: '2026-01-01' })).toBe(2);
    expect(await rows({ column: 'c1', op: 'in', values: ['2026-01-01', '2026-01-05'] })).toBe(4);
    expect(await rows({ column: 'c0', op: 'in', values: ['W-02'] })).toBe(5);
    expect(await rows({ column: 'c2', op: 'in', values: [98.3, -4] })).toBe(2);
  });

  it('keeps the output columns in the order a selection lists them', async () => {
    const c = stubClient();
    await c.awaitJob(await c.applyStep('d1', { kind: 'select_columns', columnIds: ['c3', 'c0'] }, 'THP by well.'));
    expect((await c.getSchema('d1', 'output')).columns.map((col) => col.id)).toEqual(['c3', 'c0']);
    const w = await c.getRows({ datasetId: 'd1', stage: 'output', offset: 0, limit: 1 });
    expect(w.columns.map((col) => col.id)).toEqual(['c3', 'c0']);
    expect(w.rows[0]?.cells).toEqual([1450.2, 'W-01']);
    const result = await c.awaitJob<ExportResult>(await c.exportData({ datasetId: 'd1', profile: 'csv' }));
    expect(result.manifest.dataset.columns.map((col) => col.id)).toEqual(['c3', 'c0']);
  });

  it('refuses a replacing conversion of a column that an earlier filter or selection uses', async () => {
    const c = stubClient();
    await c.awaitJob(
      await c.applyStep('d1', { kind: 'filter', predicate: { column: 'c3', op: 'gt', value: 1300 } }, 'High THP.'),
    );
    await c.awaitJob(await c.applyStep('d1', { kind: 'select_columns', columnIds: ['c0', 'c3'] }, 'THP only.'));
    const replace = { kind: 'convert_unit' as const, columnId: 'c3', toUnit: 'kPa', mode: 'replace' as const };
    const preview = await c.previewStep('d1', replace);
    expect(preview).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const e = await rejection(c.applyStep('d1', replace, 'Report in SI.'));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.fix).toContain('s1');
    const output = await c.getSchema('d1', 'output');
    expect([output.rowCount, output.columns.map((col) => col.id)]).toEqual([4, ['c0', 'c3']]);
    // Converting into a new column leaves the source in place, so it stays allowed.
    await c.awaitJob(await c.applyStep('d1', { ...replace, mode: 'add_column' }, 'Report in SI.'));
    expect((await c.getSchema('d1', 'output')).rowCount).toBe(4);
  });

  it('refuses to select a column that an earlier selection left out, rather than output no columns', async () => {
    const c = stubClient();
    await c.awaitJob(await c.applyStep('d1', { kind: 'select_columns', columnIds: ['c0', 'c1'] }, 'Keys only.'));
    const later = { kind: 'select_columns' as const, columnIds: ['c1', 'c2'] };
    expect(await c.previewStep('d1', later)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const e = await rejection(c.applyStep('d1', later, 'Rates too.'));
    expect(e.message).toContain('c2');
    expect((await c.getSchema('d1', 'output')).columns.map((col) => col.id)).toEqual(['c0', 'c1']);
    await c.awaitJob(await c.applyStep('d1', { kind: 'select_columns', columnIds: ['c1'] }, 'Dates only.'));
    expect((await c.getSchema('d1', 'output')).columns.map((col) => col.id)).toEqual(['c1']);
  });

  it('refuses to remove a step another step depends on', async () => {
    const c = stubClient();
    await c.awaitJob(
      await c.applyStep('d1', { kind: 'convert_unit', columnId: 'c3', toUnit: 'bar', mode: 'add_column' }, 'Bar too.'),
    );
    await c.awaitJob(
      await c.applyStep(
        'd1',
        { kind: 'filter', predicate: { column: 'c3~bar', op: 'gt', value: 100 } },
        'High pressure.',
      ),
    );
    const e = await rejection(c.removeStep('d1', 's1', 'Not needed.'));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.fix).toContain('s2');
    await c.removeStep('d1', 's2', 'Not needed.');
    await c.removeStep('d1', 's1', 'Not needed.');
    expect((await c.getProject()).datasets[0]?.steps).toEqual([]);
  });
});

describe('createStubEngine: imports, exports and project files', () => {
  it('applies import overrides only with a reason, logging them after the detections', async () => {
    const c = stubClient();
    const overrides = [{ columnId: 'c4', unit: 'fraction' }];
    expect((await rejection(c.importFile(CSV_FILE, { columnOverrides: overrides }))).code).toBe('REASON_REQUIRED');
    expect(
      (
        await rejection(
          c.importFile(CSV_FILE, { columnOverrides: [{ columnId: 'c4', unit: 'furlong' }], overrideReason: 'Known.' }),
        )
      ).code,
    ).toBe('UNIT_UNKNOWN');
    await c.awaitJob(
      await c.importFile(CSV_FILE, {
        name: 'Wells',
        columnOverrides: overrides,
        overrideReason: 'Fractions in this file.',
      }),
    );
    const actions = (await c.listAudit({ datasetId: 'd2' })).items.map((e) => e.action);
    expect(actions).toEqual(['source.add', 'detection.assume', 'detection.override']);
    expect((await c.getSchema('d2')).columns[4]?.unit.value).toBe('fraction');
  });

  it('imports with the detected reading options and refuses other options instead of ignoring them', async () => {
    const c = stubClient();
    const preview = await c.sniff(CSV_FILE);
    const detected = preview.sniff.options;
    if (detected.format !== 'csv') throw new Error('the stub sniffs CSV');
    for (const options of [
      { ...detected, csv: { ...detected.csv, delimiter: ';' as const } },
      { ...detected, csv: { ...detected.csv, encoding: 'windows-1252' as const } },
      { ...detected, format: 'tsv' as const },
    ]) {
      const e = await rejection(c.importFile(CSV_FILE, { options }));
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.fix).toContain('detected');
    }
    expect((await c.getProject()).datasets).toHaveLength(1);
    const summary = await c.awaitJob<DatasetSummary>(await c.importFile(CSV_FILE, { options: detected }));
    expect(summary.id).toBe('d2');
  });

  it('fails a GeoJSON export job with EXPORT_REFUSED and refuses path targets at once', async () => {
    const c = stubClient();
    const e = await rejection(c.awaitJob(await c.exportData({ datasetId: 'd1', profile: 'geojson' })));
    expect(e.code).toBe('EXPORT_REFUSED');
    expect((await c.getProject()).exports).toEqual([]);
    expect(
      (await rejection(c.exportData({ datasetId: 'd1', profile: 'csv', target: { kind: 'path', path: '/tmp/x.zip' } })))
        .code,
    ).toBe('INVALID_INPUT');
    expect((await rejection(c.saveProject({ kind: 'path', path: '/tmp/x.twp' }))).code).toBe('INVALID_INPUT');
  });

  it('opens a file named "tamper" read-only and refuses every change with READ_ONLY_PROJECT', async () => {
    const c = stubClient();
    const report = await c.awaitJob<ProjectOpenReport>(
      await c.openProject({ kind: 'path', path: 'C:\\work\\tampered.twp' }),
    );
    expect(report.readOnly).toBe(true);
    expect(report.checks.filter((x) => !x.ok)).toMatchObject([{ id: 'audit-chain', ruleId: 'TW-PRJ-002' }]);
    expect((await c.getProject()).readOnly).toBe(true);
    const issue = await issueOf(c, 'TW-DQ-005');
    const refused = [
      c.decide({ kind: 'comment_issue', issueId: issue.id, text: 'note' }),
      c.runChecks('d1'),
      c.importFile(CSV_FILE),
      c.applyStep('d1', { kind: 'select_columns', columnIds: ['c0'] }, 'Just the IDs.'),
      c.removeStep('d1', 's1', 'Remove it.'),
      c.exportData({ datasetId: 'd1', profile: 'csv' }),
      c.saveProject(),
    ];
    for (const p of refused) expect((await rejection(p)).code).toBe('READ_ONLY_PROJECT');
    await expect(c.listIssues({})).resolves.toMatchObject({ total: 3 });
  });

  it('fails a job whose project was replaced before it finished', async () => {
    const c = stubClient();
    const handle = await c.runChecks('d1');
    await c.newProject({ name: 'Fresh', profile: PROFILE });
    expect((await rejection(c.awaitJob(handle))).code).toBe('CANCELLED');
    expect((await c.getProject()).auditHead.seq).toBe(1);
  });
});
