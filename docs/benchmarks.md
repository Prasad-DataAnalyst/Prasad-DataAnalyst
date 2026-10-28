# Tracewell benchmarks

This page records measured performance of the native engine (SAD section 4.3, phase C). Every figure
comes from a run of `tests/bench/native-bench.test.ts`, which drives the engine process over its
stdio protocol exactly as the desktop edition will. The figures are measurements, not targets.

## 10 GB CSV: import, check and export (2026-10-28)

### Set-up

| Item         | Value                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Machine      | Cloud container, 4 vCPU Intel Xeon @ 2.80 GHz, 15.7 GiB RAM, Linux 6.18, virtual disk                                         |
| Engine       | `tracewell-native` 0.1.0 (Rust 1.97, DuckDB 1.5 bundled), release build, commit `6b0821f`                                     |
| Settings     | Engine defaults: DuckDB `memory_limit` 50 % of RAM (7.86 GiB), all 4 threads, spill folder inside the working folder         |
| Input        | `well_daily_124m.csv`: 124,000,000 rows, 10 columns, 10,037,203,593 bytes (9.35 GiB), UTF-8, comma-separated                 |
| Input source | `node fixtures/generators/gen-large-csv.mjs --rows 124000000 --seed 42` (seeded, byte-identical on every run; 6 min 12 s)    |
| Workflow     | Preview → import → run checks (`tracewell.generic-dq` and the import-note rules) → export with the Parquet profile           |

The columns are a daily well report: well ID, date and time, latitude, longitude, pressure (psia),
temperature (degF), oil, gas and water rates, and water cut. Rows run date by date over 500 wells.

### Results

| Stage     | Time        | Engine peak memory (RSS) | Result                                                                                                        |
| --------- | ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Preview   | 0.2 s       | under 0.1 GiB            | 10 columns planned from the first MiB                                                                         |
| Import    | 160.5 s     | 5.03 GiB                 | 124,000,000 rows; 62.5 MB/s, 773,000 rows/s; working Parquet file 1.40 GiB (15 % of the CSV)                  |
| Checks    | 374.4 s     | 10.70 GiB                | 11 issues: 6 spike (`TW-TIME-007`), 3 flatline (`TW-TIME-006`), time zone not given, detections assumed       |
| Export    | 487.9 s     | 3.34 GiB                 | Parquet package of 1.24 GiB; all 12 read-back checks passed, including the SHA-256 of every column's values   |
| **Total** | **17.1 min** |                          |                                                                                                               |

Peak memory is the engine process's resident set: the import and checks figures are its own
high-water mark, and the export figure is the highest value sampled every 5 s during that stage.
The working folder peaked at 10.95 GiB of disk (the staging database during import, then DuckDB's
spill files during checks), 1.1 times the size of the CSV.

### Against the requirements

- **NFR-03 (import and convert a 10 GB CSV in minutes, not hours): met.** The import takes 2.7
  minutes and the whole workflow 17 minutes on four cores. This run sets the target the
  requirement asks for: **import of 10 GB within 5 minutes, and import, check and export within
  30 minutes, on a 4-core machine with 16 GB of RAM.**
- **NFR-04 (memory never exceeds a configurable limit, default 50 % of RAM; spills to disk
  instead of failing): partly met.** Nothing failed, and DuckDB spilled to disk as designed.
  The import (5.03 GiB) and the export (3.34 GiB) stayed under the 7.86 GiB limit. During checks
  the engine process reached 10.70 GiB, 63 % of RAM: DuckDB's limit governs its buffer pool, not
  every allocation in the process. The next step is to give DuckDB a share of the budget rather
  than all of it, measure again, and only then call NFR-04 met.
- **NFR-11 (disk at most 3× the data size): met.** Peak working-folder use was 1.1× the CSV.

### What changed to get here

An earlier run of the same file was stopped by the operating system's out-of-memory killer during
checks (13.7 GB resident). The engine read query results through the DuckDB driver's materialised
results, which hold a whole result in the engine's own memory, outside DuckDB's limit. Every large
scan now streams batch by batch (row-set queries, the series checks, failed-value examples, the
unit-consistency check, export digests, CSV writing and Parquet read-back), so the engine's own
memory no longer grows with the data.

### Reproduce

```sh
cd tracewell
npm ci
npm run build:native
node fixtures/generators/gen-large-csv.mjs --rows 124000000 --seed 42 --out /data/well_daily_124m.csv
TW_BENCH_CSV=/data/well_daily_124m.csv TW_BENCH_WORKDIR=/data/work TW_BENCH_PROFILE=parquet \
  TW_BENCH_OUT=/data/result.json TW_BENCH_LOG=/data/progress.log npx vitest run tests/bench
```

The working folder needs about 11 GB of free disk for a 10 GB CSV. `TW_BENCH_LOG` gets a line as
each stage starts and ends; `TW_BENCH_OUT` gets the figures as JSON. `TW_BENCH_PROFILE=csv`
measures the CSV export instead.

## 1,000,000 rows (84 MB)

The same workflow and machine, with `--rows 1000000`:

| Stage                | Time  |
| -------------------- | ----- |
| Preview              | 0.4 s |
| Import               | 1.7 s |
| Checks               | 1.9 s |
| Export, Parquet      | 4.2 s |
| Export, CSV          | 8.0 s |

From 1 million to 124 million rows the import time grows 94-fold, the export 116-fold and the
checks 197-fold. Checks grow faster than the data because the duplicate and series checks sort or
hash the whole table, which spills to disk once it no longer fits in memory.
