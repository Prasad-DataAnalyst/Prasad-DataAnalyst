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
 * TW_BENCH_SAVE names a .twp file: the project is then saved there and opened by a second engine
 * process from it. The first engine's working folder is emptied before the open, so a 10 GB run
 * stays within the disk it needs; the folder must not hold anything else.
 *
 * The engine uses its defaults: DuckDB may use half the machine's memory and spills the rest to disk.
 */
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckSummary, DatasetSummary, ExportResult, JsonValue, ProjectOpenReport, SaveResult } from '@tw/model';
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
      // The engine the stages run in: the second one once the saved project is opened.
      let current = native;
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
        stages.push({ name, seconds, peakResidentBytes: peakResidentBytes(current.child.pid), detail: detail(result) });
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
        const twp = process.env['TW_BENCH_SAVE'];
        if (twp !== undefined) {
          await timed(
            'save',
            async () =>
              native.client.awaitJob<SaveResult>(await native.client.saveProject({ kind: 'path', path: twp })),
            (s) => ({ projectBytes: s.size }),
          );
          stopNative(native);
          rmSync(native.workdir, { recursive: true, force: true });
          mkdirSync(native.workdir, { recursive: true });
          current = startNative(engineArgs, native.workdir);
          const opened = await timed(
            'open',
            async () =>
              current.client.awaitJob<ProjectOpenReport>(await current.client.openProject({ kind: 'path', path: twp })),
            (r) => ({
              readOnly: r.readOnly,
              failedChecks: r.checks.filter((c) => !c.ok).length,
              replay: r.checks.find((c) => c.id === 'replay-digest')?.detail ?? '',
            }),
          );
          expect(opened.readOnly).toBe(false);
        }
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
        if (current !== native) stopNative(current);
        reference.close();
      }
    },
    4 * HOUR_MS,
  );
});
