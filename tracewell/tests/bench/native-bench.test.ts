/**
 * The native engine benchmark (SAD section 4.3, phase C): import, check and export one large CSV
 * through the engine process, as the desktop edition will, and record the time and the peak memory
 * of each stage. It runs only when given a file:
 *
 *   TW_BENCH_CSV=/data/well_daily.csv [TW_BENCH_WORKDIR=/data/work] [TW_BENCH_OUT=result.json] \
 *     npx vitest run tests/bench
 *
 * The engine uses its defaults: DuckDB may use half the machine's memory and spills the rest to disk.
 */
import { statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CheckSummary, DatasetSummary, JsonValue } from '@tw/model';
import { ENGINE_FACTORIES } from '../conformance/harness';
import { nativeBuilt, peakResidentBytes, startNative, stopNative } from '../conformance/native-process';

const CSV = process.env['TW_BENCH_CSV'];
const HOUR_MS = 3_600_000;

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
      const native = startNative([], process.env['TW_BENCH_WORKDIR']);
      const stages: Stage[] = [];
      const timed = async <T>(name: string, run: () => Promise<T>, detail: (r: T) => Record<string, JsonValue>) => {
        const started = performance.now();
        const result = await run();
        const seconds = (performance.now() - started) / 1000;
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
