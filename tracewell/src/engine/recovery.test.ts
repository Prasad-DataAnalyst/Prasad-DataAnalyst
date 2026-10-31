/** Crash recovery (FR-PRJ-03): a session that ends without saving can be rebuilt by the next one. */
import { describe, expect, it } from 'vitest';
import type { ProjectOpenReport, SaveResult } from '@tw/model';
import { awaitJob, checked, columnId, newEngine, withProject } from './__fixtures__/session';
import { MemoryJournalDisk } from './journal-store';
import type { LocalEngine } from './engine';

/** A session that imported, checked and edited a file, then ended without saving. */
async function crashedSession(disk: MemoryJournalDisk): Promise<LocalEngine> {
  const engine = await withProject(newEngine({ journal: disk.store('a') }));
  const ds = await checked(engine, 'csv_null_markers.csv');
  await engine.decide({
    kind: 'edit_cell',
    datasetId: ds.id,
    rowId: 1,
    columnId: await columnId(engine, ds.id, 'Pressure'),
    value: { text: '1511.0' },
    reason: 'Field sheet gives 1511.0',
  });
  await engine.journalIdle();
  disk.end('a');
  return engine;
}

describe('crash recovery', () => {
  it('rebuilds the unsaved project exactly, then journals it as the new session', async () => {
    const disk = new MemoryJournalDisk();
    const lost = await crashedSession(disk);
    const engine = newEngine({ journal: disk.store('b') });

    const info = await engine.recoveryInfo();
    const audit = (await lost.listAudit({ limit: 1000 })).items;
    // Every entry but the project's creation is unsaved work.
    expect(info).toMatchObject({ name: 'Engine test', entries: audit.length, unsaved: audit.length - 1 });

    const report = await awaitJob<ProjectOpenReport>(engine, await engine.recoverProject());
    expect(report.readOnly).toBe(false);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect((await engine.listAudit({ limit: 1000 })).items).toEqual(audit);
    const ds = report.project.datasets[0]?.id as string;
    expect(await engine.getRows({ datasetId: ds, stage: 'working', offset: 0, limit: 50 })).toEqual(
      await lost.getRows({ datasetId: ds, stage: 'working', offset: 0, limit: 50 }),
    );
    expect((await engine.listIssues({ limit: 500 })).items).toEqual((await lost.listIssues({ limit: 500 })).items);

    await engine.journalIdle();
    expect([...disk.journals.keys()]).toEqual(['b']);
    expect(await engine.recoveryInfo()).toBeNull();
  });

  it('offers nothing when the work was saved, and forgets that journal', async () => {
    const disk = new MemoryJournalDisk();
    const engine = await withProject(newEngine({ journal: disk.store('a') }));
    await checked(engine, 'csv_null_markers.csv');
    await awaitJob<SaveResult>(engine, await engine.saveProject());
    await engine.journalIdle();
    disk.end('a');
    expect(await newEngine({ journal: disk.store('b') }).recoveryInfo()).toBeNull();
    expect(disk.journals.has('a')).toBe(false);
  });

  it('offers nothing for a project that was only created', async () => {
    const disk = new MemoryJournalDisk();
    const engine = await withProject(newEngine({ journal: disk.store('a') }));
    await engine.journalIdle();
    disk.end('a');
    expect(await newEngine({ journal: disk.store('b') }).recoveryInfo()).toBeNull();
  });

  it('never offers the journal of a session that is still running', async () => {
    const disk = new MemoryJournalDisk();
    const running = await withProject(newEngine({ journal: disk.store('a') }));
    await checked(running, 'csv_null_markers.csv');
    await running.journalIdle();
    expect(await newEngine({ journal: disk.store('b') }).recoveryInfo()).toBeNull();
    expect(disk.journals.has('a')).toBe(true);
  });

  it('discards on request', async () => {
    const disk = new MemoryJournalDisk();
    await crashedSession(disk);
    const engine = newEngine({ journal: disk.store('b') });
    expect(await engine.recoveryInfo()).not.toBeNull();
    await engine.discardRecovery();
    expect(await engine.recoveryInfo()).toBeNull();
    await expect(engine.recoverProject().then((h) => awaitJob(engine, h))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('opens a journal whose original no longer matches its SHA-256 read-only', async () => {
    const disk = new MemoryJournalDisk();
    await crashedSession(disk);
    const journal = disk.journals.get('a');
    const original = journal?.originals[0];
    if (original === undefined) throw new Error('no original journalled');
    original.bytes = original.bytes.slice(1);
    const engine = newEngine({ journal: disk.store('b') });
    const report = await awaitJob<ProjectOpenReport>(engine, await engine.recoverProject());
    expect(report.readOnly).toBe(true);
    expect(report.checks.find((c) => c.id === 'original-checksum')).toMatchObject({ ok: false, ruleId: 'TW-PRJ-001' });
  });
});
