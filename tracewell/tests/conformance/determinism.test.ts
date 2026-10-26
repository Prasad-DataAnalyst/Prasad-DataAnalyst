/** The same session on two fresh engines gives byte-identical export packages and project files. */
import { expect } from 'vitest';
import type { EngineClient } from '@tw/engine-api';
import type { ExportResult, SaveResult } from '@tw/model';
import { ENGINE_FACTORIES, defineConformance, importFixture, newProject, runChecks } from './harness';

async function session(engine: EngineClient): Promise<string[]> {
  await newProject(engine, 'Determinism');
  const ds = await importFixture(engine, 'csv_timeseries_gaps_dups_flatline_spike.csv');
  await runChecks(engine, ds.id);
  const digests: string[] = [];
  for (const profile of ['excel', 'csv'] as const) {
    const r = await engine.awaitJob<ExportResult>(await engine.exportData({ datasetId: ds.id, profile }));
    digests.push(`${profile}:${r.packageSha256 ?? 'none'}`);
  }
  const saved = await engine.awaitJob<SaveResult>(await engine.saveProject());
  digests.push(`twp:${saved.sha256}`);
  return digests;
}

defineConformance('determinism: two fresh engines produce identical bytes', async (engine) => {
  const first = await session(engine);
  const other = await (Object.values(ENGINE_FACTORIES)[0] as () => Promise<EngineClient>)();
  try {
    expect(await session(other)).toEqual(first);
  } finally {
    other.close();
  }
  expect(first.every((d) => !d.endsWith(':none'))).toBe(true);
});
