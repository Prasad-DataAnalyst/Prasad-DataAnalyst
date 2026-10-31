/**
 * The native engine benchmark (SAD section 4.3, phase C): import, check and export one large CSV
 * through the engine process, as the desktop edition will, and record the time and the peak memory
 * of each stage. It runs only when given a file:
 *
 *   TW_BENCH_CSV=/data/well_daily.csv [TW_BENCH_WORKDIR=/data/work] [TW_BENCH_OUT=result.json] \
 *     [TW_BENCH_PROFILE=parquet|csv] [TW_BENCH_LOG=progress.log] npx vitest run tests/bench
 *
 * TW_BENCH_LOG names a file that gets a line as each stage starts and ends, for following a long run.
 * TW_BENCH_ENGINE_ARGS passes extra engine arguments, such as '--memory-limit 1073741824'.
 *
 * The engine uses its defaults: DuckDB may use half the machine's memory and spills the rest to disk.
 */
import { appendFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckSummary, DatasetSummary, ExportResult, JsonValue } from '@tw/model';
import { ENGINE_FACTORIES } from '../conformance/harness';
import { nativeBuilt, peakResidentBytes, startNative, stopNative } from '../conformance/native-process';

const CSV = process.env['TW_BENCH_CSV'];
const HOUR_MS = 3_600_000;

function progress(line: string): void {
  const log = process.env['TW_BENCH_LOG'];
  if (log !== undefined) appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
}

interface Stage {
  name: string;
  seconds: number;
  peakResidentBytes: number | null;
  detail: Record<string, JsonValue>;
}

describe.skipIf(CSV === undefined || !nativeBuilt)('native engine benchmark', () => {
  it(
    'imports, checks and exports the file',
    async () => {
      const path = CSV as string;
      const size = statSync(path).size;
      const reference = await (
        ENGINE_FACTORIES['tracewell-ts'] as () => Promise<import('@tw/engine-api').EngineClient>
      )();
      const engineArgs = (process.env['TW_BENCH_ENGINE_ARGS'] ?? '').split(' ').filter((a) => a !== '');
      const native = startNative(engineArgs, process.env['TW_BENCH_WORKDIR']);
      const stages: Stage[] = [];
      const timed = async <T>(name: string, run: () => Promise<T>, detail: (r: T) => Record<string, JsonValue>) => {
        progress(`${name}: started`);
        const started = performance.now();
        const result = await run().catch((e: unknown) => {
          progress(`${name}: failed: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        });
        const seconds = (performance.now() - started) / 1000;
        progress(`${name}: ${seconds.toFixed(1)} s`);
        stages.push({ name, seconds, peakResidentBytes: peakResidentBytes(native.child.pid), detail: detail(result) });
        console.log(`${name}: ${seconds.toFixed(1)} s`);
        return result;
      };
      try {
        const file = { kind: 'path' as const, path };
        const info = await native.client.hello();
        await native.client.newProject({ name: 'Benchmark', profile: { id: 'p1', name: 'Bench', role: 'Analyst' } });
        const preview = await timed(
          'preview',
          () => reference.sniff(file),
          (p) => ({ columns: p.columns.length }),
        );
        const ds = await timed(
          'import',
          async () => native.client.awaitJob<DatasetSummary>(await native.client.importFile(file, { preview })),
          (d) => ({ rows: d.rowCount, columns: d.columnCount }),
        );
        expect(ds.rowCount).toBeGreaterThan(0);
        await timed(
          'checks',
          async () => native.client.awaitJob<CheckSummary>(await native.client.runChecks(ds.id)),
          (c) => ({ issues: c.issues, byRule: c.byRule }),
        );
        const profile = (process.env['TW_BENCH_PROFILE'] ?? 'parquet') as 'csv' | 'parquet';
        const target = { kind: 'path' as const, path: join(native.workdir, `benchmark-${profile}.zip`) };
        const exported = await timed(
          'export',
          async () =>
            native.client.awaitJob<ExportResult>(await native.client.exportData({ datasetId: ds.id, profile, target })),
          (e) => ({ profile, ok: e.ok, packageBytes: e.size, checks: e.validation.checks.length }),
        );
        expect(exported.validation.checks.filter((c) => !c.ok)).toEqual([]);
        rmSync(target.path, { force: true });
        const result = {
          file: { path, bytes: size },
          engine: { name: info.name, version: info.version, memoryBudgetBytes: info.capabilities.memoryBudgetBytes },
          machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? '', memoryBytes: totalmem() },
          stages,
        };
        const out = process.env['TW_BENCH_OUT'];
        if (out !== undefined) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        stopNative(native);
        reference.close();
      }
    },
    4 * HOUR_MS,
  );
});
