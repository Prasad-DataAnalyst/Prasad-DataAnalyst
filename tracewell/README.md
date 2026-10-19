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

| Command                  | What it does                                                                   |
| ------------------------ | ------------------------------------------------------------------------------ |
| `npm ci`                 | Install the exact pinned dependencies from `package-lock.json`                 |
| `npm test`               | The single command: hygiene, licences, typecheck, lint, unit tests, build, E2E |
| `npm run dev`            | Development server                                                             |
| `npm run build`          | Production build into `dist/` (CSP injected)                                   |
| `npm run preview`        | Serve the build on `http://127.0.0.1:4173`                                     |
| `npm run typecheck`      | `tsc --noEmit` over the whole package                                          |
| `npm run lint`           | ESLint with zero warnings allowed                                              |
| `npm run format`         | Prettier check                                                                 |
| `npm run test:unit`      | Vitest: architecture, unit, property, golden and conformance tests             |
| `npm run test:e2e`       | Playwright against the production build                                        |
| `npm run test:slow`      | The slow suites (1 M-row benchmarks) with `TW_SLOW=1`                          |
| `npm run fixtures`       | Regenerate the messy-file library                                              |
| `npm run check:hygiene`  | Authorship hygiene scan (forbidden names are stored only as SHA-256 hashes)    |
| `npm run check:licences` | Licence allow-list over the shipped dependency tree                            |

`node scripts/test-all.mjs --skip-e2e` runs every stage except Playwright.

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
```

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
