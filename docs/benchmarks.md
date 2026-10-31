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
stage. This run did not sample the working folder. The 2026-10-31 runs of the same engine settings
(below) put its peak at 14.1 to 14.7 GiB, all of it DuckDB's spill files during checks: 1.6 times
the size of the CSV. Run 2, which gave DuckDB the whole budget and so spilled less, peaked at
11.0 GiB.

### Against the requirements

- **NFR-03 (import and convert a 10 GB CSV in minutes, not hours): met.** The import takes 2.6
  minutes and the whole workflow 14 minutes on four cores. This run sets the target the
  requirement asks for: **import of 10 GB within 5 minutes, and import, check and export within
  30 minutes, on a 4-core machine with 16 GB of RAM.**
- **NFR-04 (memory never exceeds a configurable limit, default 50 % of RAM; spills to disk
  instead of failing): met.** The process peaked at 7.19 GiB against its 7.86 GiB budget, and
  DuckDB spilled to disk as designed.
- **NFR-11 (disk at most 3× the data size): met.** Peak working-folder use was 1.6× the CSV (from the
  2026-10-31 runs; see above).

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

The working folder needs about 16 GB of free disk for a 10 GB CSV. `TW_BENCH_LOG` gets a line as
each stage starts and ends; `TW_BENCH_OUT` gets the figures as JSON. `TW_BENCH_PROFILE=csv`
measures the CSV export instead, and `TW_BENCH_ENGINE_ARGS` passes engine arguments, such as
`--memory-limit 1073741824` for a 1 GiB budget.

## 10 GB project: save and reopen

The same workflow, then the project is saved as a `.twp` file and opened by a second engine process
(decision D-13). The second process starts with an empty working folder, so everything it has comes
from the project file.

### Set-up

| Item     | Value                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine  | A fresh cloud container of the same size: 4 vCPU Intel Xeon @ 2.80 GHz, 15.7 GiB RAM, virtual disk                                          |
| Engine   | `tracewell-native` 0.1.0, release build, commit `1bc14bc`                                                                                   |
| Settings | Engine defaults, as above (a memory budget of 7.86 GiB)                                                                                     |
| Input    | The same seeded `well_daily_124m.csv`, generated just before the run (5 min 46 s)                                                           |
| Workflow | Preview → import → checks → Parquet export → save to a path → stop the engine and empty its working folder → open the project in a new engine process |

The run script deletes the CSV once the save has finished, which the first run below needed to fit
the container's 26 GiB of free disk. The open never reads it.

### Results (2026-10-31)

| Stage     | Time         | Engine peak memory (RSS) | Working folder, peak | Result                                                                                                       |
| --------- | ------------ | ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Preview   | 0.3 s        | 0.02 GiB                 | 0                    | 10 columns planned from the first MiB                                                                        |
| Import    | 153.7 s      | 4.62 GiB                 | 3.41 GiB             | 124,000,000 rows; working Parquet file 1.40 GiB                                                              |
| Checks    | 384.8 s      | 7.10 GiB                 | 14.66 GiB            | The same 11 issues                                                                                           |
| Export    | 333.3 s      | 2.67 GiB                 | 3.89 GiB             | Parquet package of 1.24 GiB; all 12 read-back checks passed                                                  |
| Save      | 361.4 s      | 1.70 GiB                 | 1.40 GiB             | Project file of 10.86 GiB (11,665,921,362 bytes) in 13 entries: the CSV, the working Parquet file, 124 MB of check results |
| Open      | 196.3 s      | 0.70 GiB                 | 1.40 GiB             | Every integrity check passed; the data restored from the saved working data, the issues from the saved check results |
| **Total** | **23.8 min** | **7.10 GiB**             | **14.66 GiB**        |                                                                                                              |

Peak memory is sampled every 2 seconds, except for the open: it runs in its own process, so the
figure is that process's own high-water mark. Import, checks and export took within 5 % of the
2026-10-28 run above.

**Save.** About 100 s computes the dataset digest that the open compares against, about 100 s reads
the 10 GB original to check it is still the file that was imported, about 100 s writes the project
file, and about 60 s reads the finished file back for the SHA-256 the save returns.

**Open.** About 85 s verifies the SHA-256 of every entry against the manifest, about 15 s copies the
working Parquet file out and reads the check results, and about 95 s recomputes the dataset digest
and compares it with the one the save recorded. Nothing is imported or checked again: that would
add about 9 minutes.

### Against the requirements

- **FR-PRJ-02 (one portable project file): met** at 10 GB. The file is one ZIP of STORED entries with
  ZIP64 fields, which standard ZIP tools list and extract.
- **FR-IMP-09 (Parquet internally, originals kept unchanged): met.** The project file holds the CSV
  byte for byte, its SHA-256 checked against its file ID on open, beside the Parquet working file.
- **Decision D-13 (a large project opens without being imported again): met.** The open takes 3.3
  minutes, a third of the 9 minutes the import and checks take.
- **NFR-04 (memory under the budget): met.** The highest stage peak was 7.10 GiB against 7.86 GiB.
- **NFR-11 (free disk about 3× the data size): met.** The most disk in use at once was 24.0 GiB,
  2.6 times the CSV, during the checks: the CSV and 14.66 GiB of DuckDB spill files. During the save,
  the CSV, the working folder and the project file took 21.6 GiB.

### History of this run

| Run           | Engine change                                         | Import    | Checks  | Export  | Save    | Open    | Open: peak memory | Project file |
| ------------- | ----------------------------------------------------- | --------- | ------- | ------- | ------- | ------- | ----------------- | ------------ |
| 4 (`35cc3c1`) | Caches of the imported data; checks run again on open | 539.1 s ¹ | 440.9 s | 363.4 s | 371.8 s | 605.3 s | 7.29 GiB          | 11.54 GB     |
| 5 (`204a86b`) | The check results cached too                          | 145.9 s   | 409.2 s | 403.4 s | 371.6 s | 196.7 s | 1.09 GiB          | 11.91 GB     |
| 6 (`1bc14bc`) | A row set equal to the current rows written once      | 153.7 s   | 384.8 s | 333.3 s | 361.4 s | 196.3 s | 0.70 GiB          | 11.67 GB     |

- **Run 4** spent about 405 of its 605 seconds of opening running the recorded checks again, with
  the same memory (7.29 GiB) and spill files (14.85 GiB) as the checks themselves; at its peak the
  disk had 0.5 GiB left. Decision D-13 was revised to cache each checked dataset's issues as well.
- **Run 5** opened in a third of the time, but its check results took 372 MB: each of the six spike
  issues flags about 5 million scattered rows, and kept that 15.5 MB set of rows three times (as its
  rows, its flagged rows and its current rows).
- **Run 6** writes a set equal to the current rows once: 124 MB.

Export times varied between 333 and 403 seconds on the same code, so differences of that size
between these runs are noise from the shared machine.

¹ Run 4 read the CSV cold from the container's virtual disk, which had been restarted since the file
was generated. The kernel reported I/O stalls for 27–29 % of the time and spent more than half the
CPU time in the kernel. Runs 5 and 6 generated the CSV just before, so most of it was still in the
operating system's cache, as in the 2026-10-28 runs. NFR-03's 5-minute target is met with the file
in the cache. Reading it cold depends on the disk, and on this virtual disk the import took 9 minutes.

### Reproduce

Add `TW_BENCH_SAVE` to the command above:

```sh
TW_BENCH_CSV=/data/well_daily_124m.csv TW_BENCH_WORKDIR=/data/work TW_BENCH_SAVE=/data/bench.twp \
  TW_BENCH_OUT=/data/result.json TW_BENCH_LOG=/data/progress.log npx vitest run tests/bench
```

The working folder must not hold anything else: it is emptied before the open. The run needs about
16 GB of free disk besides the CSV's own 10 GB, most of it for the spill files during the checks.

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
