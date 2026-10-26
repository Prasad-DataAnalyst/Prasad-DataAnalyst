/**
 * The conformance harness: acceptance scenarios written only against the engine protocol, run on
 * every engine registered here. Today that is the TypeScript engine in-process; a native engine
 * joins by adding a factory, and must pass the same files unchanged.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { EngineClient, inProcessTransport } from '@tw/engine-api';
import { LocalEngine, fixedClock, seededIds } from '@tw/engine';
import { fixturePath, type FixtureName } from '@tw/fixtures';
import { nodeFs } from '@tw/io/node';
import type { DatasetSummary, ImportRequestOptions, Issue, JsonValue } from '@tw/model';

export type EngineFactory = () => Promise<EngineClient>;

export const START = '2026-10-19T08:00:00.000Z';

export const ENGINE_FACTORIES: Record<string, EngineFactory> = {
  'tracewell-ts': async () =>
    new EngineClient(
      inProcessTransport(
        new LocalEngine({
          appVersion: '0.1.0',
          owner: 'Prasad',
          clock: fixedClock(START),
          ids: seededIds(1),
          fs: nodeFs(),
        }),
      ),
    ),
};

export const PROFILE = { id: 'u_prasad', name: 'Prasad', role: 'Analyst' } as const;

/** Registers the scenario once per engine. */
export function defineConformance(
  name: string,
  scenario: (engine: EngineClient) => Promise<void>,
  timeout = 60_000,
): void {
  for (const [engineName, factory] of Object.entries(ENGINE_FACTORIES)) {
    describe(engineName, () => {
      it(
        name,
        async () => {
          const engine = await factory();
          try {
            await scenario(engine);
          } finally {
            engine.close();
          }
        },
        timeout,
      );
    });
  }
}

export async function newProject(engine: EngineClient, name = 'Conformance'): Promise<void> {
  await engine.newProject({ name, profile: { ...PROFILE } });
}

export async function importFixture(
  engine: EngineClient,
  name: FixtureName,
  o?: ImportRequestOptions,
): Promise<DatasetSummary> {
  return engine.awaitJob<DatasetSummary>(await engine.importFile({ kind: 'path', path: fixturePath(name) }, o));
}

export async function runChecks(engine: EngineClient, datasetId: string): Promise<Issue[]> {
  await engine.awaitJob(await engine.runChecks(datasetId));
  return (await engine.listIssues({ datasetId, limit: 1000 })).items;
}

/** Flagged occurrences per rule: rows for row-scope issues, one for column and dataset issues. */
export function ruleCounts(issues: Issue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.ruleId] = (counts[i.ruleId] ?? 0) + (i.scope === 'rows' ? i.counts.flagged : 1);
  return counts;
}

const EXPECTED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'expected');

/**
 * A committed cross-engine expectation. TW_WRITE_EXPECTED=1 writes it from this run instead, for
 * when an expectation is created or deliberately changed; the diff is then reviewed like code.
 */
export function expected(file: string, actual: string): string {
  const path = join(EXPECTED_DIR, file);
  if (process.env['TW_WRITE_EXPECTED'] === '1') writeFileSync(path, actual);
  if (!existsSync(path))
    throw new Error(`${file} is missing; run with TW_WRITE_EXPECTED=1 to create it, then review it.`);
  return readFileSync(path, 'utf8');
}

export function expectedJson(file: string, actual: JsonValue): JsonValue {
  return JSON.parse(expected(file, `${JSON.stringify(actual, null, 2)}\n`)) as JsonValue;
}
