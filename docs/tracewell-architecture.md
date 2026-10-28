# Tracewell: Software Architecture Document

|                        |                                                                  |
| ---------------------- | ---------------------------------------------------------------- |
| **Product**            | Tracewell Data Workbench                                         |
| **Document**           | Software Architecture Document (SAD)                             |
| **Version**            | 0.1 (covers the long-term architecture and the R0 slice 1 build) |
| **Date**               | 19 October 2026                                                  |
| **Author and owner**   | Prasad (Prasad-DataAnalyst)                                      |
| **Companion document** | `docs/tracewell-product-spec.md` (PRD v0.1)                      |
| **Status**             | Approved for slice 1 implementation                              |

---

## 1. Purpose and scope

This document settles the open decision "engine implementation language" (PRD §19) and describes:

- the long-term architecture: desktop application, browser Lite edition, engine abstraction, and the path to 10 GB+;
- the exact architecture of **R0 slice 1**. This is the first vertical slice that can be fully built, unit-tested and end-to-end tested in a headless Linux container. It covers Import → Check → Review → Process → Extract → Export plus project save and open, on real files.

Requirement IDs (FR-_, NFR-_, UI-*) refer to the PRD.

---

## 2. Goals and constraints

### 2.1 Architectural goals

1. **Traceability first.** Every value shown or exported is a pure function of: original files + import specification + the append-only audit log. Any cell can be explained back to its source byte location (FR-AUD-01, G2).
2. **Never block, never hide.** Detectors apply defaults and record each assumption as visible data, with a confidence level and an "assumed" flag (FR-IMP-07/08).
3. **Pick the destination, not the format.** Export profiles are named by destination and encode all of that destination's rules (FR-EXP-01/02).
4. **Validate every output.** An export is reported as successful only after its file and its package have been read back through an independent reader path (FR-EXP-06/07).
5. **Big data is normal.** Text formats are streamed. Engine work goes through a protocol built on handles, windows and jobs, so a native out-of-core engine can replace the in-browser engine without changing the UI (G4, NFR-03/04).
6. **Determinism.** Same inputs + same steps + same rule-packs = same output (NFR-06). The engine never reads the wall clock or a random source directly; both are injected.
7. **Solo maintainability.** One owner from a data-analyst background must be able to read and verify the code. The design therefore prefers one language for slice 1, plain data structures, declarative rules and units held as data files, and few dependencies.

### 2.2 Constraints

| Constraint                                                                                                                                                            | Consequence                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Offline by default, no telemetry, no data leaves the machine                                                                                                          | No network code in the application. A strict Content Security Policy in the production build. An E2E guard fails any test that makes a request off the local origin.     |
| Online only for optional basemaps (later)                                                                                                                             | The future map module is the only component allowed a network permission, behind an explicit setting.                                                                    |
| Enterprise desktop-style UI, not chat-style                                                                                                                           | Menu bar, process toolbar, project tree, tabbed centre, properties panel, Issues/Log/Jobs panel, status bar.                                                             |
| Build container: Linux, 4 CPU, 15 GB RAM, no display, Node 22.22, npm 10.9, Rust 1.97, Python 3.13, Chromium 1194 for Playwright at `/opt/pw-browsers`, no webkit2gtk | Slice 1 is a web build tested headless. The Tauri desktop shell cannot be built here and comes later. A native engine _can_ be built and tested here headless (slice 2). |
| Permissive licences only (MIT, BSD, Apache-2.0, ISC; MPL-2.0 for unmodified use)                                                                                      | A licence gate script runs in the test pipeline (§14).                                                                                                                   |
| Authorship                                                                                                                                                            | Code, documents, About screen and commits are in the owner's name only. A repository hygiene check runs in the test pipeline.                                            |

---

## 3. Decision summary (architecture decision record)

**Decision.** Build the engine first in **TypeScript, behind a versioned, message-based engine protocol**, running in a Web Worker in the browser and in-process in Node for tests. For files beyond browser memory, add a **native engine (Rust + DuckDB + Parquet) behind the same protocol** from slice 2. The **Tauri desktop shell** loads the same UI build and talks to the native engine.

**Why.**

- Everything in slice 1 can be built and verified in this container with npm alone.
- The browser Lite edition needs an in-browser engine anyway, so the TypeScript engine is permanent product code, not a prototype. In the desktop product it becomes the **reference implementation**: the native engine must reproduce the same issues and digests on the same fixtures (one conformance suite, two independent implementations). That is direct evidence for PRD §16.
- The owner works in one language for slice 1.

**Alternatives considered.**

| Alternative                                                        | Why not chosen for slice 1                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DuckDB-WASM in the browser plus native DuckDB in Node              | Strongest SQL path, but needs two engine builds kept in step, about 9 MB of engine assets, and extensions that must be vendored to stay offline. The browser build is single-threaded with no spill, and the latest npm tag is a development build. The good ideas are kept for the native engine: SQL-translatable check primitives, raw-text staging, the 10 GB benchmark generated by DuckDB. |
| A Rust core compiled to WebAssembly and linked natively into Tauri | One engine for both editions. But it needs two toolchains plus a WASM toolchain installed from the network, and puts a Rust learning curve on the solo owner at the start. Its key ideas are kept: injected clock and IDs, state rebuilt by replaying the audit log, fixed timestamps in written files.                                                                                          |

**Accepted costs.**

- The TypeScript engine is memory-bound: roughly 1–2 M rows × 30 columns per dataset in a browser tab. It enforces a memory budget and falls back to a partial import with a visible issue.
- Check primitives and steps will exist in TypeScript and in SQL. This is contained by a small, closed set of primitives, each with a defined SQL template, and by the shared conformance suite.

### 3.1 Decision D-12 (slice 2): import planning is written once

**Context.** Detection (encoding, delimiter, header rows, types, units, roles, null markers, date formats, CRS) is about 1,900 lines of TypeScript heuristics tuned to the messy-file library. Re-implementing it in Rust would double the code most likely to diverge between engines, and the plan it produces is already engine-neutral data: the `ImportSpec` that the `source.add` audit entry records.

**Decision.** Planning stays in TypeScript, the reference implementation. The native engine **executes** a reviewed plan rather than re-deriving one.

- Protocol 0.2 adds an optional `preview` field to `importFile`: the `ImportPreview` the user reviewed. The TypeScript engine plans again (same input, same result); the native engine imports exactly that plan.
- Sniffing reads at most 1 MiB, so planning in TypeScript costs the same for a 10 GB file as for a small one. In the desktop edition the planner answers `sniff` and the native engine answers everything that touches the full file.
- What _is_ ported to Rust is the cell parser that a plan drives (numbers with locale separators, null markers, the date families, booleans): a few hundred lines, checked against the TypeScript parser by the conformance suite.

**Consequences.** Both engines write identical `source.add` payloads for the same file and plan, so their audit logs mean the same thing. Parity work moves to execution: reading every format under a plan, check primitives as SQL, steps as SQL views, and exports.

---

## 4. Long-term architecture

### 4.1 Editions and runtimes

```text
                 ┌──────────────────────────── same UI build (React, TypeScript) ───────────────────────────┐
                 │ menu bar · process toolbar · project tree · centre tabs · properties · issues/log/jobs   │
                 └───────────────┬───────────────────────────────────────────────┬──────────────────────────┘
                                 │ EngineClient (protocol 0.x)                   │
          ┌──────────────────────┴─────────────┐                 ┌───────────────┴────────────────────────┐
          │ Browser Lite edition               │                 │ Desktop edition (Tauri 2)              │
          │ workerTransport (postMessage)      │                 │ tauriTransport (invoke + events)       │
          │   └─ Web Worker: LocalEngine (TS)  │                 │   └─ native engine (Rust):             │
          │      in-memory column store        │                 │      DuckDB (out-of-core SQL, spill)   │
          │      memory budget, partial import │                 │      Parquet working files             │
          └────────────────────────────────────┘                 │      GDAL/PROJ (spatial, CRS)          │
                                                                 └────────────────────────────────────────┘
   Node (tests, benchmarks):  inProcessTransport(LocalEngine)    |    stdioTransport(native engine, headless)
```

- **UI.** Depends only on `model` (shared types) and `engine-api` (protocol and client). It never imports engine internals. A unit test enforces this boundary.
- **Engine protocol.** JSON-serialisable method calls plus an event stream. Long operations are jobs with progress and cancel. Data is read in row windows of up to 1,000 rows. Files are passed **by reference** (`{kind:'blob'}` in the browser, `{kind:'path'}` for native), so file bytes never cross the UI boundary on desktop.
- **Engines.**
  - `LocalEngine` (TypeScript): Lite edition, and reference implementation.
  - `tracewell-engine` (Rust, from slice 2): desktop edition and big data.
  - Both pass `tests/conformance`.

### 4.2 Engine abstraction rules

1. Steps (unit conversion, filter, column selection) and rules (check primitives) are **declarative JSON**, so each engine translates them natively (TypeScript functions or SQL).
2. Every engine maintains the same **audit log format**, the same **canonical value encoding** and the same **digests** (§9.4), so outputs can be compared bit for bit.
3. Engines report `capabilities` (formats, memory budget, spill, CRS transform). The UI adapts to them rather than assuming.
4. Protocol versions follow semantic versioning. A major mismatch is refused with a clear message.

### 4.3 Path to 10 GB+ (G4, NFR-03, NFR-04)

| Phase                                  | Where                                                           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: contract hardening (slice 2)        | this container                                                  | Freeze protocol 0.x. Add `stdioTransport` (JSON lines plus binary frames). Grow `tests/conformance` so every scenario is fixture → expected issues and digests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B: headless native engine (slices 2–3) | this container (Rust 1.97 works; only the GUI shell is missing) | Crate `crates/tracewell-engine` using `duckdb` (bundled), `arrow`/`parquet`, `calamine`, `rust_xlsxwriter`, `zip`, `sha2`, `csv`. Import stages every column as text (`read_csv(all_varchar=true, store_rejects=true)`), infers types in one aggregate pass, keeps cast failures in a side table (no raw value lost), and writes Parquet working files (FR-IMP-09). DuckDB `memory_limit` and `temp_directory` give spill-to-disk (NFR-04). Each check primitive has one SQL template (§8.3). The overlay becomes an `edits` table joined with `COALESCE`; steps become SQL views; exports stream with `COPY` and `rust_xlsxwriter` (constant-memory mode). The conformance suite and the Playwright suite run against it through a development-only loopback bridge. |
| C: 10 GB benchmark (slice 2)           | this container, then the reference laptop                       | DuckDB generates a seeded 10 GB CSV (`COPY (SELECT … FROM range(N)) TO …`). Import → check → export is measured under `memory_limit` = 50% of RAM, and results are published in `docs/benchmarks.md`. Large projects need a decision record on `.twp` layout (stored ZIP64 versus a project folder exported to `.twp`), because NFR-11 budgets disk at 3× the data size.                                                                                                                                                                                                                                                                                                                                                                                              |
| D: desktop shell (later)               | a Windows build runner with WebView2                            | Tauri 2 loads the same UI build. `tauriTransport` uses commands and events. Native file dialogs pass paths. GDAL and PROJ are linked natively. A crash-recovery journal is kept on disk (FR-PRJ-03 becomes "replay the journal").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The Lite edition keeps `LocalEngine`. Above its memory budget it imports a partial preview, raises `TW-IMP-006` and tells the user the desktop edition handles the file.

---

## 5. Slice 1 architecture

### 5.1 Runtime topology

```text
Browser tab (production build served from 127.0.0.1 in tests)
 ├─ Main thread: React UI (ui-shell + ui-views), zustand store, EngineClient
 │      │ postMessage RPC (structured clone; Uint8Array transferred)
 └─ Module Web Worker: LocalEngine
        ├─ ingest  (csv | xlsx | geojson readers → detect → table)
        ├─ rules   (check primitives over the working view)
        ├─ steps   (convert_unit, filter, select_columns → View)
        ├─ audit   (hash-chained append-only log; the single source of truth)
        ├─ export  (writers → read-back → package → re-open package → verify)
        └─ project (.twp write/read; integrity checks)

Node (Vitest): the same LocalEngine via inProcessTransport; fixtures read from disk.
```

There is no SharedArrayBuffer and no cross-origin isolation, so plain static hosting works and the future Tauri custom protocol needs nothing special.

### 5.2 Repository layout (single npm package)

```text
tracewell/
├── package.json            # private, "type": "module", exact pins, engines.node ">=22.12"
├── package-lock.json       # committed; installs with `npm ci`
├── tsconfig.json           # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes,
│                           # moduleResolution "bundler", paths "@tw/<module>" -> src/<module>/index.ts
├── vite.config.ts          # React plugin, @tw/* aliases, CSP meta injected at build only, worker format "es"
├── vitest.config.ts        # environment node; include src/**/*.test.ts, tests/conformance, tests/architecture
├── playwright.config.ts    # chromium only, browsers from /opt/pw-browsers, webServer = build + preview on 127.0.0.1:4173
├── eslint.config.js        # @eslint/js + typescript-eslint + react-hooks
├── .prettierrc.json  .gitattributes (fixtures/** binary)  .npmrc (save-exact=true, engine-strict=true)
├── index.html
├── LICENSE  NOTICE  README.md
├── docs/                   # this document, twp-format.md, rule-catalogue.md, units-sources.md, benchmarks.md
├── src/
│   ├── model/              # shared types, canonical encoding, zod schemas, errors (everyone depends on it)
│   ├── io/                 # ByteSource/ByteSink, SHA-256, text encodings, deterministic ZIP
│   ├── units/              # cited unit registry (JSON), header-unit parser, conversions, physical bounds
│   ├── geo/                # geometry validation, bbox, lat/lon heuristics
│   ├── engine-api/         # protocol, EngineClient, transports, serve(), stub engine
│   ├── formats/csv/        # CSV/TSV sniff, streaming tokenizer, reader, writer
│   ├── formats/xlsx/       # XLSX reader (ZIP + SAX), layout detection, writer
│   ├── formats/geojson/    # streaming GeoJSON reader, writer
│   ├── detect/             # type/unit/role/null-marker/date-format/timezone detection; value parsers
│   ├── table/              # column store, TableBuilder, RowSet, Overlay, View, digests
│   ├── audit/              # hash-chained append-only log
│   ├── ingest/             # preview and import pipeline (formats → detect → table), source hashing
│   ├── rules/              # rule-pack loader, check primitives, runner, built-in packs (JSON)
│   ├── steps/              # step validation, conversion and filter compilation, view building
│   ├── export/             # profiles, package builder, read-back validators
│   ├── project/            # .twp writer/reader and structural integrity checks
│   ├── engine/             # LocalEngine: reducer, jobs, decisions, issues state, lineage, replay, worker entry
│   ├── ui-shell/           # layout, menus, toolbar, tree, status bar, bottom panel, commands, tokens, store
│   ├── ui-views/           # data grid, import preview, issues register, dialogs, export centre, properties, log
│   └── app/                # entry point, worker bootstrap, wiring
├── fixtures/
│   ├── messy/              # committed messy files + <name>.expected.json; SHA256SUMS
│   ├── generators/         # make_xlsx_fixtures.py (openpyxl, then LibreOffice re-save), gen-text-fixtures.mjs, gen-large-csv.mjs
│   └── index.ts            # fixtureBytes(), fixtureSource(), fixtureExpectation()
├── tests/
│   ├── architecture/       # boundaries.test.ts (import allow-list)
│   ├── conformance/        # engine-agnostic workflow scenarios over EngineApi
│   ├── e2e/                # Playwright specs and shared offline-guard fixture
│   └── oracle/             # canonical.py, check_csv.py, check_xlsx.py, check_geojson.py, check_package.py, lo_roundtrip.sh
└── scripts/
    ├── test-all.mjs        # the single command
    ├── check-hygiene.mjs   # forbidden-name scan (patterns stored as SHA-256 token hashes)
    └── check-licences.mjs  # production dependency licence allow-list (reads `npm ls --omit=dev --all --json`)
```

**Why a single package and not npm workspaces.** One `package.json`, one lockfile, one `tsconfig.json`, one Vitest and one Vite config: there are no per-package build steps, version bumps or project-reference ordering to maintain. Module boundaries are still explicit and enforced:

- each module exports only through `src/<module>/index.ts`;
- other modules import it as `@tw/<module>`;
- `tests/architecture/boundaries.test.ts` fails the build on any import outside the allow-list in §6.2, and on any deep import (`@tw/x/...`).

Engineers can work in parallel, one folder each. If the CLI or the engine ever needs publishing, a folder can be promoted to a workspace without changing import names.

---

## 6. Module map

### 6.1 Modules and build order

Modules with the same build order can be built in parallel. Lower numbers come first.

| Order | Module          | Path                                                  | Depends on                                                                             |
| ----- | --------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0     | tooling         | `tracewell/` (configs, scripts, `tests/architecture`) | none                                                                                   |
| 0     | model           | `src/model`                                           | zod                                                                                    |
| 1     | io              | `src/io`                                              | model, fflate, @noble/hashes                                                           |
| 1     | units           | `src/units`                                           | model                                                                                  |
| 1     | geo             | `src/geo`                                             | model                                                                                  |
| 1     | engine-api      | `src/engine-api`                                      | model                                                                                  |
| 1     | fixtures        | `fixtures/`                                           | model, io                                                                              |
| 2     | formats-csv     | `src/formats/csv`                                     | model, io                                                                              |
| 2     | formats-xlsx    | `src/formats/xlsx`                                    | model, io, saxes                                                                       |
| 2     | formats-geojson | `src/formats/geojson`                                 | model, io, @streamparser/json                                                          |
| 2     | detect          | `src/detect`                                          | model, units                                                                           |
| 2     | table           | `src/table`                                           | model, io                                                                              |
| 2     | audit           | `src/audit`                                           | model, io                                                                              |
| 2     | ui-shell        | `src/ui-shell`                                        | model, engine-api, react, zustand, react-resizable-panels, lucide-react                |
| 3     | ingest          | `src/ingest`                                          | model, io, detect, table, formats-csv, formats-xlsx, formats-geojson                   |
| 3     | rules           | `src/rules`                                           | model, io, table, units, geo                                                           |
| 3     | steps           | `src/steps`                                           | model, table, units, geo                                                               |
| 3     | export          | `src/export`                                          | model, io, table, units, geo, formats-csv, formats-xlsx, formats-geojson               |
| 3     | project         | `src/project`                                         | model, io                                                                              |
| 3     | ui-views        | `src/ui-views`                                        | model, engine-api, ui-shell, @tanstack/react-virtual                                   |
| 4     | engine          | `src/engine`                                          | model, io, units, geo, engine-api, table, audit, ingest, rules, steps, export, project |
| 5     | app             | `src/app`, `index.html`                               | model, engine-api, ui-shell, ui-views, engine                                          |
| 5     | conformance     | `tests/conformance`                                   | model, io, engine-api, engine, fixtures                                                |
| 6     | e2e             | `tests/e2e`, `tests/oracle`, `playwright.config.ts`   | app (built), fixtures                                                                  |

### 6.2 Dependency diagram

```text
                                    ┌──────────┐
                                    │  model   │  (types, canonical encoding, schemas, errors)
                                    └────┬─────┘
          ┌───────────────┬──────────────┼─────────────┬───────────────┬──────────────┐
       ┌──┴──┐        ┌───┴───┐      ┌───┴──┐     ┌────┴─────┐     ┌───┴────┐         │
       │ io  │        │ units │      │ geo  │     │engine-api│     │fixtures│         │
       └──┬──┘        └───┬───┘      └───┬──┘     └────┬─────┘     └────────┘         │
  ┌───────┼────────┬──────┼───────┐     │        ┌─────┴─────┐                        │
┌─┴──────┐│┌───────┴┐ ┌───┴──┐ ┌──┴───┐ │        │ ui-shell  │                        │
│formats ││ │ table  │ │detect│ │audit │ │        └─────┬─────┘                        │
│csv/xlsx││ └───┬────┘ └──┬───┘ └──┬───┘ │        ┌─────┴─────┐                        │
│/geojson││     │         │        │     │        │ ui-views  │                        │
└───┬────┘│     │         │        │     │        └─────┬─────┘                        │
    │  ┌──┴─────┴─────────┴──┐  ┌──┴─────┴──┐ ┌──────┐  │                              │
    ├──┤ ingest │ export     │  │ rules     │ │steps │  │      ┌─────────┐             │
    │  └────────┴────────────┘  └───────────┘ └──────┘  │      │ project │─────────────┘
    │            └───────────────┬───────────────┘      │      └────┬────┘
    │                       ┌────┴─────┐                │           │
    └──────────────────────►│  engine  │◄───────────────┼───────────┘
                            └────┬─────┘                │
                            ┌────┴─────┐                │
                            │   app    │◄───────────────┘
                            └────┬─────┘
                  ┌──────────────┴───────────────┐
             ┌────┴──────┐                  ┌────┴────┐
             │conformance│                  │   e2e   │
             └───────────┘                  └─────────┘
```

The UI modules (`ui-shell`, `ui-views`) never import `engine`, `table`, `rules`, `formats`, `ingest`, `steps`, `export`, `project` or `audit`. Only `app` joins the UI to the engine, through `engine-api`.

### 6.3 Module responsibilities (summary)

| Module      | Responsibility                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| model       | The shared vocabulary: IDs, values, detections, schemas, issues, rules, audit entries, decisions, steps, export and project manifests, DTOs, error codes. Canonical JSON, number and cell encodings. Zod schemas for every persisted document.                           |
| io          | Byte sources and sinks over Blob/Uint8Array (and Node files in tests), incremental SHA-256, encoding sniff and decode, deterministic ZIP write and guarded ZIP read.                                                                                                     |
| units       | The single units library (FR-PRC-01): about 60 cited units, header-unit parsing, convertibility guards (dimension, convention, gauge/absolute), conversion methods, physical bounds.                                                                                     |
| geo         | Geometry structure validation, bounding boxes, lat/lon range and swap heuristics, point construction.                                                                                                                                                                    |
| engine-api  | The protocol (`EngineApi`, `EngineEvent`), RPC messages, `EngineClient`, worker, in-process and port transports, `serve()`, and a stub engine for UI development.                                                                                                        |
| formats-*   | One adapter per format: sniff (≤ 1 MiB), read as batches of raw rows with exact source locators, write. CSV and GeoJSON stream; XLSX reads a ZIP in memory under a size guard.                                                                                           |
| detect      | Turns header text and sample rows into column plans: type, unit, role, null markers, date format, timezone, decimal separator, each a `Detection`. Builds per-column value parsers.                                                                                      |
| table       | Column store, streaming `TableBuilder` that keeps raw text for values that fail to parse, `RowSet` bitmap, `Overlay` of edits, `View` (overlay → derived columns → exclusions → filters → selection), digests.                                                           |
| audit       | Append-only, SHA-256 hash-chained log with no update or delete API (FR-AUD-02); verification; JSON Lines import and export.                                                                                                                                              |
| ingest      | Preview (detections + parsed sample) and full import: streams the source, hashes it in the same pass, enforces the memory budget, returns the dataset, import spec and notes.                                                                                            |
| rules       | Loads declarative rule-packs; runs check primitives over a view; produces issue drafts with stable IDs. Ships `tracewell.generic-dq` 0.1.0 and `tracewell.system` 0.1.0.                                                                                                 |
| steps       | Validates steps; builds conversion methods; compiles filter predicates; builds the working and output views from a dataset, overlay, exclusions and steps.                                                                                                               |
| export      | Destination profiles, export planning (format-limit substitutions), writers, read-back validation, package assembly, package re-verification.                                                                                                                            |
| project     | `.twp` writer and reader, manifest validation, entry and original checksum checks. Audit-chain and replay checks are done by `engine`.                                                                                                                                   |
| engine      | `LocalEngine`: project state, a single reducer applied to audit entries (live and replay), jobs with progress and cancel, decisions, issue states, lineage, save and open with replay verification, worker entry.                                                        |
| ui-shell    | Window layout, menu bar, process toolbar, project tree, centre tab host, properties host, Issues/Log/Jobs panel, status bar, command registry and shortcuts, design tokens and themes, UI store.                                                                         |
| ui-views    | Data grid with editing and reason flow, import preview with detections and overrides, issues register with drill-down, Convert, Filter and Columns dialogs, export centre, properties content (column metadata, cell lineage), log view, jobs view, project open report. |
| app         | Bootstraps the worker engine, profile setup on first start, mounts the shell with views.                                                                                                                                                                                 |
| conformance | Engine-agnostic workflow scenarios that every engine must pass.                                                                                                                                                                                                          |
| e2e         | Playwright specs, the offline guard, independent oracle readers in Python and LibreOffice.                                                                                                                                                                               |

The exact exported signatures are listed in the implementation plan that accompanies this document. The type definitions in `src/model` are normative.

---

## 7. Data model

### 7.1 Identity

| Concept        | Representation                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project        | `ProjectId` `p_` + 16 hex characters, from the injected `IdSource` (seeded in tests)                                                                                             |
| Original file  | `FileId` = full SHA-256 of its bytes (content address)                                                                                                                           |
| Dataset        | `DatasetId` `d1`, `d2`, … in order of `source.add` audit entries                                                                                                                 |
| Column         | `ColumnId` `c0`…`cN` by source position. Derived columns are `c3~kPa`.                                                                                                           |
| Row            | `RowId` = 0-based data-row ordinal in the original, never reused or renumbered. Filters produce row sets.                                                                        |
| Source locator | Per row: CSV physical line (1-based, correct even with quoted newlines), XLSX sheet row (1-based) or GeoJSON feature index. Rendered as `line 1042`, `Sheet1!C17`, `feature 12`. |
| Issue          | `IssueId` = `I-` + the first 12 hex characters of SHA-256(`ruleId                                                                                                                | datasetId | sorted columnIds`). Stable across re-runs, which is the basis for recipes later (FR-RCP-02). |
| Step           | `StepId` `s1`, `s2`, … per project                                                                                                                                               |
| Audit entry    | `AuditSeq` 1, 2, …                                                                                                                                                               |

### 7.2 Values and types

| Logical type | Column storage (slice 1)                         | API `CellValue`                            |
| ------------ | ------------------------------------------------ | ------------------------------------------ |
| `string`     | `string[]`                                       | `string`                                   |
| `integer`    | `Float64Array` + validity bitmap (exact to 2^53) | `number`                                   |
| `number`     | `Float64Array` + validity bitmap                 | `number` (always finite)                   |
| `boolean`    | `Uint8Array` + validity                          | `boolean`                                  |
| `date`       | `Float64Array` days since 1970-01-01             | `{ date: 'YYYY-MM-DD' }`                   |
| `datetime`   | `Float64Array` ms since epoch, UTC               | `{ datetime: 'YYYY-MM-DDTHH:mm:ss.sssZ' }` |
| `geometry`   | array of GeoJSON geometry objects                | `{ geometry: Geometry }`                   |

- **Failed values.** A value that does not parse into its column type becomes null in the typed vector. **Its raw text is kept** in a sparse per-column `raw` map and raises `TW-DQ-004`; nothing is lost silently.
- **Null markers.** Values matched as null markers keep their raw text too, and raise `TW-DQ-006`.
- **Below-detection-limit text.** Text such as `<0.5` or `ND` is kept as raw text, flagged `TW-DQ-007` and never treated as zero (this anticipates FR-MET-06).
- **Inference.** Type inference samples the first 10,000 rows. Later values that do not fit go to the raw map; there is no second pass.
- **Identifiers.** Columns with leading zeros (`0012`) stay text.

### 7.3 Detections

```ts
interface Detection<T> {
  value: T;
  confidence: "high" | "medium" | "low";
  assumed: boolean;
  source: "detected" | "default" | "user";
  method: string;
  evidence: string;
  overriddenBy?: AuditSeq;
}
```

- `assumed` is true whenever confidence is not `high` or the value is a default.
- At import the engine appends one `detection.assume` audit entry per dataset (system actor `detector`) listing every assumption, and raises `TW-IMP-005`.
- The UI shows an "assumed" badge on every assumed detection: in the import preview, the grid header and the Properties panel.
- An override is a `detection.override` decision with a reason.
  - Interpretation-only overrides (name, type, unit, role, null markers, date format, timezone, CRS) re-parse that column in place.
  - Structural overrides (encoding, delimiter, header row, sheet, table block) are accepted only before the first edit on that dataset. After that they create a new dataset from the same original, and the reason states this.

### 7.4 Schemas

`TableSchema` holds:

- the dataset ID and name;
- the source (file ID, name, format, sheet);
- the row count;
- the columns (`ColumnSchema`: ID, name, original header cells, source index, and detections of type, role, unit, null markers, date format, timezone and decimal separator, plus quantity kind and `derivedFrom`);
- the CRS detection;
- the geometry column;
- the `partial` flag.

### 7.5 Units

- `src/units/registry-2026.1.json` holds about 60 units. Each unit has:
  - a code, a label and aliases;
  - a quantity kind;
  - `toSI` factor and offset, and an `exact` flag;
  - a convention tag (`gauge`, `std-60F-14.696psia`, `std-15C-101.325kPa`, `std-0C-101.325kPa`);
  - a citation (NIST SP 811 Appendix B, SI Brochure, API MPMS for the barrel).
- The SHA-256 of the registry file is recorded in every project and export manifest.
- A conversion produces a `ConversionMethod` `{from, to, fromFactor, fromOffset, toFactor, toOffset, formula, source, registryVersion}`, computed through SI: `y = ((x·fF + oF) − oT) / fT`.
- Hard guards in slice 1:
  - different dimensions → `UNIT_DIMENSION`;
  - standard volumes at different reference conditions → `UNIT_CONVENTION` (FR-CNV-03 behaviour until the conventions engine exists);
  - gauge ↔ absolute pressure → `UNIT_GAUGE_ABSOLUTE`;
  - temperature _differences_ are separate units from absolute temperatures.

### 7.6 CRS

`CrsRef = { code: 'OGC:CRS84' | 'EPSG:4326' | 'EPSG:<n>' | 'unknown'; source: 'rfc7946-default' | 'geojson-crs-member' | 'assumed-latlon' | 'user' }` is held at dataset level.

- GeoJSON defaults to CRS84 (high confidence).
- A legacy `crs` member is recorded and raises `TW-GEO-004` if it is not WGS84.
- CSV latitude/longitude columns are assumed WGS84 and marked assumed.
- Slice 1 detects and records CRS but **does not transform** it. GeoJSON export of non-WGS84 data is refused with a fix hint (`TW-EXP-003`).

### 7.7 Issues

Issues are grouped per (rule, dataset, columns), with affected rows held as a set. A million missing values is one issue with drill-down.

| Field             | Meaning                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `scope`           | `rows`, `column` or `dataset`                                                                  |
| `counts.flagged`  | Every row ever flagged by this issue during the session's check runs                           |
| `counts.open`     | Currently flagged rows minus accepted rows                                                     |
| `counts.accepted` | Currently flagged and accepted with a reason                                                   |
| `counts.excluded` | Flagged rows that were excluded                                                                |
| `counts.fixed`    | Previously flagged, no longer flagged, not excluded (typically corrected by an edit)           |
| `status`          | `resolved` when open = 0; `open` when nothing is decided or fixed; otherwise `partly_resolved` |

Checks run on the **working view**: base data + edits + unit conversions, minus excluded rows. Filters and column selection are output steps and do not affect checks. After a `cell.edit`, the engine re-runs the rules that apply to that column plus dataset-level rules.

### 7.8 Rule catalogue (slice 1)

Pack `tracewell.generic-dq` 0.1.0 (data rules):

| ID                                                                                                                        | Check primitive         | Severity |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------- |
| TW-DQ-001 missing values                                                                                                  | `not_null`              | warning  |
| TW-DQ-002 duplicate rows                                                                                                  | `duplicate_rows`        | warning  |
| TW-DQ-003 duplicate key (id + time)                                                                                       | `duplicate_key`         | error    |
| TW-DQ-004 value does not fit column type (raw text kept)                                                                  | `type_conformance`      | warning  |
| TW-DQ-005 physically impossible value (T < 0 K, absolute pressure < 0, negative amounts, fraction outside 0–1 or 0–100 %) | `physical_range`        | error    |
| TW-DQ-006 null marker converted                                                                                           | `null_marker`           | note     |
| TW-DQ-007 below-detection-limit text kept, not zero                                                                       | `below_detection_limit` | note     |
| TW-UNIT-001 measure column without a recognised unit                                                                      | `unit_known`            | warning  |
| TW-UNIT-002 mixed units inside a column                                                                                   | `unit_consistent`       | error    |
| TW-TIME-001 duplicate timestamps (per asset)                                                                              | `ts_duplicate`          | error    |
| TW-TIME-002 timestamps out of order                                                                                       | `ts_order`              | note     |
| TW-TIME-003 gap larger than k × median step (k = 3)                                                                       | `ts_gap`                | warning  |
| TW-TIME-004 timezone not specified (UTC assumed)                                                                          | `tz_specified`          | note     |
| TW-TIME-005 ambiguous day/month order                                                                                     | `date_ambiguous`        | warning  |
| TW-TIME-006 flatline (≥ 6 identical consecutive values)                                                                   | `flatline`              | warning  |
| TW-TIME-007 spike (Hampel filter, window 7, k = 3; Hampel 1974, Pearson 2002)                                             | `spike`                 | warning  |
| TW-GEO-001 invalid geometry                                                                                               | `geometry_valid`        | error    |
| TW-GEO-002 coordinates outside the valid range                                                                            | `coord_range`           | error    |
| TW-GEO-003 probable latitude/longitude swap                                                                               | `latlon_swapped`        | warning  |
| TW-GEO-004 CRS undeclared or not WGS84                                                                                    | `crs_wgs84`             | warning  |
| TW-GEO-005 outside the project area (only if an area is set)                                                              | `within_area`           | warning  |
| TW-GEO-006 missing geometry                                                                                               | `geometry_present`      | warning  |

Pack `tracewell.system` 0.1.0 (raised by the engine; messages and explanations are kept as data):

| ID         | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| TW-IMP-001 | Ragged row                                                        |
| TW-IMP-002 | Additional table found in a sheet (first imported, others listed) |
| TW-IMP-003 | Multi-row header flattened                                        |
| TW-IMP-004 | Encoding assumed                                                  |
| TW-IMP-005 | Low-confidence detections applied (assumed)                       |
| TW-IMP-006 | Partial import: file exceeds the browser memory budget            |
| TW-PRJ-001 | Original file checksum mismatch                                   |
| TW-PRJ-002 | Audit chain broken                                                |
| TW-PRJ-003 | Replay digest mismatch                                            |
| TW-PRJ-004 | Project entry checksum mismatch or unsupported format version     |
| TW-EXP-001 | Export read-back mismatch                                         |
| TW-EXP-002 | Format-limit substitution                                         |
| TW-EXP-003 | GeoJSON requires WGS84                                            |

Every rule definition carries an ID, version, title, category, severity, column selector, check specification, message template, plain-language explanation and source citation (FR-VAL-01/03).

---

## 8. Engine design (slice 1)

### 8.1 Event-sourced state

The audit log is the single source of truth. Project state is rebuilt by one reducer:

```text
state = fold(applyEntry, emptyState(projectId), auditLog)    // with originals available by FileId
```

| Entry                        | Effect in `applyEntry`                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| `project.create`             | name, profile, unit system                                        |
| `source.add`                 | parse original with the recorded ImportSpec → dataset             |
| `detection.assume`           | record assumptions                                                |
| `detection.override`         | update the spec and re-parse the column (or create a new dataset) |
| `check.run`                  | run the recorded rule-pack versions on the working view           |
| `cell.edit`                  | set overlay(row, col) and re-check affected rules                 |
| `issue.accept`               | add rows to the issue's accepted set                              |
| `rows.exclude`               | add rows to the excluded set and re-check                         |
| `step.apply` / `step.remove` | update the step list                                              |
| `entry.revert`               | apply the compensating change                                     |
| `issue.comment`              | attach a comment                                                  |
| `project.area`               | set the project bounding box and re-check spatial rules           |
| `export.create`              | add an export record                                              |
| `project.save`               | record the state digest                                           |

**Live operation uses the same reducer:** a decision is validated, appended (hashed) and then applied. Opening a `.twp` replays the log. Replaying and comparing dataset digests with the saved manifest is therefore a real proof, not a formality.

### 8.2 Jobs

- Import, checks, step application, export, save and open are jobs.
- A job yields between batches (65,536 rows) and reports progress at most every 100 ms (`bytes` or `rows`).
- A job cancels through an `AbortSignal`. A cancelled import leaves no state; a cancelled check leaves the previous issues.
- Resume (NFR-05) is deferred.

### 8.3 Check primitives and their future SQL

Each primitive has a TypeScript implementation now and a fixed SQL template for the native engine:

| Primitive                       | SQL template (native engine)               |
| ------------------------------- | ------------------------------------------ |
| `not_null`                      | `WHERE c IS NULL`                          |
| `duplicate_rows`                | `GROUP BY all columns HAVING count(*) > 1` |
| `duplicate_key`, `ts_duplicate` | `GROUP BY id, t HAVING count(*) > 1`       |
| `type_conformance`              | rows in the cast-failure side table        |
| `physical_range`                | `WHERE c * f + o < minSI`                  |
| `ts_gap`                        | `lead(t) - t > k * median(step)`           |
| `ts_order`                      | `t < lag(t)`                               |
| `flatline`                      | run-length via `lag` and window sums       |
| `spike`                         | rolling median and MAD windows             |

This keeps the semantics engine-neutral, and the conformance suite proves both engines agree.

### 8.4 Memory budget

- Default 1.5 GB in a browser tab, configurable.
- `TableBuilder.estimatedBytes()` is checked after each batch. When the budget would be exceeded, import stops cleanly. The dataset is kept as a partial dataset (`schema.partial = true`), `TW-IMP-006` is raised with the reason and the fix ("open the file in the desktop edition"), and work continues.

### 8.5 Performance targets to measure (Chromium headless, 4 CPU)

These are targets, recorded in `docs/benchmarks.md`, not claims:

- first preview < 5 s for any file size (sniff reads at most 1 MiB);
- 1 M rows × 10 columns CSV imported in < 20 s;
- a grid page fetch < 50 ms;
- the generic checks on 1 M rows < 10 s;
- UI response < 100 ms, because the engine runs off the main thread.

---

## 9. Audit and traceability design

### 9.1 Audit entry

```ts
interface AuditEntry {
  seq: number;
  at: string /* ISO-8601 UTC, ms */;
  actor:
    | { kind: "user"; profileId: string; name: string; role: "Analyst" }
    | { kind: "system"; component: "detector" | "engine" };
  action: AuditAction;
  target: AuditTarget;
  old?: JsonValue;
  new?: JsonValue;
  reason?: string;
  method?: ConversionMethod;
  rule?: { id: string; version: string };
  payload?: JsonValue;
  prev: string;
  hash: string;
}
```

- `hash = SHA-256(utf8(canonicalJson(entry without hash)))`.
- The genesis `prev` is `SHA-256('tracewell-audit-v1:' + projectId)`.
- Timestamps come from the injected `Clock`.

### 9.2 Rules

- A reason is mandatory, and checked by the engine (at least 3 non-space characters), for edits, accepts, exclusions, overrides, steps, step removal, project-area changes and reverts. Comments carry text instead.
- The engine API has no update or delete method for the log (FR-AUD-02). Undo is a compensating `entry.revert` entry.
- Bulk operations write **one** entry. For example, a unit conversion records factor, offset, formula, citation and the count of values converted and nulls skipped, not millions of cell entries.
- The chain is **tamper-evident, not tamper-proof**. Someone who rewrites the whole chain can recompute it; signed chains need key management and come with signed rule-packs later. README files state this honestly.

### 9.3 Cell lineage (`explainCell`)

`explainCell` returns:

1. the original file (name, SHA-256) and locator (`line 1042, field 3` / `Sheet1!C17` / `feature 12, property "rate"`);
2. the raw text;
3. the parse (type, method, null marker);
4. every audit entry that touched the cell or its column, in order, with old/new, reason, method and actor;
5. the current value.

The Properties panel shows this for the selected cell.

### 9.4 Canonical encoding and digests (normative)

The same encoding is used by every engine and by the Python oracles.

**Canonical number.** Exactly ECMAScript `Number.prototype.toString` for finite numbers, with `-0` written as `0`. The Python oracle implements the same algorithm from `repr()` digits.

**Canonical cell** (`C`):

| Value    | Encoding                                                                       |
| -------- | ------------------------------------------------------------------------------ |
| null     | `∅` (the two bytes 0xC3 0x98 are not used; the literal is `\u0000N`)           |
| string   | `s:` + exact text (no Unicode normalisation)                                   |
| number   | `n:` + canonical number                                                        |
| boolean  | `b:1` / `b:0`                                                                  |
| date     | `d:YYYY-MM-DD`                                                                 |
| datetime | `t:` + ISO UTC with milliseconds (Excel serials are rounded to the ms on read) |
| geometry | `g:` + canonical JSON of the geometry                                          |

**Canonical JSON.** Object keys sorted by UTF-16 code unit, no whitespace, numbers as canonical numbers, strings escaped as `JSON.stringify` does.

**Column digest.** SHA-256 over the concatenation, in view row order, of `len(utf8(C))` in ASCII decimal + `:` + `utf8(C)`.

**View digest.** SHA-256 of `canonicalJson({ rowCount, columns: [{ name, unit, type, sha256 }] })`.

Digests drive export read-back, `.twp` replay verification, the conformance suite and the oracles.

---

## 10. Export validation design

### 10.1 Profiles (destination, not format)

| Profile   | Label in UI                          | Output                                                                                                                                                                                                               |
| --------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `excel`   | Microsoft Excel                      | `.xlsx` with **Data**, **Report** and **Log** sheets (details below)                                                                                                                                                 |
| `csv`     | Databases, Python, R, BI tools (CSV) | UTF-8 without BOM, RFC 4180, comma, CRLF, ISO dates, `.` decimal, canonical numbers, header `Name [unit]`                                                                                                            |
| `geojson` | QGIS / ArcGIS / web maps (GeoJSON)   | RFC 7946 FeatureCollection, lon/lat order, full-precision coordinates, no `crs` member. Built from the geometry column or from latitude/longitude roles. Refused (`TW-EXP-003`, with a fix) if the CRS is not WGS84. |

Excel profile details:

- **Data sheet:** a single header row `Name [unit]`; numbers stored as numbers; real dates (serial + date format); no merges; frozen header at A2; autofilter over the data range.
- **Report sheet:** project, sources with SHA-256, rule-packs, unit registry, conversions, steps, exclusions, assumptions, open issues by severity, and the expected column digests.
- **Log sheet:** the audit log.
- **Substitutions:**
  - more than 1,048,575 data rows → the data is delivered as CSV inside the package, and the workbook keeps Report and Log plus a substitution notice (`TW-EXP-002`, FR-EXP-03);
  - a cell text longer than 32,767 characters (for example a long geometry) → that column is moved to a CSV side file with a notice.
- Workbook creation time is set from the injected clock, never the wall clock, so output is deterministic.

### 10.2 Pipeline

```text
plan (substitutions, refusals)
  → write data file(s) with export writers
  → READ BACK each data file with the product readers (formats/*: a separate code path from the writers),
    re-typed with the manifest's column types
  → compare: open ✓, row count ✓, header names/units ✓, per-column canonical digests ✓, format-specific checks ✓
  → assemble package (README.txt, manifest.json, audit.jsonl, issues.csv, CHECKSUMS.sha256, data files)
  → RE-OPEN the package: every SHA-256 in CHECKSUMS.sha256 matches; the data file inside is re-validated
  → only then: ExportResult{ok}, `export.create` audit entry, download offered
```

On any failure, no package is offered. The validation report is shown, and `TW-EXP-001` is raised with the failing checks.

### 10.3 Read-back check IDs

| ID                   | Check                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RB-OPEN              | The file parses with the product reader                                                                                                                        |
| RB-ROWS              | Row count equals the output view                                                                                                                               |
| RB-HEADER            | Single header row; names, order and units equal                                                                                                                |
| RB-VALUES            | Every column digest equals the view's column digest                                                                                                            |
| RB-CSV-ENCODING      | Valid UTF-8, no BOM, consistent field count                                                                                                                    |
| RB-XLSX-TYPES        | Numeric columns stored as numbers (`t="n"`), date columns have date number formats, no number stored as text                                                   |
| RB-XLSX-STRUCTURE    | Sheets Data/Report/Log present, frozen pane A2, autofilter covers the data, no merged cells in Data                                                            |
| RB-GEOJSON-STRUCTURE | FeatureCollection, feature count, no `crs` member, positions within WGS84 bounds, rings closed with ≥ 4 positions, coordinate order consistent with the source |
| RB-PKG-CHECKSUMS     | Every package entry matches `CHECKSUMS.sha256` (compatible with `sha256sum -c`)                                                                                |
| RB-PKG-CONTENTS      | Manifest validates against its schema; the README lists every source and its checksum, the rule-packs and the open warnings                                    |

`buildExport` accepts injectable writers so fault-injection tests can corrupt one value, truncate a row or drop a sheet. Each of these must fail validation.

### 10.4 Package contents (FR-EXP-07)

`<baseName>-<exportId>.zip`:

- the data file(s);
- `README.txt`: what this is, sources with SHA-256, rule-pack versions, unit registry version, steps in plain language, assumptions, open warnings, substitutions, validation result, how to verify;
- `manifest.json`;
- `audit.jsonl`;
- `issues.csv`;
- `CHECKSUMS.sha256`.

ZIP entries are sorted and use a fixed timestamp (1980-01-01). DEFLATE is pure JavaScript (fflate), so bytes are identical in Node and the browser.

---

## 11. Project file format (`.twp`, format 0.1)

A ZIP container with sorted entries, a fixed entry timestamp and originals STORED (uncompressed):

```text
mimetype                         "application/vnd.tracewell.project+zip"  (first entry, stored)
manifest.json                    format "tracewell-project", formatVersion "0.1", appVersion, projectId, name,
                                 createdAt, savedAt, savedBy, unitSystem, projectArea,
                                 unitRegistry {version, sha256}, rulePacks [{id, version, sha256}],
                                 originals [{fileId, name, size, mediaType, path}],
                                 datasets [{id, name, rowCount, workingDigest, outputDigest}],
                                 auditHead {seq, hash}, entries [{path, size, sha256}]
originals/<sha256>/<file name>   byte-identical originals
audit.jsonl                      the event log (single source of truth), one canonical-JSON entry per line
rulepacks/<id>-<version>.json    exact rule-pack text used
units/registry-<version>.json    exact unit registry text used
README.txt                       how to inspect and verify (sha256sum -c CHECKSUMS.sha256)
CHECKSUMS.sha256                 every entry except itself
```

Working data is **not** stored in slice 1; it is rebuilt by replay. Slice 2 adds Parquet working files (`data/<datasetId>/*.parquet`) as a cache with digests, so large projects open without re-import.

**On open, in order.** Each failure is recorded as an `IntegrityCheck` and an issue:

1. ZIP readable, mimetype and format version supported (TW-PRJ-004).
2. Manifest validates.
3. Every entry's SHA-256 matches the manifest (TW-PRJ-004).
4. Every original's SHA-256 matches its content address (TW-PRJ-001).
5. Audit chain verifies (TW-PRJ-002).
6. Replay of the log succeeds and the dataset digests equal the manifest (TW-PRJ-003).

Any failure opens the project **read-only**, with the reasons shown in an Open report. It is never blocked from opening and never silently repaired. Each save appends a `project.save` entry recording the state digest.

---

## 12. Security and offline design

- **No network code.** The production `index.html` carries:

  ```text
  default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self';
  img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

  The meta tag is injected at build time only, because the development server needs inline styles. The CSP is the technical guarantee.

- **No remote fonts, analytics or update checks.** The system font stack is used. The status bar always shows **Offline** in slice 1.
- **E2E offline guard.** A shared Playwright fixture routes `**/*` and records any request not to `127.0.0.1:4173`. Every test fails if the list is non-empty.
- **Untrusted input handling.**
  - The XML parser (saxes) does no DTD or entity expansion, so it is not open to XML external-entity attacks.
  - The ZIP reader has a decompressed-size cap and an entry-count cap (zip-bomb guard).
  - CSV fields and JSON depth are capped.
  - All parsers run in the worker; the UI never evaluates file content.
- **Formula injection.** The XLSX writer never writes formulas. The CSV README warns that spreadsheet programs may interpret leading `= + - @`. An optional neutralise setting is planned for slice 2.
- **Supply chain.**
  - Exact version pins and a committed lockfile.
  - Few runtime dependencies (11).
  - `scripts/check-licences.mjs` enforces the allow-list on the production dependency tree.
  - A software bill of materials is generated from the lockfile at release (NFR-08).
- **Privacy.** The application stores data only in memory and in files the user saves. Browser storage is used only for UI preferences (theme, density, panel sizes), each access wrapped in try/catch.

---

## 13. Testing strategy

### 13.1 Layers

| Layer               | Tool                                                               | What                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture        | Vitest                                                             | Import allow-list (§6.2); no deep imports; no UI-to-engine imports                                                                                              |
| Unit                | Vitest (Node)                                                      | Every module, with named fixtures; clock and IDs injected                                                                                                       |
| Property            | fast-check                                                         | CSV writer ↔ papaparse and tokenizer ↔ papaparse (differential); XLSX writer → reader digests equal; unit round trips; RowSet algebra; canonical JSON stability |
| Golden              | Vitest                                                             | Each messy fixture: detections, schema, row count and issue counts by rule ID equal its `.expected.json`                                                        |
| Conformance         | Vitest                                                             | Engine-agnostic workflow scenarios over `EngineApi` (runs on LocalEngine now; on the native engine later, unchanged)                                            |
| E2E                 | Playwright 1.56.1, headless Chromium 1194                          | The real production build, the full workflow per format, offline guard, accessibility smoke                                                                     |
| Independent oracles | Python 3.13 (openpyxl 3.1.5, csv, json), LibreOffice 24.2 headless | Exports re-read by independent implementations; digests or values compared                                                                                      |

### 13.2 Messy-file library (`fixtures/messy/`)

Small committed files, each with `<name>.expected.json`. `SHA256SUMS` guards against accidental changes, and `.gitattributes` marks them binary so line endings are preserved.

| Group              | Fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSV/TSV            | `csv_well_daily_golden.csv`, `csv_semicolon_decimalcomma_cp1252.csv`, `csv_utf8_bom_crlf.csv`, `tsv_utf16le_bom.tsv`, `csv_title_rows_units_in_header.csv`, `csv_null_markers.csv`, `csv_quoted_newlines_ragged.csv`, `csv_duplicates_rows_and_keys.csv`, `csv_dates_ambiguous_and_mixed.csv`, `csv_leading_zero_ids_ndl.csv`, `csv_latlon_swapped_out_of_range.csv`, `csv_timeseries_gaps_dups_flatline_spike.csv`, `csv_mixed_units_in_cells.csv`, `csv_pipe_delimited.csv`, `csv_physical_impossible.csv` |
| XLSX               | `xlsx_merged_two_row_header_units.xlsx`, `xlsx_text_and_serial_dates.xlsx`, `xlsx_two_tables_one_sheet.xlsx`, `xlsx_date1904.xlsx`, `xlsx_hidden_sheets_formulas.xlsx`, `xlsx_numbers_as_text.xlsx`. Generated by `make_xlsx_fixtures.py` with openpyxl, then re-saved by LibreOffice headless so formulas carry cached values, which gives two independent producers.                                                                                                                                       |
| GeoJSON            | `geojson_wells_points_wgs84.geojson`, `geojson_legacy_crs_27700.geojson`, `geojson_invalid_geometries.geojson`, `geojson_swapped_lonlat.geojson`, `geojson_mixed_geometry_nested_props.geojson`                                                                                                                                                                                                                                                                                                              |
| Generated in tests | `big_1m_rows.csv` (seeded, `@slow`), `excel_limit_1_1m_rows.csv` (`@slow`), tampered `.twp` variants, broken audit chains                                                                                                                                                                                                                                                                                                                                                                                    |

Every bug found becomes a new fixture (PRD §16).

### 13.3 E2E specs (`tests/e2e/`)

| Spec                                                                   | Covers                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.spec.ts`                                                        | Landmarks, keyboard menu bar, process toolbar states, status bar shows Offline, About shows the owner's name                                       |
| `import-csv.spec.ts`                                                   | Messy windows-1252 semicolon file; assumed badges; delimiter override logged                                                                       |
| `import-xlsx.spec.ts`                                                  | Merged two-row header flattened; additional-table issue; sheet choice                                                                              |
| `import-geojson.spec.ts`                                               | Geometry column; invalid-geometry issues; legacy CRS issue                                                                                         |
| `check-review.spec.ts`                                                 | Rule-ID counts; Save disabled without a reason; Log shows old/new/reason/time; accept; exclude; revert creates a compensating entry; lineage panel |
| `process-extract.spec.ts`                                              | psia → kPa values checked; conversion logged with factor and citation; gauge → absolute refused with a fix; filter changes the row count           |
| `export-excel.spec.ts`, `export-csv.spec.ts`, `export-geojson.spec.ts` | Download the package → Node verifies `CHECKSUMS.sha256` → Python oracle and LibreOffice round trip → in-app report says Validated                  |
| `project-roundtrip.spec.ts`                                            | Save `.twp` → reload page → open → same issues, audit and digests                                                                                  |
| `project-tamper.spec.ts`                                               | Modified original → read-only with TW-PRJ-001; edited audit line → TW-PRJ-002                                                                      |
| `a11y.spec.ts`                                                         | axe: no serious or critical violations on the main screens; keyboard-only golden path                                                              |
| `large-file.spec.ts` (`@slow`)                                         | 1 M-row import timing, grid latency, memory-budget fallback                                                                                        |

The oracle comparisons:

- **Python** reimplements §9.4 (`tests/oracle/canonical.py`). A Vitest test cross-checks it against the TypeScript implementation on 10,000 random values.
- **LibreOffice** round trip (`--convert-to csv`) compares row counts, headers and dates exactly, and numbers within a relative 1e-12, because spreadsheet text output may shorten digits.

### 13.4 One command

From `tracewell/`: `npm ci && npm test`. `scripts/test-all.mjs` runs, failing fast and printing a summary table:

1. hygiene check
2. licence check
3. `tsc --noEmit`
4. `eslint . --max-warnings 0`
5. native (slice 2): `cargo test --release`, then the release build of `crates/tracewell-engine`, so step 6 runs the parity suite against the current binary. `--skip-native` leaves it out on a machine without Rust; the parity suite is then reported as skipped.
6. `vitest run` (architecture, unit, property, golden, conformance)
7. `vite build`
8. `playwright test`, including the oracles. Uses `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and never runs `playwright install`.

`@slow` tests run with `npm run test:slow`.

### 13.5 Definition of done (slice 1)

- `npm test` is green in this container.
- Every fixture matches its expected file.
- Every export profile passes in-app read-back and both independent oracles.
- `.twp` round-trips with identical digests; tampering is detected.
- No off-origin requests.
- Benchmark figures are recorded.
- The slice is labelled **prototype** per PRD §6.

---

## 14. Libraries and licences (slice 1)

Versions verified with `npm view <pkg> version license` on 19 October 2026. Each pin is at least two weeks old, except react-resizable-panels 4.14.2 and lucide-react 1.52.0, which were published on 2 and 4 October 2026, about 15 days before this check; they are kept as the newest stable releases. Pins are exact and the lockfile is committed.

**Runtime (shipped)**

| Package                 | Version                       | Licence | Purpose                                                                                   |
| ----------------------- | ----------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| react                   | 19.3.0                        | MIT     | UI                                                                                        |
| react-dom               | 19.3.0                        | MIT     | UI                                                                                        |
| zustand                 | 5.0.15                        | MIT     | UI store (summaries, selection, layout)                                                   |
| @tanstack/react-virtual | 3.14.13                       | MIT     | Virtualised DOM grid, issues and log lists (ARIA grid; chosen over canvas grids for WCAG) |
| react-resizable-panels  | 4.14.2                        | MIT     | Keyboard-resizable enterprise layout                                                      |
| lucide-react            | 1.52.0                        | ISC     | Icons                                                                                     |
| fflate                  | 0.8.3                         | MIT     | Deterministic ZIP and DEFLATE (XLSX, `.twp`, packages)                                    |
| saxes                   | 6.0.0 (+ xmlchars 2.2.0, MIT) | ISC     | Streaming XML for the XLSX reader; no DTD or entity expansion                             |
| @noble/hashes           | 2.4.0                         | MIT     | Incremental SHA-256 in worker and Node (pure JS, audited)                                 |
| @streamparser/json      | 0.0.26                        | MIT     | Streaming GeoJSON features                                                                |
| zod                     | 4.6.5                         | MIT     | Schemas for manifests, rule-packs, steps, decisions, audit entries                        |

**Development and test only**

| Package                        | Version | Licence                         | Purpose                                                                |
| ------------------------------ | ------- | ------------------------------- | ---------------------------------------------------------------------- |
| typescript                     | 6.0.3   | Apache-2.0                      | Compiler (typescript-eslint 8.71 supports < 6.1)                       |
| vite                           | 8.3.2   | MIT                             | Development server and build (Node ≥ 22.12)                            |
| @vitejs/plugin-react           | 6.1.1   | MIT                             | React transform                                                        |
| vitest                         | 5.0.3   | MIT                             | Unit, golden, property and conformance tests                           |
| @vitest/coverage-v8            | 5.0.3   | MIT                             | Coverage                                                               |
| @playwright/test               | 1.56.1  | Apache-2.0                      | E2E; matches chromium-1194 at /opt/pw-browsers                         |
| @axe-core/playwright           | 4.13.0  | MPL-2.0 (unmodified, test only) | Accessibility smoke test                                               |
| fast-check                     | 4.10.2  | MIT                             | Property tests                                                         |
| papaparse                      | 5.7.0   | MIT                             | Differential test oracle for the CSV tokenizer and writer; not shipped |
| @types/papaparse               | 5.5.2   | MIT                             | Types                                                                  |
| eslint                         | 10.12.0 | MIT                             | Lint                                                                   |
| @eslint/js                     | 10.0.1  | MIT                             | Lint configuration                                                     |
| typescript-eslint              | 8.71.0  | MIT                             | TypeScript lint                                                        |
| eslint-plugin-react-hooks      | 7.1.1   | MIT                             | Hooks lint                                                             |
| globals                        | 17.13.0 | MIT                             | Lint globals                                                           |
| prettier                       | 3.9.9   | MIT                             | Formatting                                                             |
| @types/node                    | 22.20.5 | MIT                             | Node 22 types                                                          |
| @types/react, @types/react-dom | 19.3.0  | MIT                             | Types                                                                  |

**System test oracles (already installed, not distributed).** Python 3.13 with openpyxl 3.1.5 (MIT); LibreOffice 24.2.7 (MPL-2.0, run as an external program).

**Planned for later slices (checked 19 October 2026).**

- npm: maplibre-gl 6.15.0 (BSD-3-Clause), pmtiles 4.5.0 (BSD-3-Clause), proj4 2.22.0 (MIT), hyparquet 1.31.5 (MIT), @tauri-apps/api 2.12.4 (Apache-2.0 OR MIT).
- Rust crates (crates.io): duckdb 1.10506.1, arrow and parquet 60.0.0, calamine 0.37.0, rust_xlsxwriter 0.100.0, zip 9.0.5, sha2 0.11.1. Each is reviewed again at adoption.
- DuckDB's spatial extension needs a licence review first, because it links GEOS (LGPL-2.1).

**Rejected.**

| Package                | Reason                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `xlsx` 0.18.5          | Stale on npm                                                                                                                                 |
| exceljs                | Last release 2023; whole workbook in memory; heavy dependency tree                                                                           |
| jszip                  | Redundant; dual MIT/GPL                                                                                                                      |
| comlink                | The in-house RPC mirrors Tauri invoke/events exactly                                                                                         |
| apache-arrow (slice 1) | Not needed until Parquet and native interop. The column store keeps Arrow-compatible layouts (values + validity), so adoption is mechanical. |
| @duckdb/duckdb-wasm    | See §3                                                                                                                                       |
| canvas data grids      | Weaker WCAG story                                                                                                                            |

**Why in-house CSV and XLSX code.**

- exact source locators;
- the same streaming API in Node and the worker;
- access to merged cells, number formats and the 1904 date system (FR-IMP-05);
- deterministic writer output with frozen header and filter (FR-EXP-02);
- a small software bill of materials.

The risk is controlled by differential and oracle tests.

---

## 15. User interface (slice 1)

Layout follows PRD §11.2 with fixed, resizable regions (docking comes later):

```text
┌ File  Edit  View  Data  Help ─────────────────────────────────────────────────────────────┐
├ [Import] [Check] [Review] [Process] [Extract] [Export]          Rules: generic-dq 0.1.0     ┤
├ PROJECT TREE ─────┬ Tabs: Data | Import | Issues | Export centre ┬ PROPERTIES ─────────────┤
│ Sources (sha256)  │                                              │ Column / cell / issue   │
│ Datasets          │                                              │ detections + lineage    │
│   └ Steps         │                                              │                         │
│ Exports           │                                              │                         │
├───────────────────┴──────────────────────────────────────────────┴─────────────────────────┤
│ ISSUES | LOG | JOBS                                                                         │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ● Offline  Saved 10:42  Rules generic-dq 0.1.0  Units SI  Conventions: not set  12,345 rows  3 assumed │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Menus**

| Menu | Items                                                                          |
| ---- | ------------------------------------------------------------------------------ |
| File | New project, Open project…, Save project, Import file…, Export…, Project area… |
| Edit | Edit cell, Undo last change (revert with reason)                               |
| View | Panels, Light/Dark theme, Compact/Comfortable density                          |
| Data | Run checks, Convert units…, Filter…, Columns…, Exclude rows…                   |
| Help | Keyboard shortcuts, Open-source licences, About Tracewell (owner's name)       |

Other menus from the PRD (Analysis, Map, Reports, Tools) appear when they have content.

**Keyboard.** F10 or Alt focuses the menu bar; F6 cycles regions; Ctrl+O, Ctrl+S, Ctrl+I and Ctrl+E; Enter or F2 edits a cell; Esc cancels.

**Design and accessibility.**

- Design tokens are CSS custom properties: a neutral palette with one accent, and red/amber/green only for status (UI-02).
- Tabular figures in numeric cells (UI-03).
- Light/dark themes and compact/comfortable density (UI-04).
- ARIA roles: `menubar`, `toolbar`, `tree`, `grid`, `tablist`, `dialog`, `status`.
- Every error shows what happened and how to fix it (UI-07), from `EngineError.fix`.

---

## 16. Risks and mitigations

| Risk                                                              | Mitigation                                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript engine memory ceiling disappoints users with big files | Memory budget with partial import and an explicit issue; documented working envelope; `@slow` benchmarks; native engine starts in slice 2, here, headless                                          |
| Protocol shaped only by the TypeScript engine misses native needs | Files by reference, windowed reads, declarative steps and rules, `capabilities` from day one; spike three protocol methods in Rust + DuckDB at the start of slice 2; conformance suite is the gate |
| Double implementation of primitives (TypeScript and SQL)          | Small closed primitive set, each with a defined SQL template; shared fixtures and digests; the TypeScript engine stays as the Lite engine and reference, so the cost buys product value            |
| Bugs in the in-house CSV and XLSX code                            | Differential tests (papaparse), property tests, openpyxl and LibreOffice oracles, fixtures from two XLSX producers, every bug becomes a fixture                                                    |
| Wrong conversion factors                                          | Every factor cited and flagged exact or not; reference tests against NIST SP 811 values; convention and gauge guards refuse unsafe conversions                                                     |
| Determinism traps (time, map ordering, deflate, float formatting) | Injected clock and IDs; fixed ZIP and XLSX timestamps; pure-JS deflate; canonical number encoding; byte-equality tests                                                                             |
| Replay cost on open grows with project size                       | Fine for Lite sizes; slice 2 adds Parquet caches with digests so replay can be verified lazily or by sampling                                                                                      |
| UI scope creep                                                    | Fixed layout; only the tabs listed; docking, command palette and i18n later                                                                                                                        |
| Very fresh dependency versions                                    | Exact pins; lockfile; licence gate; fall back to Vite 7 if build issues appear; TypeScript held at 6.0.x                                                                                           |
| `@streamparser/json` is 0.0.x; saxes is rarely released           | Small surfaces behind adapters; oracle tests; replaceable (JSON.parse fallback for small files; another SAX parser)                                                                                |
| Desktop behaviour untested here                                   | Use only web APIs that WebView2 and WebKitGTK both support; Windows build runner before the desktop release                                                                                        |
| Authorship constraint                                             | Hygiene check in `npm test`; About screen, LICENSE and NOTICE in the owner's name                                                                                                                  |

---

## 17. Roadmap of next slices

| Slice                 | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit evidence                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **1 (this document)** | Core workflow end to end on CSV/TSV, XLSX and GeoJSON in the browser engine; `.twp`; validated export packages                                                                                                                                                                                                                                                                                                                                              | `npm test` green; oracles pass                                            |
| **2**                 | Native headless engine (Rust + DuckDB + Parquet) behind `stdioTransport`; conformance parity on slice 1 scenarios; 10 GB benchmark; Parquet working files and `.twp` caches (FR-IMP-09); recipes `.twr` with "only new or changed issues" (FR-RCP-01..03); autosave/crash recovery journal (OPFS / disk); `.xls`, Parquet and JSON import; Parquet export profile; mapping templates (FR-IMP-06); data health score (FR-VAL-05); CSV formula neutralisation | Parity suite green on both engines; benchmark published                   |
| **3**                 | CRS transformation (PROJ native; proj4 in Lite with documented limits); map view with MapLibre and offline PMTiles; draw-an-area filter; Shapefile, GeoPackage, FlatGeobuf, KML/KMZ; QGIS/ArcGIS and Google Earth profiles; Shapefile rules (FR-EXP-04)                                                                                                                                                                                                     | Spatial reference cases; GDAL read-back                                   |
| **4**                 | Conventions engine (FR-CNV); signed `.twrules` rule-packs with offline install and policy lock; local profiles with roles, Reviewer mode, sign-off stamps, assignment (FR-AUD-03/04); comparison view (FR-AUD-05); time-series resampling (FR-PRC-03); joins and calculated fields (FR-PRC-04)                                                                                                                                                              | Rule-pack signature tests; method reference cases                         |
| **5**                 | Tauri desktop shell on a Windows build runner; installers (per-user, MSI, portable); code signing; software bill of materials; dockable panels, command palette, saved layouts, i18n/RTL; full WCAG 2.2 AA audit; PDF report                                                                                                                                                                                                                                | R0 exit: core suite green, 10 GB benchmark met, messy-file library passes |

---

## 18. Effort estimate (slice 1)

| Milestone                | Content                                                                                                                                             | Person-days                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| M0 Walking skeleton      | Tooling, model, CSV only, six rules, edit with reason, one conversion, filter, CSV and Excel export with read-back, `.twp` save/open, one green E2E | 10–12 (included below)                                      |
| M1 Foundations           | model, io, units (about 60 cited units), geo, audit, engine-api                                                                                     | 8–10                                                        |
| M2 Formats and detection | CSV sniff, tokenizer, writer; XLSX reader with layout heuristics and writer; GeoJSON; detect                                                        | 14–18                                                       |
| M3 Core services         | table, ingest, rules (22 primitives), steps, export with read-back and package, project                                                             | 14–18                                                       |
| M4 Engine                | reducer, jobs, decisions, issue states, lineage, replay, conformance                                                                                | 8–10                                                        |
| M5 UI                    | shell, grid with editing, import preview, issues register, dialogs, export centre, properties, log and jobs                                         | 16–20                                                       |
| M6 Hardening             | E2E suite, oracles, accessibility, benchmarks, documentation                                                                                        | 8–10                                                        |
| **Total**                |                                                                                                                                                     | **68–86 person-days (about 14–17 weeks for one developer)** |

- **With parallel engineers following the build order:** about 5–7 weeks elapsed.
- **With code-generation assistance**, the writing time shrinks substantially. The owner's work does not compress: reviewing behaviour, curating real-world messy files, checking unit citations, wording rule explanations, and judging Excel and GIS output in the target tools. Plan 10–15 owner days.
- **The native engine (slice 2)** is estimated separately at 30–45 person-days to reach parity on the slice 1 scenarios.
