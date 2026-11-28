/**
 * Local profiles with roles, Reviewer mode and sign-off stamps (FR-AUD-03, FR-AUD-04, SAD decision
 * D-18), and issue assignment (FR-VAL-04), through the engine protocol on every engine.
 */
import { expect } from 'vitest';
import { readZip } from '@tw/io';
import type { Decision, ExportResult, Issue, ProjectOpenReport, SaveResult, UserProfile } from '@tw/model';
import { defineConformance, importFixture, newProject, PROFILE, runChecks } from './harness';

const JANE: UserProfile = { id: 'u_jane', name: 'Jane', role: 'Reviewer' };
const SAM: UserProfile = { id: 'u_sam', name: 'Sam', role: 'Viewer' };

/** The refusal a call gives, or a note that it gave none. */
async function refusal(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'no refusal',
    (e: { code: string; message: string; fix: string }) => ({ code: e.code, message: e.message, fix: e.fix }),
  );
}

defineConformance(
  'review: a Reviewer comments, assigns and signs off, and is refused everything else',
  async (engine) => {
    await newProject(engine);
    const ds = await importFixture(engine, 'csv_well_daily_golden.csv');
    const issues = await runChecks(engine, ds.id);
    const issue = issues[0] as Issue;
    const column = (await engine.getSchema(ds.id)).columns.find((c) => c.name === 'Pressure')?.id ?? '';
    expect((await engine.getProject()).user).toEqual(PROFILE);

    await engine.setProfile({ ...JANE, name: '  Jane ' });
    expect((await engine.getProject()).user).toEqual(JANE);
    const refused = (what: string, fix = `Switch to an Analyst profile to ${what}.`) => ({
      code: 'ROLE_NOT_ALLOWED',
      message: `Jane is working as a Reviewer, who cannot ${what}.`,
      fix,
    });
    const edit: Decision = {
      kind: 'edit_cell',
      datasetId: ds.id,
      rowId: 0,
      columnId: column,
      value: { text: '1860.5' },
      reason: 'Re-read',
    };
    expect(await refusal(engine.decide(edit))).toEqual(refused('edit cells'));
    expect(await refusal(engine.runChecks(ds.id))).toEqual(refused('run checks'));
    expect(await refusal(engine.exportData({ datasetId: ds.id, profile: 'csv' }))).toEqual(refused('export data'));
    expect(await refusal(engine.importFile({ kind: 'bytes', bytes: new Uint8Array([97]), name: 'x.csv' }))).toEqual(
      refused('import files'),
    );
    expect(
      await refusal(engine.installRulePack({ kind: 'bytes', bytes: new Uint8Array(), name: 'p.twrules' }, 'Policy')),
    ).toEqual(refused('install rule-packs'));
    expect(
      await refusal(engine.decide({ kind: 'set_project_area', bbox: [0, 50, 2, 52], reason: 'North Sea' })),
    ).toEqual(refused('set the project area'));
    expect(await refusal(engine.decide({ kind: 'revert', seq: 1, reason: 'Undo' }))).toEqual(refused('revert changes'));
    expect(await refusal(engine.newProject({ name: 'Mine', profile: JANE }))).toEqual(refused('create projects'));

    // A comment and an assignment are recorded as Jane's.
    const [comment] = await engine.decide({ kind: 'comment_issue', issueId: issue.id, text: 'Please confirm.' });
    expect(comment?.actor).toEqual({ kind: 'user', profileId: 'u_jane', name: 'Jane', role: 'Reviewer' });
    const assign = (assignee: unknown, reason = 'Owns the logger') =>
      engine.decide({ kind: 'assign_issue', issueId: issue.id, assignee, reason } as Decision);
    const [assigned] = await assign(' Prasad ');
    expect(assigned).toMatchObject({
      action: 'issue.assign',
      old: null,
      new: 'Prasad',
      target: { datasetId: ds.id, issueId: issue.id },
    });
    const listed = (await engine.listIssues({ datasetId: ds.id, limit: 1000 })).items.find((i) => i.id === issue.id);
    expect(listed?.assignee).toBe('Prasad');
    expect(await refusal(assign('Prasad'))).toMatchObject({ message: 'The issue is already assigned to Prasad.' });
    expect(await refusal(assign(''))).toMatchObject({
      message: 'An assignee is a name of 1 to 100 characters, or no one.',
    });
    expect(await refusal(assign('x'.repeat(101)))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await refusal(assign(7))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await refusal(assign('Sam', ' '))).toMatchObject({ code: 'REASON_REQUIRED' });
    await assign(null, 'Not his');
    expect(await refusal(assign(null))).toMatchObject({ message: 'The issue is not assigned to anyone.' });
    await assign('Sam');

    // The sign-off stamps the dataset as it stands.
    const signOff = (status: unknown, reason = 'Checked against the field sheets') =>
      engine.decide({ kind: 'sign_off', datasetId: ds.id, status, reason } as Decision);
    expect(await refusal(signOff('done'))).toEqual({
      code: 'INVALID_INPUT',
      message: 'The sign-off status "done" is not "approved" or "changes_requested".',
      fix: 'Approve the dataset, or request changes.',
    });
    const [stamp] = await signOff('approved');
    expect(stamp).toMatchObject({ action: 'dataset.signoff', old: null, new: { status: 'approved' } });
    const [first] = (await engine.getProject()).datasets[0]?.signOffs ?? [];
    expect(first).toEqual({
      seq: stamp?.seq,
      at: stamp?.at,
      by: { profileId: 'u_jane', name: 'Jane', role: 'Reviewer' },
      status: 'approved',
      statement: 'Checked against the field sheets',
      changedSeq: null,
    });
    const saved = await engine.awaitJob<SaveResult>(await engine.saveProject());
    const manifest = JSON.parse(readZip(saved.bytes as Uint8Array).readText('manifest.json')) as { savedBy: string };
    expect(manifest.savedBy).toBe('Jane');

    // A Viewer only reads.
    await engine.setProfile(SAM);
    expect(await refusal(engine.decide({ kind: 'comment_issue', issueId: issue.id, text: 'Hi' }))).toEqual({
      code: 'ROLE_NOT_ALLOWED',
      message: 'Sam is working as a Viewer, who cannot comment on issues.',
      fix: 'Switch to an Analyst or Reviewer profile to comment on issues.',
    });
    expect(await refusal(signOff('approved'))).toMatchObject({
      fix: 'Switch to a Reviewer profile to sign off datasets.',
    });
    expect(await refusal(engine.saveProject())).toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
    expect((await engine.listIssues({ datasetId: ds.id, limit: 1 })).total).toBeGreaterThan(0);

    // The analyst may not sign off their own work, and a change of theirs supersedes the stamp.
    await engine.setProfile(PROFILE);
    expect(await refusal(signOff('approved'))).toEqual({
      code: 'ROLE_NOT_ALLOWED',
      message: 'Prasad is working as an Analyst, who cannot sign off datasets.',
      fix: 'Switch to a Reviewer profile to sign off datasets.',
    });
    const [edited] = await engine.decide(edit);
    const [after] = (await engine.getProject()).datasets[0]?.signOffs ?? [];
    expect(after?.changedSeq).toBe(edited?.seq);
    const other = await importFixture(engine, 'csv_null_markers.csv');
    await engine.setProfile(JANE);
    expect(
      await refusal(engine.decide({ kind: 'sign_off', datasetId: other.id, status: 'approved', reason: 'Fine' })),
    ).toEqual({
      code: 'INVALID_INPUT',
      message: `${other.name} has not been checked, so it cannot be signed off.`,
      fix: 'Ask the analyst to run the checks first.',
    });
    const [again] = await signOff('changes_requested', 'The edit needs a source');
    expect(again).toMatchObject({ old: 'approved', new: { status: 'changes_requested' } });
  },
);

defineConformance(
  'review: an export states the latest sign-off, and a reopened project keeps every stamp',
  async (engine, fresh) => {
    await newProject(engine);
    const ds = await importFixture(engine, 'csv_well_daily_golden.csv');
    const [issue] = await runChecks(engine, ds.id);
    await engine.setProfile(JANE);
    await engine.decide({ kind: 'assign_issue', issueId: issue?.id ?? '', assignee: 'Prasad', reason: 'Owns it' });
    const [stamp] = await engine.decide({
      kind: 'sign_off',
      datasetId: ds.id,
      status: 'approved',
      reason: 'Looks right',
    });
    await engine.setProfile(PROFILE);
    const r = await engine.awaitJob<ExportResult>(await engine.exportData({ datasetId: ds.id, profile: 'csv' }));
    const signOff = {
      seq: stamp?.seq,
      at: stamp?.at,
      by: { profileId: 'u_jane', name: 'Jane', role: 'Reviewer' },
      status: 'approved',
      statement: 'Looks right',
      changedSeq: null,
    };
    expect(r.manifest.signOff).toEqual(signOff);
    const readme = readZip(r.bytes as Uint8Array).readText('README.txt');
    expect(readme).toContain(
      `SIGN-OFF: approved by Jane (Reviewer) at ${stamp?.at}, entry ${stamp?.seq}; the dataset has not changed since`,
    );
    const saved = await engine.awaitJob<SaveResult>(await engine.saveProject());
    const other = await fresh();
    try {
      const report = await other.awaitJob<ProjectOpenReport>(
        await other.openProject({ kind: 'bytes', bytes: saved.bytes as Uint8Array, name: saved.fileName }),
      );
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect((await other.getProject()).datasets[0]?.signOffs).toEqual([signOff]);
      const issues = (await other.listIssues({ datasetId: ds.id, limit: 1000 })).items;
      expect(issues.find((i) => i.id === issue?.id)?.assignee).toBe('Prasad');
      // Without a profile set, the opener works as the project's creator, as before roles.
      expect((await other.getProject()).user).toEqual(PROFILE);
    } finally {
      other.close();
    }
  },
);
