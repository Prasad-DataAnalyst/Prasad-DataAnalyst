# Tracewell Data Workbench

Tracewell is an offline data workbench for oil, gas and LNG data. It imports messy CSV/TSV, Excel
and GeoJSON files, checks them against declarative, versioned rules, records every human decision in
an append-only audit log, and exports validated packages whose every value can be traced back to the
source file, the rule or method applied, and the decision that changed it.

- **Author and owner:** Prasad (Prasad-DataAnalyst)
- **Status:** slice 1, labelled **prototype** (see the product specification, section 6)
- **Design:** the Software Architecture Document (`docs/tracewell-architecture.md` in the repository
  root) is normative; the product specification sits next to it.

## Offline by design

Tracewell has no network code. The production build carries a strict Content Security Policy, all
fonts and icons are local, and the end-to-end suite fails any test that makes a request outside the
local origin. Data stays in memory and in the files you save.

## Requirements

- Node.js 22.12 or later, npm 10
- For the end-to-end suite: Chromium for Playwright 1.56.1 (looked up in `PLAYWRIGHT_BROWSERS_PATH`,
  default `/opt/pw-browsers`; the suite never downloads browsers), Python 3.13 with openpyxl, and
  LibreOffice for the independent export oracles

## Commands

Run from this folder:

| Command                  | What it does                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| `npm ci`                 | Install the exact pinned dependencies from `package-lock.json`                   |
| `npm test`               | The single command: hygiene, licences, typecheck, lint, native, unit, build, E2E |
| `npm run dev`            | Development server                                                               |
| `npm run build`          | Production build into `dist/` (CSP injected)                                     |
| `npm run preview`        | Serve the build on `http://127.0.0.1:4173`                                       |
| `npm run typecheck`      | `tsc --noEmit` over the whole package                                            |
| `npm run lint`           | ESLint with zero warnings allowed                                                |
| `npm run format`         | Prettier check                                                                   |
| `npm run test:unit`      | Vitest: architecture, unit, property, golden and conformance tests               |
| `npm run build:native`   | Build the native engine (Rust + DuckDB) in `crates/tracewell-engine`             |
| `npm run test:native`    | Rust unit tests, then the native build the parity suite runs against             |
| `npm run test:e2e`       | Playwright against the production build                                          |
| `npm run test:slow`      | The slow suites (1 M-row benchmarks) with `TW_SLOW=1`                            |
| `npm run fixtures`       | Regenerate the messy-file library                                                |
| `npm run check:hygiene`  | Authorship hygiene scan (forbidden names are stored only as SHA-256 hashes)      |
| `npm run check:licences` | Licence allow-list over the shipped dependency tree                              |

`node scripts/test-all.mjs --skip-e2e` runs every stage except Playwright, and `--skip-native` leaves
out the Rust stage on a machine without Rust (the native parity suite is then skipped and says so).
The native engine needs Rust 1.85 or later; its first build compiles DuckDB and takes about 15 minutes.

## Layout

One npm package. Each module lives in its own folder, exports only through its `index.ts`, and is
imported as `@tw/<module>` (for example `@tw/formats-csv` for `src/formats/csv`).
`tests/architecture/boundaries.test.ts` enforces the module dependency allow-list of SAD section 6.1:
no deep imports, no relative imports across module folders, no undeclared npm packages, and no path
from the user interface to engine internals.

```text
src/          model, io, units, geo, engine-api, formats/{csv,xlsx,geojson}, detect, table, audit,
              ingest, rules, steps, export, project, engine, ui-shell, ui-views, app
fixtures/     messy-file library, expectations, generators and the fixture loader
tests/        architecture, conformance, e2e, oracle
scripts/      test-all.mjs, check-hygiene.mjs, check-licences.mjs
crates/       tracewell-engine: the native engine (Rust, DuckDB, Parquet) behind the stdio protocol
```

## Using the workbench

Start it with `npm run build && npm run preview` and open `http://127.0.0.1:4173`. On first start it
asks for your name, which is recorded with every change. Then follow the process toolbar:

1. **Import** (File › Import file…, Ctrl+I): CSV, TSV, Excel, GeoJSON, JSON (arrays, JSON Lines or
   a saved API response) and Parquet. The preview shows what was detected, how sure Tracewell is,
   and every assumption. Reading settings and column types, units and roles can be changed there;
   each change is logged with your reason. Save a dataset's columns as a mapping template
   (Data › Mapping templates…) and later files with the same columns are read the same way.
2. **Check** (Data › Run checks, Ctrl+K): the issues register groups findings by rule and column.
3. **Review**: edit cells, accept or exclude rows, comment. Every decision needs a reason, and
   Edit › Undo last change reverts with a compensating entry rather than deleting history. Select a
   cell to see its full lineage in the Properties panel.
4. **Process** and **Extract**: unit conversions with cited factors, filters and column selection,
   all as logged, non-destructive steps.
5. **Export** (Ctrl+E): Excel, CSV, Parquet or GeoJSON packages, each read back and verified before
   it is offered.

Save the project (Ctrl+S) as a `.twp` file. Opening it (Ctrl+O) verifies every checksum and the audit
chain and rebuilds the data from the original files; if anything fails, the project opens read-only.

## Measured performance (slice 1)

Recorded by `npm run test:slow` in the build container (headless Chromium, Lite edition):

| Measure                                     | Result |
| ------------------------------------------- | ------ |
| Preview of a 1,000,000-row CSV (5 columns)  | 0.4 s  |
| Full import of the same file                | 7.0 s  |
| Data grid page fetch at the end of the file | 0.09 s |

Each run writes its figures to `test-results/benchmarks.json`.

The native engine imports, checks and exports a 10 GB CSV (124 million rows) in 14 minutes on four
cores, within a memory budget of half the machine's RAM: import 2.6 minutes, checks 6.4 minutes,
Parquet export 5.3 minutes. Set-up, memory and disk figures, and the commands to reproduce the run,
are in [docs/benchmarks.md](../docs/benchmarks.md).

## Determinism and traceability

The engine never reads the wall clock or a random source directly; both are injected. Nor does it
depend on the machine's time zone or locale. Lint rules enforce both, and they also keep Node-only
globals out of code that runs in the browser. The same inputs, steps and rule-packs give
byte-identical outputs.

The audit log is a SHA-256 hash chain. It is **tamper-evident, not tamper-proof**: an edited entry
breaks the chain and is reported, but someone who rewrites the whole chain can recompute it. Signed
chains need key management and are planned together with signed rule-packs.

## Licence

Apache License 2.0 (see `LICENSE` and `NOTICE`). The product specification records this choice as
provisional until the dependency review is complete.

Copyright 2026 Prasad (Prasad-DataAnalyst).
