# Tracewell benchmarks

This page records measured performance of the native engine (SAD section 4.3, phase C). Every figure
comes from a run of `tests/bench/native-bench.test.ts`, which drives the engine process over its
stdio protocol exactly as the desktop edition will. The figures are measurements, not targets.

## 10 GB CSV: import, check and export

### Set-up

| Item         | Value                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Machine      | Cloud container, 4 vCPU Intel Xeon @ 2.80 GHz, 15.7 GiB RAM, Linux 6.18, virtual disk                                       |
| Engine       | `tracewell-native` 0.1.0 (Rust 1.97, DuckDB 1.5 bundled), release build, commit `0df7f59`                                   |
| Settings     | Engine defaults: a memory budget of 50 % of RAM (7.86 GiB) for the whole process, all 4 threads, spill folder inside the working folder |
| Input        | `well_daily_124m.csv`: 124,000,000 rows, 10 columns, 10,037,203,593 bytes (9.35 GiB), UTF-8, comma-separated               |
| Input source | `node fixtures/generators/gen-large-csv.mjs --rows 124000000 --seed 42` (seeded, byte-identical on every run; 6 min 12 s)  |
| Workflow     | Preview → import → run checks (`tracewell.generic-dq` and the import-note rules) → export with the Parquet profile         |

The columns are a daily well report: well ID, date and time, latitude, longitude, pressure (psia),
temperature (degF), oil, gas and water rates, and water cut. Rows run date by date over 500 wells.

### Results (2026-10-28)

| Stage     | Time         | Engine peak memory (RSS) | Result                                                                                                      |
| --------- | ------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Preview   | 0.2 s        | 0.14 GiB                 | 10 columns planned from the first MiB                                                                       |
| Import    | 153.7 s      | 4.15 GiB                 | 124,000,000 rows; 65 MB/s, 807,000 rows/s; working Parquet file 1.40 GiB (15 % of the CSV)                  |
| Checks    | 383.7 s      | 7.19 GiB                 | 11 issues: 6 spike (`TW-TIME-007`), 3 flatline (`TW-TIME-006`), time zone not given, detections assumed     |
| Export    | 319.0 s      | 2.62 GiB                 | Parquet package of 1.24 GiB; all 12 read-back checks passed, including the SHA-256 of every column's values |
| **Total** | **14.3 min** | **7.19 GiB**             |                                                                                                             |

Peak memory is the engine process's resident set, sampled every second, the highest value in each
stage. The working folder peaked at about 11 GiB of disk (the staging database during import, then
DuckDB's spill files during checks), 1.1 times the size of the CSV.

### Against the requirements

- **NFR-03 (import and convert a 10 GB CSV in minutes, not hours): met.** The import takes 2.6
  minutes and the whole workflow 14 minutes on four cores. This run sets the target the
  requirement asks for: **import of 10 GB within 5 minutes, and import, check and export within
  30 minutes, on a 4-core machine with 16 GB of RAM.**
- **NFR-04 (memory never exceeds a configurable limit, default 50 % of RAM; spills to disk
  instead of failing): met.** The process peaked at 7.19 GiB against its 7.86 GiB budget, and
  DuckDB spilled to disk as designed.
- **NFR-11 (disk at most 3× the data size): met.** Peak working-folder use was 1.1× the CSV.

### History of this run

| Run          | Engine change                                   | Import  | Checks  | Export  | Peak memory           |
| ------------ | ----------------------------------------------- | ------- | ------- | ------- | --------------------- |
| 1            | Query results read whole                        | 2 min   | killed  | -       | 13.7 GB, out of memory |
| 2 (`6b0821f`) | Every large scan streamed                       | 160.5 s | 374.4 s | 487.9 s | 10.70 GiB             |
| 3 (`0df7f59`) | Whole-process budget; digests from a shared queue | 153.7 s | 383.7 s | 319.0 s | 7.19 GiB              |

- **Run 1** was stopped by the operating system's out-of-memory killer during checks. The engine
  read query results through the DuckDB driver's materialised results, which hold a whole result
  in the engine's own memory, outside DuckDB's limit. Every large scan now streams batch by batch
  (row-set queries, the series checks, failed-value examples, the unit-consistency check, export
  digests, CSV writing and Parquet read-back).
- **Run 2** finished, but the checks stage reached 10.70 GiB against the 7.86 GiB limit: DuckDB's
  limit governs its buffer pool, not everything the process holds.
- **Run 3** gives DuckDB the budget less a reserve and limits the C allocator to two arenas (see
  below). Export digests are handed to threads one column at a time instead of in a fixed pattern,
  which cut the export by a third.

### How the memory budget was set

DuckDB's limit is not the process's. Besides DuckDB's buffer pool, the process holds the program
and its thread stacks, query state outside the pool, Arrow batches in flight between threads, and
the C allocator's free lists. These runs used a 20-million-row file (1.6 GB) under a 1 GiB budget,
so each took minutes:

| Configuration                                     | Import  | Checks  | Export  | Peak: import | Peak: checks | Peak: export |
| ------------------------------------------------- | ------- | ------- | ------- | ------------ | ------------ | ------------ |
| DuckDB limit = budget, allocator defaults         | 22.9 s  | 51.1 s  | 52.1 s  | 1.54 GiB     | 1.75 GiB     | 1.24 GiB     |
| … and 4 allocator arenas                          | 22.1 s  | 50.4 s  | 53.7 s  | 1.32 GiB     | 1.48 GiB     | 1.29 GiB     |
| … and 2 allocator arenas                          | 22.9 s  | 52.7 s  | 56.7 s  | 1.09 GiB     | 1.28 GiB     | 1.08 GiB     |
| 2 arenas, DuckDB 75 % of the budget               | 22.5 s  | 53.9 s  | 56.2 s  | 0.94 GiB     | 1.14 GiB     | 1.05 GiB     |
| 2 arenas, DuckDB 50 % of the budget               | 23.8 s  | 56.5 s  | 51.5 s  | 0.77 GiB     | 0.88 GiB     | 0.89 GiB     |
| **Engine default** (below), memory returned after each job | 23.0 s | 61.1 s | 55.2 s | 0.88 GiB  | 0.94 GiB     | 0.51 GiB     |

glibc's allocator keeps up to eight arenas per core by default, and memory freed by one query's
threads stays idle in arenas the next query's threads do not use. The engine now:

- gives DuckDB the budget less a reserve of a quarter of it, at least 512 MiB, but never less than
  half the budget (75 % of a large budget, half of a 1 GiB one);
- limits the allocator to two arenas on Linux;
- returns memory freed by each finished job to the operating system.

A tight budget costs time, because DuckDB spills sooner: the checks above took 20 % longer at 1 GiB.
At the default budget the 10 GB checks took about 2 % longer than without a reserve.

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
measures the CSV export instead, and `TW_BENCH_ENGINE_ARGS` passes engine arguments, such as
`--memory-limit 1073741824` for a 1 GiB budget.

## 1,000,000 rows (84 MB)

The same workflow and machine, with `--rows 1000000`, before the memory changes:

| Stage           | Time  |
| --------------- | ----- |
| Preview         | 0.4 s |
| Import          | 1.7 s |
| Checks          | 1.9 s |
| Export, Parquet | 4.2 s |
| Export, CSV     | 8.0 s |

From 1 million to 124 million rows the import time grows 90-fold, the export 76-fold and the
checks 202-fold. Checks grow faster than the data because the duplicate and series checks sort or
hash the whole table, which spills to disk once it no longer fits in memory.
