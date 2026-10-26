/** Shared set-up for the engine tests: a deterministic engine, fixture imports and job waiting. */
import { fixtureBytes, type FixtureName } from '@tw/fixtures';
import type { EngineEvent } from '@tw/engine-api';
import type { DatasetSummary, Issue, JobHandle, ProjectOpenReport, SaveResult, UserProfile } from '@tw/model';
import { LocalEngine, type LocalEngineOptions } from '../engine';
import { fixedClock, seededIds } from '../testing';

export const START = '2026-10-19T08:00:00.000Z';
export const PROFILE: UserProfile = { id: 'u_prasad', name: 'Prasad', role: 'Analyst' };

export function newEngine(o: Partial<LocalEngineOptions> = {}): LocalEngine {
  return new LocalEngine({
    appVersion: '0.1.0',
    owner: 'Prasad',
    clock: fixedClock(START),
    ids: seededIds(1),
    memoryBudgetBytes: 256 * 1024 ** 2,
    ...o,
  });
}

/** The job's result once it is done; rejects with the job's error when it fails or is cancelled. */
export async function awaitJob<T>(engine: LocalEngine, handle: JobHandle): Promise<T> {
  await new Promise<void>((resolve) => {
    const ended = new Set(['job.done', 'job.failed', 'job.cancelled']);
    const off = engine.on((e: EngineEvent) => {
      if ('jobId' in e && e.jobId === handle.jobId && ended.has(e.type)) {
        off();
        resolve();
      }
    });
    void engine.jobOutcome(handle.jobId).then((o) => {
      if (o.state !== 'running') {
        off();
        resolve();
      }
    });
  });
  const outcome = await engine.jobOutcome(handle.jobId);
  if (outcome.state === 'done') return outcome.result as T;
  if (outcome.state === 'failed') throw Object.assign(new Error(outcome.error.message), outcome.error);
  throw Object.assign(new Error(`job ${handle.jobId} ${outcome.state}`), { code: outcome.state.toUpperCase() });
}

export async function withProject(engine: LocalEngine = newEngine()): Promise<LocalEngine> {
  await engine.newProject({ name: 'Engine test', profile: PROFILE });
  return engine;
}

export async function importFixture(engine: LocalEngine, name: FixtureName): Promise<DatasetSummary> {
  return awaitJob<DatasetSummary>(engine, await engine.importFile({ kind: 'bytes', bytes: fixtureBytes(name), name }));
}

export async function checked(engine: LocalEngine, name: FixtureName): Promise<DatasetSummary> {
  const ds = await importFixture(engine, name);
  await awaitJob(engine, await engine.runChecks(ds.id));
  return ds;
}

export async function issuesOf(engine: LocalEngine, datasetId: string): Promise<Issue[]> {
  return (await engine.listIssues({ datasetId, limit: 1000 })).items;
}

export async function issueOf(
  engine: LocalEngine,
  datasetId: string,
  ruleId: string,
  columnName?: string,
): Promise<Issue> {
  const schema = await engine.getSchema(datasetId);
  const column = columnName === undefined ? undefined : schema.columns.find((c) => c.name === columnName)?.id;
  const found = (await issuesOf(engine, datasetId)).find(
    (i) => i.ruleId === ruleId && (column === undefined || i.columns.includes(column)),
  );
  if (found === undefined) throw new Error(`no ${ruleId} issue${columnName === undefined ? '' : ` on ${columnName}`}`);
  return found;
}

export async function columnId(engine: LocalEngine, datasetId: string, name: string): Promise<string> {
  const c = (await engine.getSchema(datasetId)).columns.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no column ${name}`);
  return c.id;
}

/** A checked dataset with one edit and one conversion, saved; the bytes are the `.twp` file. */
export async function savedProject(): Promise<{ engine: LocalEngine; datasetId: string; bytes: Uint8Array }> {
  const engine = await withProject();
  const ds = await checked(engine, 'csv_null_markers.csv');
  const pressure = await columnId(engine, ds.id, 'Pressure');
  await engine.decide({
    kind: 'edit_cell',
    datasetId: ds.id,
    rowId: 1,
    columnId: pressure,
    value: { text: '1511.0' },
    reason: 'Field sheet gives 1511.0',
  });
  await awaitJob(
    engine,
    await engine.applyStep(
      ds.id,
      { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'replace' },
      'Report in kPa',
    ),
  );
  const saved = await awaitJob<SaveResult>(engine, await engine.saveProject());
  if (saved.bytes === undefined) throw new Error('save returned no bytes');
  return { engine, datasetId: ds.id, bytes: saved.bytes };
}

export async function open(
  bytes: Uint8Array,
  engine: LocalEngine = newEngine(),
): Promise<{ engine: LocalEngine; report: ProjectOpenReport }> {
  const report = await awaitJob<ProjectOpenReport>(
    engine,
    await engine.openProject({ kind: 'bytes', bytes, name: 'project.twp' }),
  );
  return { engine, report };
}
