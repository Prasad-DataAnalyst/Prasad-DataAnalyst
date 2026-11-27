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
| Build container: Linux, 4 CPU, 15 GB RAM, no display, Node 22.22, npm 10.9, Rust 1.97, Python 3.13, Chromium 1194 for Playwright at `/opt/pw-browsers` (a container with a newer build is used through its stable `chromium_headless_shell` link; the suite never downloads browsers), no webkit2gtk | Slice 1 is a web build tested headless. The Tauri desktop shell cannot be built here and comes later. A native engine _can_ be built and tested here headless (slice 2). |
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

- Protocol 0.2 adds an optional `preview` field to `importFile`: the `ImportPreview` the user reviewed. The TypeScript engine plans again (same input, same result); the native engine imports exactly that plan. (Protocol 0.3 adds `getHealth`, section 7.7; protocol 0.4 adds mapping templates, section 7.3; protocol 0.7 adds `listCrs`, section 3.4; protocol 0.8 adds `getPlaces`, section 7.6; protocol 0.9 adds `getDensity` and a box for `getPlaces`, section 7.6.)
- A file given by path is previewed through a source that reads only the ranges asked for (`FileSystem.open`), so planning never loads a large file.
- Sniffing reads at most 1 MiB, so planning in TypeScript costs the same for a 10 GB file as for a small one. In the desktop edition the planner answers `sniff` and the native engine answers everything that touches the full file.
- What _is_ ported to Rust is what executes a plan: the CSV reader (line skipping, the RFC 4180 tokenizer with its tolerances, header assembly and ragged-row shaping, so rows, physical-line locators and import notes come out the same) and the cell parser (numbers with locale separators, null markers, the date families, booleans). Both are checked against the TypeScript code by the conformance suite over the whole messy-file library.
- The check primitives run in the native engine as SQL over the working view (SAD section 8.3). The two windowed series checks, flatline runs and the Hampel spike test, stream the ordered series from DuckDB through Rust, because a sliding median over millions of short frames is slow in SQL. Rule packs, the unit registry and the quantity table (`src/units/quantities-2026.1.json`) are the same JSON files in both engines, so a pack's SHA-256 names the same rules whichever engine ran them.

**Consequences.** Both engines write identical `source.add` payloads for the same file and plan, so their audit logs mean the same thing. Parity work moves to execution: reading every format under a plan, check primitives as SQL, steps as SQL views, and exports.

**Revised for engine parity (delimited text).** Connecting the user interface to the native engine (section 17) needs that engine to answer `sniff` itself, or the desktop edition would carry two engines. Detection for CSV and TSV is therefore ported to Rust (`detect.rs` and `sniff.rs` in the crate), with the TypeScript code as the reference. Every evidence text, confidence and tie-break is the same, and lengths are counted in UTF-16 code units and white space matched as JavaScript does.

- **Parity checks.** The conformance suite compares the two previews over:
  - the messy-file library;
  - generated files longer than the 1 MiB sample, with ragged rows, a quoted field open at the cut, and a character cut in two;
  - title blocks, units rows, single quotes and windows-1252 bytes;
  - settings chosen by the user, including invalid ones, which both refuse with the same message;
  - mapping templates that rename, retype, re-unit and re-role columns.

  A one-off differential run over 302 generated variants of the library, each with 13 sets of settings, found no differences.
- **Imports plan themselves.** The native engine now plans an import again from the file, as the TypeScript engine does, so a preview sent with `importFile` is no longer needed. A mapping template is applied by the engine's own choice, never trusted from a preview.
- **Overrides.** The native engine records changed import settings, column overrides and a template's changes as `detection.override` decisions, after the import and in the same order as the TypeScript engine. It takes later override decisions and their reverts the same way (section 7.3). It refuses two overrides the TypeScript engine accepts without being able to show the result consistently: a type change that alters how a column with cell edits is stored, and an override that would break a step built on the column.
- **Parquet (native).** The native engine reads Parquet through DuckDB and makes each value the raw field the TypeScript reader makes of it: native numbers, booleans, dates and timestamps keep their types, so native detection and parsing take typed fields as the TypeScript ones do, not only text. The footer gives the columns and the row count; the file's own row number is each row's locator (`row 12, column "rate"`). Two known differences remain. A nanosecond timestamp adjusted to UTC keeps only microseconds, because DuckDB holds such instants to the microsecond. Lists, maps and structs become JSON text written from DuckDB's JSON of them, so a map may be written differently from the TypeScript reader's object.
- **JSON (native).** The native engine reads JSON and JSON Lines with its own streaming reader rather than DuckDB's, which infers types and orders keys by its own rules. It decides the layout from the head of the file as the TypeScript reader does and makes each value the same raw field: numbers, booleans and nulls keep their types, and nested objects and arrays become JSON text written as `JSON.stringify` writes them. Keys come in the order JavaScript gives an object's keys: keys that are array indices (such as `"2"`) first in ascending order, then the rest as first seen; a repeated key keeps its first place and its last value. Records stream one at a time, so memory is bounded by the largest record, and each row's locator is its record or, for JSON Lines, its line (`record 12, key "rate"`). One known difference remains: why a parser stopped on broken JSON is worded by the parser, and the TypeScript engine's wording differs between browsers. Both engines refuse such a file with the same code, line or record count and fix; only that reason is their own.
- **Excel (native).** The native engine reads .xlsx and legacy .xls workbooks with a port of the TypeScript reader (`xlsx.rs`) rather than a library such as `calamine`, because layout detection (blocks, titles, multi-row headers, units rows), the cell conversions (number formats, serial dates in both date systems, ISO date cells, errors, cached formula results) and every refusal must match it. It reads a workbook in memory, as the TypeScript reader does, with the same caps on an .xlsx package (10,000 entries and 512 MiB expanded) and the same bounds on a compound file's sectors and chains; its XML tokenizer expands only the predefined entities and character references and refuses a document type declaration. A chosen sheet or table is recorded as an override and read again as in the TypeScript engine. One known difference remains: why an XML parser stopped on a part that is not well-formed is worded by the parser, so both engines refuse such a workbook with the same code, part and fix, but their own reason.
- **GeoJSON (native).** The native engine reads GeoJSON with a port of the TypeScript reader (`geojson.rs`): a FeatureCollection streamed a feature at a time, a single Feature or a bare Geometry, with the property keys, the nested properties, the geometry types and the CRS (a legacy `crs` member, else the RFC 7946 default) detected from the head of the file as the TypeScript reader does. Property values are the same raw fields as a JSON record's. A feature's geometry, valid or not, is held as the JSON text `JSON.stringify` writes for it, with its members in the order the file has them; a number past what a double holds is null in it, and -0 is 0, in both engines, so what is shown, exported, saved and hashed is the value itself. The geometry tests (validity, ranges, the swap heuristic, boxes) are a port of `src/geo` (`geo.rs`) and run inside DuckDB as scalar functions (`geofn.rs`), so the spatial checks, the area filter and a geometry column's statistics are SQL beside every other condition. One known difference remains, as for JSON: why a parser stopped on broken JSON is worded by the parser.
- **Rechecks (native).** A decision on a checked dataset re-runs the checks before it returns, as in the TypeScript engine, but the native engine re-runs only the checks the decision can change, from what each kind of check reads: a cell edit changes its column and every column computed from it (converted, or transformed with the other coordinate), so a check of single columns runs again on those, a check of the whole table (duplicate rows) runs again, a series check runs again in full when the edit changes a series' time or ID, and checks that read only the schema or the import's notes do not run. A change of the project area re-runs the two checks that read it. Every other result of the last run stands. That is exact because each change to a checked dataset ends with a run of one kind or the other, so the issues present are always what a full run gives; a check kind whose inputs the engine does not know runs in full. Other decisions (exclusions, steps, overrides) run every check. On 5 million rows a pressure edit takes 3.1 s instead of 8.3 s and a project area 0.06 s instead of 8.1 s (see the benchmarks).
- **Scope.** Every format and every export profile of the TypeScript engine is native.
- **Cost.** This revision accepts the divergence risk this decision first avoided; the parity checks above are how it is held.

### 3.2 Decision D-13 (slice 2): one project file, with optional caches

**Context.** A project is rebuilt by replaying its audit log over its original files (section 11). For a 10 GB file that means importing it again on every open, minutes of work. Section 4.3 left open whether large projects should be a stored ZIP64 `.twp` or a project folder exported to `.twp`; NFR-11 budgets disk at 3× the data size, and FR-PRJ-02 asks for a single portable file.

**Decision.** The `.twp` stays one ZIP file for every size: entries STORED where they are large, ZIP64 fields past 4 GiB, so any ZIP tool opens it. A project folder exists only as the engine's working folder, never as a second exchange format. Format 0.2 adds optional caches per dataset, each tied to the `source.add` entry whose result it holds: `data/<id>/rows.parquet` (the typed values with their row IDs), `data/<id>/exceptions.parquet` (the source text of values that did not parse) and `data/<id>/notes.json` (what the reader noticed in the file). A checked dataset also gets `data/<id>/issues.json`: its issues, with their rows, accepted rows and comments, as they stood after the last entry that could change them (one of the dataset's own entries, or a change of the project area), named by `afterSeq`. They are listed in the manifest's `caches` and checksummed like every entry.

- **Caches never decide what the data is.** The audit log does. A reader that does not use caches (the TypeScript engine) verifies their checksums and replays from the originals; one that uses them still verifies their checksums, the audit chain and the dataset digests after replay, and any failure opens the project read-only.
- **Both engines read both.** The TypeScript engine reads format 0.1 and 0.2 and writes 0.1; the native engine writes 0.2 with caches. The conformance suite opens a native-saved project in the TypeScript engine, which rebuilds every dataset from the originals and must match every digest the native engine recorded.
- **Disk.** A saved 10 GB project holds the original (10 GB) and its caches (1.6 GB: 1.5 GB of working Parquet and 124 MB of check results); with the working folder that stays within 3× the data size (docs/benchmarks.md).
- **Check results (revised after the 10 GB benchmark).** The first version cached only what importing gave and ran the recorded checks again on open. On the 10 GB benchmark that was about 405 of the 605 seconds the open took, with the same memory and disk spill as the original checks. The issues cache now stands in for every entry up to the one it follows, as far as the dataset's issues go: check runs, re-checks after exclusions, acceptances and comments. Those entries' other effects, such as which rows are excluded, still replay. The checks still run again when the cache is missing, damaged or does not read back whole, and the conformance suite checks that they then raise the same issues. The cache cannot hold the results of rules the engine no longer has: a rule's results change only with its pack's version, and a check run recorded with packs other than the built-in ones stops the replay.

**Rejected.** A project folder (data and originals side by side) is faster to update in place but is not one portable file, and two formats would need two sets of integrity rules.

### 3.3 Decision D-14 (slice 2): the page reaches the native engine through its container

**Context.** The same UI build must drive the native engine: in the desktop edition, and before that in end-to-end tests of the native engine. Section 4.3 planned a development-only loopback bridge. A loopback network connection would put network code in the page and need a CSP that allows connecting to it, which section 12 rules out: the lint rules ban every network API in application code, and the production CSP limits `connect-src` to the page's own origin. The end-to-end suite must also keep running against the production build, CSP included.

**Decision.** The page asks its container for an engine. When the container defines `window.__tracewellHost`, an `EngineHost` with `open`, `write` and `read`, the app opens one engine session per page load and speaks the native engine's stdio framing over it (`hostTransport` in `engine-api`). Otherwise it starts the Lite engine in its worker. The container runs the native engine as a process and carries the bytes of its pipe.

- **Containers.** The Playwright harness (`tests/e2e/native-host.ts`) provides the host through page bindings. Each page load starts a new engine process and kills the previous one, as closing the app would, so recovery journals behave as after a crash. The desktop shell (phase D) will provide the same object over its own IPC.
- **Files.** A file the user picks in the page is a Blob, which exists only inside the page, so the transport sends its bytes. The desktop shell's file dialogs will pass paths instead.
- **Edition.** The shell names the edition by the engine it got: the native engine is the desktop edition's.
- **Testing.** The Playwright suite runs twice on the same production build: the `chromium` project with the Lite engine, and the `native` project with the native engine for every test not tagged `@lite`. Those tagged use what only the Lite engine has: the lowered-budget import. The conformance suite also runs every scenario through the host transport.

**Consequences.** There is no network code and no CSP change. The production bundle carries the bridge's client, a few dozen lines that stay inert unless a container provides a host. Under the CSP a page script cannot provide one: there are no inline or foreign scripts, so only the container can.

**Rejected.** A WebSocket from the page to the engine on 127.0.0.1: network code in the page, a CSP exception, and a separate build for the tests.

### 3.4 Decision D-15 (slice 3): coordinates are transformed by one exact implementation in both engines

**Context.** FR-PRC-02 asks for coordinate transformation with EPSG codes, every transformation logged, and section 17 planned PROJ in the native engine and proj4 in Lite. But both engines replay steps from the log and compare what they hold by digest (section 9.4): a project saved by one engine is replayed by the other, and the parity suite compares every value. Two libraries, and even one formula run on two platforms' `Math.sin`, give coordinates that differ in the last binary digit, so digests would differ and a replay would not verify.

**Decision.** Both engines transform coordinates with the same code, written twice: `src/geo/crs` in TypeScript and `geodesy.rs` in Rust, the same expressions in the same order.

- **Arithmetic.** The elementary functions (sin, cos, tan, atan, atan2, asin, log, exp, log1p, expm1, the hyperbolic functions and their inverses, powers) are built from IEEE 754 operations only (`+ - * /`, the square root, comparisons and the bits of a double), with the algorithms and constants of the FreeBSD fdlibm library. Neither language fuses a multiply and an add, so the same expressions give the same bits, in every browser and on every platform. They agree with the platforms' functions to 3 units in the last place.
- **Methods.** The formulas of IOGP Geomatics Guidance Note 7-2 (September 2019): geographic/geocentric conversion (method 9602), the Helmert transformations (geocentric translations, position vector, coordinate frame: 9603, 9606, 9607, reversed by changing every sign as the EPSG Dataset does), Transverse Mercator with the JHS formulas (9807) and Lambert Conic Conformal (9801, 9802). A change of datum goes through WGS 84 at zero ellipsoidal height.
- **Registry.** `src/geo/crs/registry.json` (version 2026.2, which added the ESRI name of each system, datum and ellipsoid for the Shapefile `.prj`), read by both engines, holds a curated part of the EPSG Dataset with each value checked against the published dataset: the WGS 84, ETRS89, RGF93, NAD83, GDA94, ED50, OSGB36 and NAD27 datums with their ellipsoids and their EPSG transformations to WGS 84 (with the stated accuracy and area of use), the UTM zones on those datums, British National Grid and Lambert-93. A system outside it is refused with its code.
- **Tests.** The methods reproduce the guidance note's worked examples: to every printed digit of its intermediate values, and to its printed eastings, northings and geocentric coordinates within 1 cm (some of those finals are a few millimetres off the note's own intermediates). Round trips close to under a millimetre within a datum and to a few centimetres across one. `src/geo/crs/__fixtures__/crs-vectors.json` holds the exact bits of each function over its domain and of 14 pairs of systems; the TypeScript tests and the native engine's tests both reproduce every bit.

- **The step.** `transform_crs` (`{ kind: 'transform_crs', toCrs }`) is a working step, like a unit conversion, so the checks see its result. It reads the dataset's geometry column, or else its numeric longitude and latitude columns (easting and northing for a projected system), and replaces each with a transformed column (`<column>~<code>`, its `derivedFrom` naming the source and the step); a change between geographic and projected renames the columns (Longitude, Latitude, Easting, Northing) and sets their role, unit (none or `m`) and quantity. A geometry is transformed position by position: a third ordinate such as a height is kept, a `bbox` member is dropped because it no longer bounds the geometry, and a geometry with a position the transformation cannot place becomes no geometry, as a point does. The working and output views then carry the target CRS (method `transform`, evidence naming the step) and the new geometry column, so the CRS checks, the export profiles and the manifests see the transformed data: British National Grid data transformed to WGS 84 can be exported as GeoJSON. The step is refused, with the reason and a fix, when the CRS is not known, when the data is already in the target, when either system is outside the registry, and when there is no geometry column and no numeric coordinate pair. Because conversions and transformations run before every filter and selection, any step whose views would not build is refused, in the preview, when applied and in a recipe plan: a transformation or replacing conversion added after a filter or selection that reads the column it replaces would leave that step without its column. The `step.apply` entry's payload records the transformation: from, to, every operation (the projection reversed, the datum transformations with their EPSG codes, methods and accuracies, the projection applied), the summed accuracy, the registry version and its source; the description names them, for example "Transform coordinates from EPSG:27700 (OSGB36 / British National Grid) to EPSG:4326 (WGS 84), through OSGB36 to WGS 84 (6) (EPSG:1314), accurate to 2 m". An edit of either source coordinate changes both transformed ones, and the native engine's partial re-check (section 3.1, Rechecks) re-runs the checks of both. The native engine computes the transformed columns in SQL with two scalar functions over `geodesy.rs`, `tw_crs_transform` for a coordinate pair and `tw_crs_geometry` for a geometry's JSON text. `listCrs` (protocol 0.7) lists the registry's systems for the Data › Transform coordinates… dialog, which previews the description and the first rows before and after.

**Consequences.** No geodesy dependency in either engine, and no grid files: transformations that need a grid (NTv2, NADCON) are not available, and each datum has one transformation to WGS 84, its EPSG default for the region; the log records which, with its accuracy. The registry grows by adding entries, each checked against the EPSG Dataset.

**Rejected.** PROJ in the native engine with proj4 in Lite, as first planned: results differ between them in the last digits, and proj4 follows the browser's `Math` functions, which differ between browsers. A grid-based transformation can be added later as a recorded result rather than a replayed computation, if it is ever needed.

---

### 3.5 Decision D-16 (slice 3): GeoPackage on an SQLite file format writer and reader of our own

**Context.** FR-IMP-02 and the GIS export profiles need GeoPackage (OGC 12-128), which is an SQLite database. The Lite engine runs in a browser worker, where SQLite exists only as a WebAssembly build of about a megabyte; the native engine could link SQLite. Two SQLite libraries lay out a database differently, so the two engines would write different bytes, and the parity suite compares every exported file byte for byte (section 13). DuckDB reads SQLite only through an extension it downloads, which the offline rule forbids.

**Decision.** Both engines write and read the SQLite file format (sqlite.org/fileformat.html) with code of their own: `src/formats/geopackage/sqlite.ts` and `sqlite.rs`, the same layout in the same order, as the FlatGeobuf, XLSX and Shapefile writers are.

- **Writer.** A bulk load: 4096-byte pages, each table's rows in rowid order packed into leaf pages as they come, interior pages built level by level above them, records past a page's share spilled to overflow pages by the format's rules, and the schema table on page 1, built last (when it does not fit there, page 1 becomes an interior page over leaves, as SQLite itself deepens it). Pages are numbered in the order they are finished, which is the order they are written, so the native writer streams a dataset of any size to the file and holds only one leaf and a list of finished pages. The automatic indexes that UNIQUE and PRIMARY KEY constraints imply are written too, so SQLite's own checks pass. Integers take the fewest bytes, as SQLite chooses them.
- **Reader.** Any database of the format, by SQLite or by us: any page size, reserved bytes, UTF-8 and UTF-16 text, interior pages, overflow chains, rows deleted in place, integers in REAL columns read as reals as SQLite reads them, and the columns and rowid alias of each table from its CREATE TABLE statement. Every page number and offset it follows is checked, and a page visited twice or a tree deeper than any valid one is refused, so a damaged or hostile file is refused rather than looped over. The native reader reads one page at a time from the file.
- **Tests.** Python's sqlite3 module (SQLite 3.53 here) is the oracle: every database the writer makes in the unit tests passes `PRAGMA integrity_check` and reads back as written, across deep trees, overflow, negative and 64-bit rowids, an automatic index and a sweep of schema sizes around the edge of page 1; and databases SQLite writes (page sizes 512 to 65,536, UTF-8, UTF-16LE and UTF-16BE, deleted rows) read as SQLite reads them. Each GeoPackage export is also checked by SQLite's integrity and foreign key checks in the browser tests.

**Consequences.** No new dependency and no WebAssembly in either engine; the GeoPackage export is the same bytes in both engines but for the time of the export. The writer writes only what a GeoPackage needs: tables, automatic indexes of one page, no free pages, no views, triggers or R-tree spatial index (QGIS and GDAL build one when asked). The reader reads tables; it does not run SQL. It also serves the GeoPackage import (section 6.3), which is checked against two GeoPackages that SQLite itself wrote.

**Rejected.** SQLite compiled to WebAssembly in Lite with the SQLite library in the native engine: a megabyte more for the browser, and two layouts that the parity suite could compare only by their contents. Reading GeoPackage through DuckDB's spatial or SQLite extension: downloaded at run time.

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

1. Steps (unit conversion, coordinate transformation, filter, column selection) and rules (check primitives) are **declarative JSON**, so each engine translates them natively (TypeScript functions or SQL).
2. Every engine maintains the same **audit log format**, the same **canonical value encoding** and the same **digests** (§9.4), so outputs can be compared bit for bit.
3. Engines report `capabilities` (formats, memory budget, spill, CRS transform). The UI adapts to them rather than assuming.
4. Protocol versions follow semantic versioning. A major mismatch is refused with a clear message.
5. Every engine gives the **members of an answer in the same order**. The order shows wherever an answer is written out as JSON text (a geometry in the grid, an old or new value in the log, the Log sheet of an export) or listed member by member (how a file is read), so it is part of the contract, and the parity suite compares it for every kind of answer.

### 4.3 Path to 10 GB+ (G4, NFR-03, NFR-04)

| Phase                                  | Where                                                           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: contract hardening (slice 2)        | this container                                                  | Freeze protocol 0.x. Add `stdioTransport` (JSON lines plus binary frames). Grow `tests/conformance` so every scenario is fixture → expected issues and digests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B: headless native engine (slices 2–3) | this container (Rust 1.97 works; only the GUI shell is missing) | Crate `crates/tracewell-engine` on `duckdb` (bundled DuckDB 1.5) with its Arrow appender. Import (decision D-12) runs three stages at once: a reader thread hashes, decodes and tokenizes the file exactly as the TypeScript reader does; worker threads parse row slices into typed Arrow batches; an appender writes them to a staging database. Typed values go to the rows table, and the source text of every failed parse or matched null marker to a side table of exceptions, so no raw value is lost and the rows table stays narrow. Both become Parquet working files (FR-IMP-09). DuckDB `memory_limit` and `temp_directory` give spill-to-disk (NFR-04). Each check primitive has one SQL template (§8.3). Projects are saved and opened natively in the same `.twp` container, with the working Parquet files as caches (decision D-13). The overlay is a table of edits per edited column, joined into the dataset's views, and steps are SQL views: conversions as computed columns, filters as one `WHERE` (section 8.1). Workbooks are read by a port of the TypeScript reader rather than `calamine`, so layout detection and every cell conversion match it (decision D-12). Excel exports are written by a port of the TypeScript writer that streams the Data sheet's rows to disk. The conformance suite runs against it over stdio, and the Playwright suite through the host bridge (decision D-14). |
| C: 10 GB benchmark (slice 2)           | this container, then the reference laptop                       | `fixtures/generators/gen-large-csv.mjs` writes a seeded 10 GB CSV (124 million rows). Import → check → export is measured under `memory_limit` = 50% of RAM, and results are published in `docs/benchmarks.md` (14 minutes on 4 cores, peak 7.19 GiB against a 7.86 GiB budget). The budget covers the whole engine process: DuckDB gets it less a reserve (a quarter, at least 512 MiB) for memory DuckDB does not count, the C allocator is limited to two arenas, and each finished job returns freed memory to the system. Large projects need a decision record on `.twp` layout (stored ZIP64 versus a project folder exported to `.twp`), because NFR-11 budgets disk at 3× the data size.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D: desktop shell (later)               | a Windows build runner with WebView2                            | Tauri 2 loads the same UI build. `tauriTransport` uses commands and events. Native file dialogs pass paths. GDAL and PROJ are linked natively. A crash-recovery journal is kept on disk (FR-PRJ-03 becomes "replay the journal").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
        ├─ steps   (convert_unit, transform_crs, filter, select_columns → View)
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
├── playwright.config.ts    # chromium with the Lite engine and with the native one (D-14), browsers from /opt/pw-browsers, webServer = build + preview on 127.0.0.1:4173
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
│   ├── formats/xlsx/       # XLSX reader (ZIP + SAX), legacy .xls reader (OLE + BIFF8), layout detection, writer
│   ├── formats/geojson/    # streaming GeoJSON reader, writer
│   ├── formats/kml/        # KML 2.2 writer, reader and KML/KMZ importer (Google Earth)
│   ├── formats/flatgeobuf/ # FlatGeobuf writer, reader and importer on a FlatBuffers builder and reader of its own
│   ├── formats/geopackage/ # GeoPackage writer and reader on an SQLite file format writer and reader of its own (D-16)
│   ├── formats/shapefile/  # importer of a zipped Shapefile (.shp, .dbf, .prj, .cpg)
│   ├── formats/json/       # streaming JSON records reader (array, JSON Lines, wrapped API response)
│   ├── formats/parquet/    # Parquet writer, read-back reader, row-group importer
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
│   ├── generators/         # make_xlsx_fixtures.py (openpyxl, then LibreOffice re-save), make_gpkg_fixtures.py (SQLite), gen-text-fixtures.mjs, gen-large-csv.mjs
│   └── index.ts            # fixtureBytes(), fixtureSource(), fixtureExpectation()
├── tests/
│   ├── architecture/       # boundaries.test.ts (import allow-list)
│   ├── conformance/        # engine-agnostic workflow scenarios over EngineApi
│   ├── e2e/                # Playwright specs and shared offline-guard fixture
│   └── oracle/             # canonical.py, check_csv.py, check_xlsx.py, check_geojson.py, check_geopackage.py, check_package.py, lo_roundtrip.sh
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

| Order | Module          | Path                                                  | Depends on                                                                                |
| ----- | --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 0     | tooling         | `tracewell/` (configs, scripts, `tests/architecture`) | none                                                                                      |
| 0     | model           | `src/model`                                           | zod                                                                                       |
| 1     | io              | `src/io`                                              | model, fflate, @noble/hashes                                                              |
| 1     | units           | `src/units`                                           | model                                                                                     |
| 1     | geo             | `src/geo`                                             | model                                                                                     |
| 1     | engine-api      | `src/engine-api`                                      | model                                                                                     |
| 1     | fixtures        | `fixtures/`                                           | model, io                                                                                 |
| 2     | formats-csv     | `src/formats/csv`                                     | model, io                                                                                 |
| 2     | formats-xlsx    | `src/formats/xlsx`                                    | model, io, saxes                                                                          |
| 2     | formats-geojson | `src/formats/geojson`                                 | model, io, @streamparser/json                                                             |
| 2     | formats-kml     | `src/formats/kml`                                     | model, io, saxes                                                                          |
| 2     | formats-flatgeobuf | `src/formats/flatgeobuf`                           | model                                                                                     |
| 2     | formats-geopackage | `src/formats/geopackage`                           | model                                                                                     |
| 2     | formats-shapefile  | `src/formats/shapefile`                            | model, io, geo                                                                            |
| 2     | formats-json    | `src/formats/json`                                    | model, io, @streamparser/json                                                             |
| 2     | formats-parquet | `src/formats/parquet`                                 | model, hyparquet, hyparquet-writer                                                        |
| 2     | detect          | `src/detect`                                          | model, units                                                                              |
| 2     | table           | `src/table`                                           | model, io                                                                                 |
| 2     | audit           | `src/audit`                                           | model, io                                                                                 |
| 2     | ui-shell        | `src/ui-shell`                                        | model, engine-api, react, zustand, react-resizable-panels, lucide-react                   |
| 3     | ingest          | `src/ingest`                                          | model, io, detect, table, formats-csv, formats-xlsx, formats-geojson, formats-json, formats-parquet, formats-flatgeobuf, formats-kml, formats-shapefile |
| 3     | rules           | `src/rules`                                           | model, io, table, units, geo                                                              |
| 3     | steps           | `src/steps`                                           | model, table, units, geo                                                                  |
| 3     | export          | `src/export`                                          | model, io, table, units, geo, formats-csv, formats-xlsx, formats-geojson, formats-kml, formats-flatgeobuf, formats-geopackage, formats-parquet |
| 3     | project         | `src/project`                                         | model, io                                                                                 |
| 3     | ui-views        | `src/ui-views`                                        | model, engine-api, ui-shell, @tanstack/react-virtual, maplibre-gl, pmtiles                |
| 4     | engine          | `src/engine`                                          | model, io, units, geo, engine-api, table, audit, ingest, rules, steps, export, project    |
| 5     | app             | `src/app`, `index.html`                               | model, engine-api, ui-shell, ui-views, engine                                             |
| 5     | conformance     | `tests/conformance`                                   | model, io, engine-api, engine, export, fixtures                                           |
| 6     | e2e             | `tests/e2e`, `tests/oracle`, `playwright.config.ts`   | app (built), fixtures                                                                     |

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
| formats-*   | One adapter per format: sniff (≤ 1 MiB), read as batches of raw rows with exact source locators, write. CSV, GeoJSON and JSON stream; Parquet reads one row group at a time through ranged reads; XLSX reads a ZIP in memory under a size guard, and a legacy .xls its OLE compound file. KML (slice 3) writes and reads KML 2.2 for the Google Earth profile and imports KML and KMZ. FlatGeobuf (slice 3) writes FlatGeobuf 3 for its profile and reads it for read-back and as an import format, on a FlatBuffers builder and reader of its own: the import streams the features (the spatial index is skipped), the sniff reads the header and the features of the MiB after the index, and the CRS is the EPSG code the header records. |
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
| ui-views    | Data grid with editing and reason flow, import preview with detections and overrides, issues register with drill-down, Convert, Transform, Filter and Columns dialogs, map view, export centre, properties content (column metadata, cell lineage), log view, jobs view, project open report. |
| app         | Bootstraps the worker engine, profile setup on first start, mounts the shell with views.                                                                                                                                                                                 |
| conformance | Engine-agnostic workflow scenarios that every engine must pass.                                                                                                                                                                                                          |
| e2e         | Playwright specs, the offline guard, independent oracle readers in Python and LibreOffice.                                                                                                                                                                               |

The exact exported signatures are listed in the implementation plan that accompanies this document. The type definitions in `src/model` are normative.

**Legacy Excel import (slice 2, FR-IMP-01).** An Excel 97-2003 workbook (.xls) is an OLE compound file (MS-CFB) whose `Workbook` stream holds BIFF8 records. The reader turns it into the same workbook model as XLSX (sheets with their visibility, the 1904 date system, cells with their number formats and dates, merged ranges, frozen panes, cached formula results), so layout detection, the importer and every check treat both alike, and the original is kept byte for byte with the media type `application/vnd.ms-excel`. Every sector number is checked, every chain is bounded by the size of the file, and a string cut off by the end of its record is refused, so a damaged or hostile file ends in an error, never in a loop. Excel 5.0/95 workbooks, encrypted workbooks and other Office documents are refused with what they are and how to save them as .xlsx. The test files are XLSX fixtures saved by LibreOffice as .xls, and both readers must give the same sheets, values and merged ranges.

**JSON and Parquet import (slice 2, FR-IMP-01).** Format detection reads content first: the `PAR1` marker is Parquet; JSON whose top-level object has a GeoJSON `type` (or a `.geojson` file) is GeoJSON; other JSON is tabular. The JSON reader decides the layout from the head of the file: an array of objects, one object per line (JSON Lines, NDJSON), or an object whose first member holding an array of objects has the rows (a saved API response; its other members are not imported, which the layout detection says). Keys become columns in first-seen order, nested objects and arrays are kept as JSON text, a missing key is a null, and numbers beyond the double range stay visible as text. Records stream one at a time, so memory is bounded by the largest record; a record that is not an object, or a JSON Lines line that is not JSON, stops the import with its record or line number. The Parquet reader takes the columns and the exact row count from the footer and reads one row group at a time through ranged reads, so the browser edition never holds more than one row group. Stored types are kept (dates, UTC timestamps, integers, booleans); what no cell value holds exactly (an integer beyond 2^53, a timestamp finer than a millisecond) is kept as text rather than rounded, nested columns become JSON text, and binary values hexadecimal text. GeoParquet geometry columns are read as binary for now. The native engine reads both formats with the same rules (decision D-12): Parquet through DuckDB, JSON with its own streaming reader.

**KML and KMZ import (slice 3, FR-IMP-02).** XML whose root element is `kml` is KML, and so is a ZIP archive whose first entry is a `.kml` document, or a `.kmz` that holds no workbook (KMZ); the KMZ's document is its first `.kml` entry at the root, conventionally `doc.kml`, else its first `.kml` anywhere. The document is decoded as its byte-order mark or XML declaration says: UTF-8 by default, UTF-16, and ISO-8859-1 or windows-1252 (read as windows-1252); another declared encoding is refused with the fix to save it as UTF-8, and so is a document type, as XML parsing never expands one. Each Placemark, at any depth, is a row located as `placemark <n>` (0-based). Its fields are keys in first-seen order over the file, as for GeoJSON: `folder` (the names of the Folders around it, outermost first, joined by ` / `), `name`, `description`, `timestamp` (TimeStamp), `begin` and `end` (TimeSpan), and each ExtendedData `Data` value and `SchemaData`/`SimpleData` by its name, all as text exactly as the file holds it, for detection to type. Its first geometry goes to the `geometry` column: Point, LineString, Polygon (outer boundary first), a lone LinearRing as a LineString, and MultiGeometry as a multi-part geometry when its members are all of one kind, otherwise a GeometryCollection; positions are longitude, latitude and altitude, and a coordinate that is not a number or not finite becomes null for the validity check to report. The CRS is `OGC:CRS84` (`kml-specification`, `high`), which the KML specification fixes. Styles, tracks and models are not read. The TypeScript reader streams a KML file through saxes and reads a KMZ in memory; the native engine reads the document whole with its own XML parser, so both cap a document at 512 MiB. The sniff reads the document's first MiB, and what that cuts off is left unread, not refused, in both engines. Both give the same rows, detections and messages.

**Shapefile import (slice 3, FR-IMP-02).** A Shapefile is several files, and a file import takes one, so a Shapefile is imported as a ZIP archive holding it: a ZIP whose local headers in the first 64 KiB name a `.shp`, `.shx`, `.dbf`, `.prj` or `.cpg` is a zipped Shapefile, and a bare `.shp` (the file code 9994) is recognised and refused with the fix to zip its files together. The `.shp` is the archive's first at the root, else its first anywhere, and its `.dbf`, `.prj` and `.cpg` share its name in any case; the archive is read in memory, the `.shp` and `.dbf` together up to 1 GiB. Each record is a row located as `record <n>` (0-based), as many as the longer of the two files holds: the `.dbf` fields in order (character fields without their padding, numbers as their text, logical fields as booleans, dates as dates) and the shape in the `geometry` column. Points, multipoints, polylines (one part a LineString, more a MultiLineString) and polygons, whose rings are grouped as the format orders them (a clockwise ring starts a polygon, the anticlockwise rings after it are its holes); Z types keep their heights, measures are not read, a multipatch has no shape. The text is decoded as the `.cpg` says (UTF-8, or windows-1252 for its names and ISO-8859-1), else as the `.dbf` language driver says, else as UTF-8 when every text field is valid UTF-8, else as windows-1252 (assumed). The CRS (`shapefile-prj`) is the registry CRS whose ESRI WKT the `.prj` is (`high`), else the EPSG authority it ends with (`high`), else the registry CRS of its ESRI name (`medium`), else unknown; recorded, never applied. A Shapefile package exported by either engine imports back unchanged, which the parity suite checks.

**GeoPackage import (slice 3, FR-IMP-02).** An SQLite database whose header holds the application ID of GeoPackage 1.2 and later (`GPKG`), 1.0 (`GP10`) or 1.1 (`GP11`) is a GeoPackage (`high`); another SQLite database is read as one too, with `medium` confidence under the `.gpkg` extension and `low` otherwise, and is refused if it has no `gpkg_contents` table. The file is read with the SQLite reader of decision D-16: in memory in Lite, up to 1 GiB, and a page at a time in the native engine. The layer is the table the format options name (`geopackage: { layer, geometry }`), else the first table `gpkg_contents` lists as features, else the first it lists as attributes; the `layer` detection names every table of data and the one read. Each row is located as `feature <n>`, its feature ID (the table's rowid), so a deleted feature leaves a gap and lineage points at the feature a GIS shows. Its fields are the table's columns but the feature ID and the geometry: whole numbers as numbers (one beyond 2^53 as its exact digits), 0 and 1 in a BOOLEAN column as booleans, reals as numbers (a whole number SQLite stored as an integer for a REAL column is a real, as SQLite reads it), text as text (dates and date-times as their text, which detection types) and blobs as hexadecimal text, as for FlatGeobuf; a record written before a column was added gives it no value. The geometry goes to the `geometry` column as GeoPackageBinary holds it, in either byte order and with any envelope, heights kept and measures dropped, a number that is not finite as null and -0 as 0; a table of attributes has no geometry column. The encoding comes from the SQLite header (UTF-8, UTF-16LE or UTF-16BE, `high`); the CRS (`geopackage-srs`) is the layer's row of `gpkg_spatial_ref_sys`: its EPSG code when the organisation is EPSG in any case (`high`), else the EPSG authority its WKT ends with (`high`), else `unknown` (`low`), as for the undefined systems −1 and 0; recorded, never applied. The row count of the preview is exact: the leaves of the table's b-tree are counted without reading their records. A damaged file, a geometry that does not read and a feature ID that is no row location are refused with the fix to save the layer again from the GIS. The native engine reads it with the same rules and the same messages, and the messy-file library holds two GeoPackages written by SQLite itself (section 13). The GeoPackages both engines export read back the same in both, which the parity suite checks with damaged and unusual files.

**FlatGeobuf import (slice 3, FR-IMP-02).** The marker `fgb` with major version 3 is FlatGeobuf, whatever the extension. The header gives the columns, in order, and the CRS by EPSG code (`flatgeobuf-header`, `high`; `unknown`, `low`, when it records none or another authority), recorded and never applied; the feature count gives the exact row count of the preview. Each feature is a row located as `feature <n>` (0-based): its values keep their stored types (numbers, booleans), text stays text, JSON values are JSON text, a whole number beyond 2^53 its exact digits and binary values hexadecimal text; its geometry goes to the `geometry` column as the file holds it, positions with their heights when the header declares them, except that a number that is not finite becomes null (the validity check reports it) and -0 becomes 0, as for GeoJSON. Measures and times are not read. The import streams the file one feature at a time and passes the spatial index through unread; the sniff reads the header, then jumps past the index to the features of the next MiB. The native engine reads it with the same rules and the same messages, and the messy-file library holds a file written by an encoder independent of the product's writer (its tables before their vtables, a packed R-tree index, values out of column order).

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
| Source locator | Per row: CSV physical line (1-based, correct even with quoted newlines), XLSX sheet row (1-based), GeoJSON feature index, JSON record index (JSON Lines: the 1-based line) or Parquet row index. Rendered as `line 1042`, `Sheet1!C17`, `feature 12`, `record 12, key "rate"`, `row 12, column "rate"`. |
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
  - Choosing another sheet or table of a workbook, in the import settings or as an override, reads that table with the header rows and columns layout detection found for it, so the choice needs no other setting; a sheet without a table gives no columns. Header rows and columns given for the detected sheet and table are taken as given, and the preview names the columns as the import's TW-IMP-003 note does.
  - **Native engine (slice 2).** Both engines plan the dataset again from its original the same way: an interpretation-only override changes the column's plan, a structural one plans the whole file again with the new setting. Each override is worked out before its entry is appended, so a file that cannot be read that way leaves no entry. The native engine reads the original again only where values change. Name, unit, role, time zone and CRS change only the plan. Type, null markers and date format parse the file again into the same rows, keeping edits, exclusions and issues. A structural override reads new rows, so the edits, exclusions and issues of the old rows go; the engines refuse it while the dataset has any of them. The checks run again after each override once they have been run on the dataset.

**Mapping templates (FR-IMP-06, slice 2, protocol 0.4).** A recurring file from the same source system should not need the same corrections every time. The user saves a dataset's columns as a named template: for each column read from the source, its header cells and how it is read (name, type, unit, role, null markers, date format, time zone). A template holds no values and belongs to the user, not the project. The browser edition keeps templates in one file in the origin-private file system, so they survive reloads; a stored entry that fails its schema is left out. Saving under an existing name replaces that template; its ID is `mt_` and the first 12 hex characters of the SHA-256 of the name.

- **Matching.** The preview applies the template every one of whose columns is found in the file by exact header text (repeated headers matched in source order). With several, it picks the one covering most columns, then the most recently saved. Format does not matter, so a template saved from a CSV export also fits the same system's Excel export.
- **Applying.** A template overrides only what detection got differently. The preview shows those columns with a "template" badge and the evidence "From the mapping template …", and the user can decline the template or apply it again. Assumptions the template settles are no longer assumed.
- **Recording.** On import, each change the template makes is its own `detection.override` decision whose reason names the template and its ID, recorded before the user's own changes. A project therefore replays without the template store, and the audit log shows what was detected, what the template set and what the user chose.

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

`CrsRef = { code: 'OGC:CRS84' | 'EPSG:4326' | 'EPSG:<n>' | 'unknown'; source: 'rfc7946-default' | 'geojson-crs-member' | 'flatgeobuf-header' | 'kml-specification' | 'shapefile-prj' | 'geopackage-srs' | 'assumed-latlon' | 'user' }` is held at dataset level.

- GeoJSON defaults to CRS84 (high confidence).
- A legacy `crs` member is recorded and raises `TW-GEO-004` if it is not WGS84.
- CSV latitude/longitude columns are assumed WGS84 and marked assumed.
- Slice 1 detects and records CRS but **does not transform** it. GeoJSON export of non-WGS84 data is refused with a fix hint (`TW-EXP-003`).
- Slice 3 adds the `transform_crs` step between the systems of the CRS registry, computed to the same bits in both engines (decision D-15). After it, the views hold the target CRS with source `user` and method `transform`.
- `getPlaces` (protocol 0.8) gives where a stage's rows are, for the map: each row's geometry of a valid shape, or the point of its numeric longitude and latitude (easting and northing) columns, as WGS 84 longitude and latitude, transformed from the stage's CRS by the same code as the step when it is another. The first `limit` placed rows come in row order (50,000 unless asked, at most 100,000), with the count of rows placed, whether positions were transformed, and, when nothing can be placed (CRS not known or outside the registry, no coordinates), the reason and the fix. A geometry with a position outside what the CRS holds is not placed. Protocol 0.9 adds an optional `bbox`, `[west, south, east, north]` in WGS 84 degrees: only rows whose box meets it are given, and `matched` counts them; a box that is not four finite numbers in order is refused with a fix. Both engines give the same answer, bit for bit.
- `getDensity` (protocol 0.9) counts a stage's placed rows in the Web Mercator grid of 2^`level` by 2^`level` cells (level 0 to 22), numbered as map tiles are, each row at its point or the centre of its geometry's box, inside the optional `bbox`. It gives the cells with a count in key order, the rows placed and counted, and the box of every placed row, with the same reasons as `getPlaces` when nothing can be placed. A row's cell is found with the exact functions of decision D-15, so a point on a cell edge falls in the same cell in both engines; the conformance suite compares levels 0, 5, 12 and 22, with and without a box.

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

Checks run on the **working view**: base data + edits + unit conversions and coordinate transformations, minus excluded rows. Filters and column selection are output steps and do not affect checks. After a `cell.edit`, the engine re-runs the rules that apply to that column plus dataset-level rules.

**Data health score (FR-VAL-05, slice 2, protocol 0.3 `getHealth`).** A dataset's score is the share of its rows that no open error or warning concerns: `100 × (rows − affected) / rows`, rounded down to one decimal, where `rows` excludes excluded rows and a row is affected when it is open (neither accepted nor excluded) in at least one `rows`-scope issue of severity error or warning. Notes never count. Rounding down means 100 is shown only when nothing is open. The same formula gives one score per data category (completeness, uniqueness, validity, range, units, time, spatial, import), each with its affected rows and its number of open issues of any scope, so a column-level finding such as an unknown unit is listed without moving a row score. Before checks have run the scores are null. Both engines compute it from the same issue register and agree exactly (conformance suite).

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

**Native engine (slice 2).** The native engine takes the review decisions: `edit_cell`, `accept_issue`, `exclude_rows`, `comment_issue`, `set_project_area` and `revert` of an edit, an acceptance, an exclusion or a project-area change. Validation, messages and entries are ported from `decisions.ts`, and one function applies an entry both live and during a replay, as `applyEntry` does. Each dataset has two DuckDB views over its working Parquet file: one of every row with the cell edits applied, for looking rows up by ID (issue occurrences), and one without the excluded rows, which the grid, the statistics, the checks, the exports and the digests read. The Overlay is a small table of new values per edited column, joined into the views, so a value edited to null stays apart from no edit; an edited cell's failed-parse text or null marker leaves the exceptions view the checks read, as `failedText` and `markerOf` say. A join may return rows out of order, so for a dataset with edits the readers that need row order (digests and export writers) add `ORDER BY __rid`; one without edits keeps the plain scan. The grid pages by position in the view; an exclusion only replaces the small table of excluded row IDs the view leaves out. An exclusion, a project-area change, or the revert of either, runs the dataset's checks again before the answer, as the TypeScript engine does; on a large dataset that is minutes, and moving it into a job is the next step. Steps are SQL too (`steps.rs`, ported from `views.ts`, `predicate.ts` and `convert.ts`): a unit conversion is a computed column added to the view of every row, operation for operation as `applyConversion` (y = ((x × fromFactor + fromOffset) − toOffset) / toFactor), chained in step order; the output view adds the filters as one `WHERE` and takes its columns from the last selection. Filter conditions keep the TypeScript semantics: every atomic comparison is `coalesce(…, false)`, so a comparison with null is false even under `not`, and dates and date-times compare as their canonical text. Conversions are refused with the same codes, messages and fixes (gauge against absolute pressure, measured against standard volumes, different dimensions or reference conditions). Previews, `applyStep` (a job), `removeStep` and the revert of a step behave as in the TypeScript engine, including the refusal to remove a step a later one depends on, and the grid, schema, statistics and exports read the working or the output stage accordingly; a project file records both digests. Detection overrides are refused with a reason until the native engine has them. The conformance suite takes the same decisions in both engines and compares the entries, issues, occurrences with the entries that decided them, rows, statistics, health, refusals and export.

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
- An entry is held as its canonical text reads back and laid out as the interface above lists its members, with those of its actor, target, method and rule in the order of their own types; `old`, `new` and `payload` keep the sorted keys of the canonical text. Every engine holds it so, which is why a value from the log reads the same wherever it is written out.

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

**Native engine (slice 2).** The native engine answers `explainCell` the same way. The raw text of a failed parse or a null marker comes from the exceptions table; a value that parsed is stored typed only, so its text is read again from the original file (or from the project file's stored original) under the import's plan, stopping at the record. On a large file that read is as long as reading up to the row, as it is in the TypeScript engine.

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

| Profile   | Label in UI                          | Output                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `excel`   | Microsoft Excel                      | `.xlsx` with **Data**, **Report** and **Log** sheets (details below)                                                                                                                                                                                                   |
| `csv`     | Databases, Python, R, BI tools (CSV) | UTF-8 without BOM, RFC 4180, comma, CRLF, ISO dates, `.` decimal, canonical numbers, header `Name [unit]`. Optional formula neutralisation (below)                                                                                                                     |
| `parquet` | Python, Spark, DuckDB, data lakes    | Apache Parquet (slice 2): one typed column per field, names `Name [unit]`; DOUBLE, INT64, BOOLEAN, DATE, UTC TIMESTAMP (microseconds; values are whole milliseconds), UTF8; Snappy compression, which every Parquet reader supports. Read-back adds `RB-PARQUET-TYPES` |
| `geojson` | QGIS / ArcGIS / web maps (GeoJSON)   | RFC 7946 FeatureCollection, lon/lat order, full-precision coordinates, no `crs` member. Built from the geometry column or from latitude/longitude roles. Refused (`TW-EXP-003`, with a fix) if the CRS is not WGS84; the fix is to transform the coordinates first.        |
| `shapefile` | QGIS / ArcGIS (Shapefile)          | ESRI Shapefile (slice 3, FR-EXP-04) in the CRS of the data, details below. Read-back adds `RB-SHP-STRUCTURE` and `RB-SHP-GEOMETRY` |
| `kml`     | Google Earth (KML)                   | KML 2.2 (OGC 07-147r2, slice 3) in WGS 84, details below. Read-back adds `RB-KML-STRUCTURE` and `RB-KML-GEOMETRY` |
| `flatgeobuf` | QGIS / ArcGIS / GDAL (FlatGeobuf) | FlatGeobuf 3 (slice 3) in the CRS of the data, details below; also what a Shapefile past 2 GB is delivered as (FR-EXP-03). Read-back adds `RB-FGB-STRUCTURE` and `RB-FGB-GEOMETRY` |
| `geopackage` | QGIS / ArcGIS / GDAL (GeoPackage) | OGC GeoPackage 1.2 (slice 3, decision D-16) in the CRS of the data, details below. Read-back adds `RB-GPKG-STRUCTURE` and `RB-GPKG-GEOMETRY` |

Excel profile details:

- **Data sheet:** a single header row `Name [unit]`; numbers stored as numbers; real dates (serial + date format); no merges; frozen header at A2; autofilter over the data range.
- **Report sheet:** project, sources with SHA-256, rule-packs, unit registry, conversions, steps, exclusions, assumptions, open issues by severity, and the expected column digests.
- **Log sheet:** the audit log.
- **Substitutions:**
  - more than 1,048,575 data rows → the data is delivered as CSV inside the package, and the workbook keeps Report and Log plus a substitution notice (`TW-EXP-002`, FR-EXP-03);
  - a cell text longer than 32,767 characters (for example a long geometry) → that column is moved to a CSV side file with a notice.
- Workbook creation time is set from the injected clock, never the wall clock, so output is deterministic.

Google Earth profile details:

- **File:** `data.kml`, one `Document` named after the dataset, holding one `Placemark` per row: its `name` from the first ID column, every other column as `ExtendedData`/`Data` named by its header `Name [unit]` (an empty `value` for no value), and its geometry, or the point of the latitude and longitude columns. Positions are `longitude,latitude[,height]` in canonical numbers, so they read back exactly; a multi-part geometry or a collection is a `MultiGeometry`, which a reader takes back as a multi-part geometry when its members are all of one kind. Rings are written as they are. Text is escaped so every XML parser returns it unchanged: `&`, `<` and `>`, a carriage return as `&#13;`, and in attribute values quotes, tabs and line feeds as references.
- **Refusals, with a fix:** no geometry column and no latitude and longitude; a CRS other than WGS 84 (transform the coordinates first, or export as a Shapefile, which keeps the data's CRS).
- **Substitutions (`TW-EXP-002`):** a column with characters XML 1.0 cannot carry (most control characters) moves to `data-long-text.csv`; a geometry without a valid shape leaves its placemark without a geometry; a position with more than three numbers keeps its first three.
- **Read-back:** a reader apart from the writer (saxes in the TypeScript engine, the engine's own XML reader in the native one, never a DTD) checks the root and namespace, the one Document and its name, one placemark per row with the columns in order and at most one geometry; the values by column digest; and every geometry against its row's in the form a reader takes back. The browser tests add an independent Python reader (ElementTree), and both engines write the same bytes.

Shapefile profile details (FR-EXP-04):

- **Files:** `data.shp`, `data.shx` and `data.dbf` (ESRI Shapefile Technical Description, July 1998; dBASE III), `data.prj` with the ESRI WKT of the data's CRS, built from the CRS registry (decision D-15) and checked against the WKT ESRI publishes for each system, `data.cpg` (`UTF-8`) and `data.fields.csv`, which maps each field name to the column's full name, unit and type.
- **Shapes:** from the geometry column, or points from the coordinate pair the CRS has (longitude and latitude, or easting and northing), written in the CRS of the data with no transformation. One file holds one kind: points (Point, or MultiPoint when any row is one), lines (polyline: LineString and MultiLineString) or polygons (Polygon and MultiPolygon, outer rings clockwise and holes anticlockwise, as the format requires), with the Z variant when every position has a height. A row without a geometry has a null shape; a geometry without a valid shape is written as a null shape and listed as a substitution.
- **Fields:** text as `C` (as wide as the longest value, UTF-8), whole numbers as `N(18,0)`, numbers as `N(24,15)` holding the canonical number text, booleans as `L`, dates as `D`, date-times as ISO text. Names have at most 10 characters (letters, digits and `_`, starting with a letter), unique whatever their case, a clash taking `_1`, `_2`. A value a field cannot hold exactly, because readers trim spaces at both ends and a `C` field holds 254 bytes, moves its column to `data-long-text.csv`, row for row (`TW-EXP-002`).
- **Refusals, with a fix:** no geometry and no coordinate pair; a CRS that is not known or that the registry cannot describe; more than one kind of geometry, or geometries with and without heights (export as FlatGeobuf or GeoJSON).
- **Over 2 GB (FR-EXP-03):** when the `.shp` or the `.dbf` would be larger than the 2 GB the format addresses, the plan computes their sizes exactly and the package holds `data.fgb` instead, written by the FlatGeobuf profile's rules, with a `TW-EXP-002` substitution that states the size and what replaces it. The test suites reach this path by lowering the limit, in both engines.
- **Read-back:** a reader apart from the writer checks the file codes, lengths, the index against the records, record numbers, shape types, every record's box and the header's box and height range, the .dbf record count, field names and types against the field list, the `.prj` and `.cpg`; the field list against the headers; the .dbf values by column digest; and every shape against its row's geometry in the form a reader makes of it (rings grouped by orientation). The browser tests add an independent Python reader of the package, and the parity suite requires both engines to write the same bytes.

FlatGeobuf profile details:

- **File:** `data.fgb`, FlatGeobuf 3 (flatgeobuf.org): the magic bytes, a header and one feature per row, in row order, each a size-prefixed FlatBuffer. There is no spatial index, since one would reorder the features (its node size is written as 0). Both engines build the FlatBuffers with the same small builder of their own (back to front, every value aligned to its size, a vtable before each table, none shared), so they write the same bytes; a unit test in each engine checks a header and a feature against bytes worked out by hand from the FlatBuffers rules.
- **Header:** the dataset name, the envelope (min x, min y, max x, max y of every position), the geometry type when every geometry has the same one and Unknown for a mix, `has_z` when every position has a height, the feature count, and the CRS as organisation `EPSG`, its code and its name (`OGC:CRS84` is recorded as EPSG 4326, whose x and y FlatGeobuf also takes as longitude and latitude).
- **Geometries:** from the geometry column, or points from the coordinate pair the CRS has, in the CRS of the data with no transformation. Any mix of kinds is kept, collections included: a multipolygon or a collection is a geometry of parts, a polygon or multi-line has the running ends of its parts unless it has exactly one, so empty geometries read back as they were.
- **Columns:** every other column as a property named by its header `Name [unit]`: text as String, whole numbers as Long, numbers as Double, booleans as Bool, dates and date-times as DateTime ISO text, other geometries as Json. Text of any length is kept.
- **Refusals, with a fix:** no geometry and no coordinate pair; a CRS that is not known, or that has no EPSG code; geometries with and without heights (export as GeoJSON).
- **Substitutions (`TW-EXP-002`):** a geometry without a valid shape leaves its feature without a geometry; a position with more than three numbers keeps its first three.
- **Read-back:** a reader apart from the writer checks the magic bytes and version, the name, the feature count, that there is no index, the geometry type, `has_z` and no measures, the CRS, the column types, every feature's type against the header's, and the envelope against the geometries read; the headers, the values by column digest, and every geometry against its row's, coordinate for coordinate. The native read-back reads one feature at a time. The browser tests add an independent Python reader (struct), and the parity suite requires both engines to write the same bytes. The file has not yet been opened in GDAL or QGIS in the test suites (section 16).

GeoPackage profile details:

- **File:** `data.gpkg`, an OGC GeoPackage 1.2 (application ID `GPKG`, user version 10200) on the SQLite file format writer of decision D-16: `gpkg_spatial_ref_sys`, `gpkg_contents` and `gpkg_geometry_columns` as the standard defines them, with their automatic indexes, the feature table `data`, and `sqlite_sequence`, since the feature ID is `INTEGER PRIMARY KEY AUTOINCREMENT` as GDAL makes it. No R-tree spatial index: QGIS and GDAL create one when asked.
- **Layer:** one row of `gpkg_contents`: the table `data` of features, its identifier the dataset name (which QGIS and ArcGIS show), its extent the box of every position, and its last change the time of the export.
- **CRS:** the system of the data by organisation `EPSG`, its code and its OGC WKT 1, written from the CRS registry with an AUTHORITY for every object; `OGC:CRS84` is EPSG 4326, whose x and y a GeoPackage takes as longitude and latitude. The rows for the undefined Cartesian (−1) and geographic (0) systems and for WGS 84 are always there. A system outside the registry is refused (export as FlatGeobuf, which records the EPSG code alone).
- **Features:** one per row, in row order, with feature IDs 1, 2, 3…; the geometry in the column `geom` as GeoPackageBinary (little-endian, a point without an envelope, an empty geometry with the empty flag, every other geometry with its x and y envelope) holding ISO WKB. Any mix of kinds is kept, and heights are per geometry: a geometry has them when every position has one, and `gpkg_geometry_columns.z` says whether none, all or some geometries have them. The geometry type is the one kind when every geometry has it, else `GEOMETRY`.
- **Fields:** every other column, named by its header `Name [unit]`: text as TEXT, whole numbers as INTEGER, numbers as REAL, booleans as BOOLEAN (0 and 1), dates as DATE and date-times as DATETIME text in the form the standard gives, other geometries as GeoJSON TEXT. Names of any length; the feature ID and geometry fields take the names `fid` and `geom`, or `fid_1` and `geom_1` when a column has those names (a substitution says so).
- **Refusals, with a fix:** no geometry and no coordinate pair; a CRS not known, or outside the registry; two column names that SQLite would take as one (they differ only in the case of ASCII letters), or a name with a NUL character.
- **Substitutions (`TW-EXP-002`):** a geometry without a valid shape leaves its feature without a geometry; a position with more than three numbers keeps its first three; a geometry with heights at some positions only is written without them.
- **Read-back:** the product's SQLite reader, apart from the writer, checks the application ID and version, the three systems and the data's with its code and WKT, the one layer with its identifier, time and system, the geometry column's row, the declared types of the feature ID, geometry and fields, feature IDs 1, 2, 3… in order, every geometry's SRS ID, type, envelope and empty flag, the layer's extent and `sqlite_sequence`; the field names, the values by column digest, and every geometry against its row's, coordinate for coordinate. The native read-back reads one page at a time. The browser tests add SQLite itself as an independent reader (Python's sqlite3, with its integrity and foreign key checks and a WKB decoder of its own), and the parity suite requires both engines to write the same bytes but for the export time.

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
| RB-SHP-STRUCTURE     | File codes and lengths, the .shx pointing at every record, record numbers and shape types, boxes and height ranges that bound the shapes, as many .dbf records as shapes, field names and types as data.fields.csv lists them, the `.prj` of the data's CRS, a UTF-8 `.cpg` |
| RB-SHP-GEOMETRY      | Every shape equals its row's geometry in the form a reader makes of it, coordinate for coordinate |
| RB-KML-STRUCTURE     | A KML 2.2 root, one Document named after the dataset, one placemark per row holding the columns in order and at most one geometry |
| RB-KML-GEOMETRY      | Every placemark's geometry equals its row's in the form a reader takes back from KML, coordinate for coordinate |
| RB-FGB-STRUCTURE     | FlatGeobuf 3 magic bytes, the header named after the dataset, its feature count equal to the features, no spatial index, the expected geometry type, heights and no measures, the EPSG code of the data, column types by logical type, every feature of the header's type, an envelope that bounds the geometries |
| RB-FGB-GEOMETRY      | Every feature's geometry equals its row's, positions of at most three numbers, coordinate for coordinate |
| RB-GPKG-STRUCTURE    | GeoPackage application ID and version 1.2, the undefined systems, WGS 84 and the data's system by EPSG code and WKT, one feature layer named after the dataset with the export time and an extent that bounds the geometries, its geometry column row, declared field types, feature IDs 1, 2, 3… in row order, each geometry's SRS ID, type, envelope and empty flag, and `sqlite_sequence` |
| RB-GPKG-GEOMETRY     | Every feature's geometry equals its row's, heights where every position of the geometry has one, coordinate for coordinate |
| RB-GEOJSON-STRUCTURE | FeatureCollection, feature count, no `crs` member, positions within WGS84 bounds, rings closed with ≥ 4 positions, coordinate order consistent with the source |
| RB-PARQUET-TYPES     | Every column has the physical and converted (or logical) type of its logical type; other writers' equivalent annotations are accepted (DuckDB's `INT_64`)      |
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

**Native engine (slice 2).** The native engine follows the same pipeline for every profile. The CSV and GeoJSON writers are ported, so both engines write the same `data.csv` and `data.geojson` byte for byte; Parquet is written by DuckDB `COPY`, a geometry as JSON text with the JSON annotation. The workbook writer is ported too: the Data sheet's rows are streamed to a file as they are read from the view, so a sheet of a million rows is never held in memory, and the Report and Log sheets, the frozen header, the filter and the date formats are the TypeScript writer's. The Excel plan is the same: more data rows than a sheet holds go to `data.csv`, and text longer than a cell holds to `data-long-text.csv`, each listed as a TW-EXP-002 substitution, which the profile list shows before the export. Read-back uses separate readers (the ported CSV reader in strict mode; DuckDB's Parquet reader; the ported workbook reader, which checks storage types, the frozen header and the filter as well as the values; the ported GeoJSON reader, a feature at a time), and the package is re-opened, its checksums verified and every data file inside extracted and read back again. The JSON text in the Log sheet is the same too, because both engines hold an entry's members in one order (section 9.1). Entries are STORED, with ZIP64 fields when an entry or offset reaches 4 GiB, so a package of any size opens in standard tools. A request may name a file (`target: {kind: 'path'}`); a package larger than 256 MiB that names none stays in the work folder, and `ExportResult.path` says where.

**Formula neutralisation (slice 2, `ExportRequest.neutralizeFormulas`).** For CSV data files, text that a spreadsheet program would run as a formula (starting with `= + - @`, a tab or a carriage return) gets one more leading apostrophe, which spreadsheets show as text (OWASP CSV injection guidance). Text that already starts with apostrophes before such a character gets one more too, so read-back removes exactly one and the column digests still match. The manifest records `options.neutralizeFormulas`, and the README says how to restore the values.

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

Working data is **not** stored in slice 1; it is rebuilt by replay. Format 0.2 (decision D-13) adds per-dataset caches under `data/<datasetId>/` (`rows.parquet`, `exceptions.parquet`, `notes.json`, and `issues.json` once the dataset is checked). The manifest's `caches` lists them with the `source.add` entry each holds the result of, and, for issues, the entry they follow (`afterSeq`), so large projects open without importing or checking again. Every reader verifies their checksums; one that uses them still verifies the audit chain and the dataset digests after replay.

**On open, in order.** Each failure is recorded as an `IntegrityCheck` and an issue:

1. ZIP readable, mimetype and format version supported (TW-PRJ-004).
2. Manifest validates.
3. Every entry's SHA-256 matches the manifest (TW-PRJ-004).
4. Every original's SHA-256 matches its content address (TW-PRJ-001).
5. Audit chain verifies (TW-PRJ-002).
6. Replay of the log succeeds and the dataset digests equal the manifest (TW-PRJ-003).

Any failure opens the project **read-only**, with the reasons shown in an Open report. It is never blocked from opening and never silently repaired. Each save appends a `project.save` entry recording the state digest.

**Native engine (slice 2, decision D-13).** The native engine writes format 0.2: the same entries, canonical manifest, checksums and README as the TypeScript writer, all STORED, with ZIP64 fields past 4 GiB, plus the caches. Dataset digests are computed as `viewDigest` computes them, and every original is checked against its file ID before the save is recorded, so a changed file leaves no save behind. Opening makes the same checks in the same order, with the same findings, and replays the log. The open report reads check for check as the TypeScript engine's on the same file, except that a passed replay says how the datasets were rebuilt. Each failed rule becomes one issue of the system rule pack (TW-PRJ-001 to TW-PRJ-004), listed with the dataset issues. As in the TypeScript replay, an original that is missing, cannot be read or is not the file imported stops the replay at its import, even when a cache could stand in for it. A dataset is restored from its caches when all three are present, verified and tied to its `source.add` entry, and imported again from its original otherwise. Its issues are restored from its issues cache when that is present, verified, follows an entry of the log and reads back whole: entries up to that one change nothing in the dataset's issues during the replay, and the cached issues are installed there. Any later check run or re-check runs again with the same rule packs. The digests are then compared with the manifest's. A read-only project refuses imports, checks, exports and saves. Originals stored in the opened file are copied from it on the next save rather than unpacked. The native engine opens projects saved by the TypeScript engine (inflating their deflated entries under a size guard), and replays the actions it supports: creation, imports of delimited text, assumptions, check runs, cell edits, steps and their removal, recipe runs, acceptances, exclusions, comments, project-area changes, detection overrides, reverts of those, exports and saves. An override replays by reading the original again where it changes values. A dataset that an override read again keeps no data caches in the file, because its working files are no longer what its `source.add` entry imported; it is imported again from its original on open, and its issues cache still applies. A log with any other action stops the replay, with the action named in the Open report. The conformance suite opens each engine's files in the other.

### 11.1 Recipe file (`.twr`, format 1; FR-RCP-01..03, slice 2, protocol 0.5)

A recipe carries the steps from Check to Export to the next period's file. It is one UTF-8 JSON document, checked against a strict schema when read, because recipes are shared between people (FR-RCP-03):

| Member                                   | Content                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`, `formatVersion`                | `tracewell-recipe`, 1                                                                                                                                                    |
| `id`, `name`, `version`                  | `rcp_` + 12 hex of SHA-256(name), so the ID cannot be edited apart from the name; version 1, then one more each time it is saved again from a dataset it was run on       |
| `savedAt`, `savedBy`, `appVersion`       | When, by whom and with which version it was saved                                                                                                                       |
| `columns`                                | The columns the steps use, as imported (before any step converts or hides them): key (the column ID where it was saved), name, type and unit                           |
| `check`                                  | The rule packs (ID, version, SHA-256) it checks with, or null                                                                                                            |
| `steps`                                  | The processing and extraction steps in order, their column IDs being keys of `columns` (with a unit suffix for converted columns, `c4~kPa`)                             |
| `export`                                 | The export profile and its options, or null                                                                                                                              |
| `baseline`                               | The issues of the run it was saved from: rule ID, column names, severity and count per issue, and the row count. Never a value, a message or a row                       |

- **Planning.** On another dataset each recipe column is found by name among the imported columns and must have the same type and unit, because a threshold or a conversion written for psia means something else in bar. Each step is then validated against the dataset as the earlier steps leave it, and the rule packs must be the ones this engine has. The plan lists the mapping, the steps as they will be applied and every problem; a recipe that does not fit is refused before anything is recorded.
- **Running.** A `recipe.apply` entry records the recipe and the mapping with the user's reason; each step is an ordinary `step.apply` entry ("Recipe "Monthly well report" v1: reason") and the checks an ordinary `check.run`. The project therefore replays without the recipe file.
- **Only new or changed issues (FR-RCP-02).** After a run, each issue of the dataset is compared with the baseline by rule ID and column names: new, changed (another count, with the previous count shown) or unchanged. The dataset's issues register shows only new and changed issues by default, with every issue a choice away, and the run reports baseline issues no longer found.
- **Native engine.** The native engine saves, plans and runs recipes with the same rules (`recipes.rs`, ported from `recipes.ts`), records the same entries, and lists issues with the same comparison. A saved recipe's bytes come back with the call as a byte frame. Its JSON has the same members, though not in the same order, which a reader does not depend on. A file that is not a valid recipe is refused as `FORMAT_UNSUPPORTED`; where the TypeScript reader quotes its schema's message for the first wrong member, the native reader names the member in its own words.

### 11.2 Recovery journal (FR-PRJ-03, slice 2, protocol 0.6)

Nothing is lost when the page or the app closes unexpectedly. The engine's state is a replay of the audit log over the original files, so those two are all a recovery needs. After every change the engine writes its session's journal: the audit log as it stands and each original file it has not written yet. In the browser the journal is a folder per session in the origin-private file system; `journal.json`, which names the project and its originals, is written last, so a journal is only read once it names everything it needs.

- **One journal per session.** Each engine session holds a Web Lock named after its session for as long as it runs. A journal is offered for recovery only when its lock is free, so a second tab never takes over the first one's work. Without the Web Locks API nothing is journalled.
- **What counts as unsaved.** The journal's audit entries after its last `project.save`, other than the project's creation. A journal with none is deleted without asking.
- **Recovering.** On start, before a new project is created, the app shows the unsaved work (project, number of changes, time of the last one) with two choices: recover it or discard it. Recovery opens the journal as a project file is opened (each original against its SHA-256, the audit chain, a full replay) and any failure opens it read-only with the matching `TW-PRJ` issue. The recovered project becomes this session's own, journalled again before the old journal is deleted.
- **Native engine (slice 2).** The native engine keeps the same journal on disk, a folder per session under the recovery folder (`--recovery`, by default `tracewell/recovery` in the user's state directory), with the same three parts and `journal.json` written last. A session holds an exclusive lock on its folder's `lock` file for as long as it runs; the operating system releases it however the process ends, so a journal is offered only once its engine has gone. Originals the engine holds the only copy of (uploads into its working folder, or a recovered upload) are copied once; a file the user imported from their own disk is named by its path instead, so a 10 GB original is not written twice, and recovery checks it against its SHA-256 like any original: a changed or missing file opens the recovered project read-only with TW-PRJ-001. The journal is written after every change, before the change's job is reported done. The parity suite crashes engines (`SIGKILL`) and recovers their work in new ones.

---

## 12. Security and offline design

- **No network code.** The production `index.html` carries:

  ```text
  default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self';
  img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

  The meta tag is injected at build time only, because the development server needs inline styles. The CSP is the technical guarantee.

- **Map (slice 3).** MapLibre's worker is built as a file of the application's own origin and named to MapLibre (`setWorkerUrl`), so it starts under `worker-src 'self'` without a `blob:` URL. A basemap is read from a PMTiles file the user chooses, through MapLibre's protocol hook, so tiles are read from that file and never fetched; the map has no glyph or sprite URLs, since it draws no text. The CSP is unchanged. An online basemap (FR-MAP-02's optional one) would need `connect-src` for its host behind an explicit setting, and is not built.
- **No remote fonts, analytics or update checks.** The system font stack is used. The status bar always shows **Offline** in slice 1.
- **E2E offline guard.** A shared Playwright fixture routes `**/*` and records any request not to `127.0.0.1:4173`. Every test fails if the list is non-empty.
- **No downloaded engine code.** DuckDB can fetch and load extensions on first use. The native engine links the JSON and Parquet extensions in and turns automatic installing and loading off at start, so it never fetches code nor loads an extension it finds on the machine.
- **Host bridge (decision D-14).** The page reaches the native engine through an object its container provides, never over the network. Under the CSP no page script can provide that object; only the container (the test harness, later the desktop shell) can.
- **Untrusted input handling.**
  - The XML parser (saxes) does no DTD or entity expansion, so it is not open to XML external-entity attacks.
  - The ZIP reader has a decompressed-size cap and an entry-count cap (zip-bomb guard).
  - CSV fields and JSON depth are capped.
  - All parsers run in the worker; the UI never evaluates file content.
- **Formula injection.** The XLSX writer never writes formulas. The CSV export has an optional neutralise setting (section 10.4) that prefixes an apostrophe to text a spreadsheet would run as a formula.
- **Supply chain.**
  - Exact version pins and a committed lockfile.
  - Few runtime dependencies (15, each listed in section 14).
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
| E2E                 | Playwright 1.56.1, headless Chromium 1194                          | The real production build, the full workflow per format, offline guard, accessibility smoke; again with the native engine through the host bridge (D-14)       |
| Independent oracles | Python 3.13 (openpyxl 3.1.5, csv, json, sqlite3 with SQLite 3.53), LibreOffice 24.2 headless | Exports re-read by independent implementations; digests or values compared                                                                                      |

### 13.2 Messy-file library (`fixtures/messy/`)

Small committed files, each with `<name>.expected.json`. `SHA256SUMS` guards against accidental changes, and `.gitattributes` marks them binary so line endings are preserved.

| Group              | Fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSV/TSV            | `csv_well_daily_golden.csv`, `csv_semicolon_decimalcomma_cp1252.csv`, `csv_utf8_bom_crlf.csv`, `tsv_utf16le_bom.tsv`, `csv_title_rows_units_in_header.csv`, `csv_null_markers.csv`, `csv_quoted_newlines_ragged.csv`, `csv_duplicates_rows_and_keys.csv`, `csv_dates_ambiguous_and_mixed.csv`, `csv_leading_zero_ids_ndl.csv`, `csv_latlon_swapped_out_of_range.csv`, `csv_timeseries_gaps_dups_flatline_spike.csv`, `csv_mixed_units_in_cells.csv`, `csv_pipe_delimited.csv`, `csv_physical_impossible.csv` |
| XLSX               | `xlsx_merged_two_row_header_units.xlsx`, `xlsx_text_and_serial_dates.xlsx`, `xlsx_two_tables_one_sheet.xlsx`, `xlsx_date1904.xlsx`, `xlsx_hidden_sheets_formulas.xlsx`, `xlsx_numbers_as_text.xlsx`. Generated by `make_xlsx_fixtures.py` with openpyxl, then re-saved by LibreOffice headless so formulas carry cached values, which gives two independent producers.                                                                                                                                       |
| GeoJSON            | `geojson_wells_points_wgs84.geojson`, `geojson_legacy_crs_27700.geojson`, `geojson_invalid_geometries.geojson`, `geojson_swapped_lonlat.geojson`, `geojson_mixed_geometry_nested_props.geojson`                                                                                                                                                                                                                                                                                                              |
| GeoPackage         | `gpkg_licence_blocks_bng.gpkg`, `gpkg_wells_points_wgs84.gpkg`. Written by SQLite itself through `make_gpkg_fixtures.py` (Python's sqlite3), so the reader of decision D-16 is tested against the SQLite library's own layout: small pages, overflow, a deleted row, WAL and UTF-16 headers, an R-tree index, a column added after the rows |
| Generated in tests | `big_1m_rows.csv` (seeded, `@slow`), `excel_limit_1_1m_rows.csv` (`@slow`), tampered `.twp` variants, broken audit chains                                                                                                                                                                                                                                                                                                                                                                                    |

Every bug found becomes a new fixture (PRD §16).

### 13.3 E2E specs (`tests/e2e/`)

| Spec                                                                   | Covers                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.spec.ts`                                                        | Landmarks, keyboard menu bar, process toolbar states, status bar shows Offline, About shows the owner's name                                       |
| `import-csv.spec.ts`                                                   | Messy windows-1252 semicolon file; assumed badges; delimiter override logged                                                                       |
| `import-xlsx.spec.ts`                                                  | Merged two-row header flattened; additional-table issue; legacy .xls; table chosen in the preview                                                  |
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

Versions verified with `npm view <pkg> version license` on 19 October 2026. Each pin is at least two weeks old, except react-resizable-panels 4.14.2 and lucide-react 1.52.0, which were published on 2 and 4 October 2026, about 15 days before this check; they are kept as the newest stable releases. Pins are exact and the lockfile is committed. On 28 October 2026 (slice 2), `npm audit` reported advisories in zod 4.6.5 (memory exhaustion while validating oversized collections, reachable through a crafted project file) and in the Vite 8.3.0–8.3.2 development server; they were fixed by moving to zod 4.6.7 and vite 8.3.4, both more than two weeks old, and hyparquet 1.31.3 with hyparquet-writer 0.16.11 were added for Parquet.

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
| saxes                   | 6.0.0 (+ xmlchars 2.2.0, MIT) | ISC     | Streaming XML for the XLSX and KML readers; no DTD or entity expansion                    |
| @noble/hashes           | 2.4.0                         | MIT     | Incremental SHA-256 in worker and Node (pure JS, audited)                                 |
| @streamparser/json      | 0.0.26                        | MIT     | Streaming GeoJSON features and JSON records                                               |
| zod                     | 4.6.7                         | MIT     | Schemas for manifests, rule-packs, steps, decisions, audit entries                        |
| hyparquet               | 1.31.3                        | MIT     | Parquet reader for export read-back and Parquet import (slice 2)                          |
| hyparquet-writer        | 0.16.11                       | MIT     | Parquet writer for the Parquet export profile (slice 2)                                   |
| maplibre-gl             | 6.16.0                        | BSD-3   | Map view (slice 3), loaded only when a map tab opens; its worker is a same-origin file   |
| pmtiles                 | 4.5.0 (+ fflate)              | BSD-3   | Reads a basemap from a local PMTiles file through MapLibre's protocol hook (slice 3)      |

**Development and test only**

| Package                        | Version | Licence                         | Purpose                                                                |
| ------------------------------ | ------- | ------------------------------- | ---------------------------------------------------------------------- |
| typescript                     | 6.0.3   | Apache-2.0                      | Compiler (typescript-eslint 8.71 supports < 6.1)                       |
| vite                           | 8.3.4   | MIT                             | Development server and build (Node ≥ 22.12)                            |
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

**Native engine crates (slice 2, checked on crates.io on 28 October 2026).** Pins are exact in `Cargo.toml`, and each is at least two weeks old. `Cargo.lock` is generated on each machine and not kept in the repository, because it lists crates for every target platform, including ones Tracewell never builds; `npm run check:licences` classifies the resolved tree with `cargo metadata`.

| Crate                 | Version   | Licence           | Purpose                                                                                            |
| --------------------- | --------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| duckdb                | 1.10506.0 | MIT               | DuckDB 1.5 (bundled) with the Parquet and JSON extensions linked in, Arrow appender, Arrow scalar functions. Version 1.20000.0 was rejected: a development build |
| serde_json            | 1.0.154   | MIT OR Apache-2.0 | Protocol messages; `float_roundtrip` for exact numbers, `preserve_order` for the order of members  |
| sha2                  | 0.11.1    | MIT OR Apache-2.0 | SHA-256 of files, audit chain and packs                                                            |
| memchr                | 2.8.3     | Unlicense OR MIT  | Fast delimiter and quote search in the CSV reader                                                  |
| unicode-normalization | 0.1.25    | MIT OR Apache-2.0 | NFKC for unit names, as the TypeScript `normalize('NFKC')`                                         |

**System test oracles (already installed, not distributed).** Python 3.13 with openpyxl 3.1.5 (MIT); LibreOffice 24.2.7 (MPL-2.0, run as an external program).

**Planned for later slices (checked 19 October 2026).**

- npm: @tauri-apps/api 2.12.4 (Apache-2.0 OR MIT). maplibre-gl and pmtiles were adopted in slice 3 (checked 17 November 2026: maplibre-gl 6.16.0, the newest release at least two weeks old, with its MIT, ISC and BSD dependencies). proj4 is not needed: decision D-15.
- Rust crates (crates.io): none. Workbooks are read and written by ports of the TypeScript reader and writer, and ZIP archives by the engine's own code, so `calamine`, `rust_xlsxwriter` and `zip` were not adopted.
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

| Menu | Items                                                                                |
| ---- | ------------------------------------------------------------------------------------ |
| File | New project, Open project…, Save project, Import file…, Export…, Project area…       |
| Edit | Edit cell, Undo last change (revert with reason)                                     |
| View | Panels, Map, Light/Dark theme, Compact/Comfortable density                           |
| Data | Run checks, Convert units…, Transform coordinates…, Filter…, Columns…, Exclude rows… |
| Help | Keyboard shortcuts, Open-source licences, About Tracewell (owner's name)             |

Other menus from the PRD (Analysis, Map, Reports, Tools) appear when they have content.

**Map view (slice 3; FR-MAP-01 to FR-MAP-04).** View › Map opens a tab for the active dataset. It draws what `getPlaces` gives for the working or the output stage (section 7.6) with MapLibre, as points, lines and polygons in the accent colour, fitted to them when first shown; a status line says how many rows are placed and from which CRS. A stage of more than 20,000 places is first fitted to the box `getDensity` gives at level 0; then, each time the view moves, the view asks `getDensity` for the cells in view at three levels above the zoom. When 20,000 rows or fewer are in view, it draws them from `getPlaces` with the view's box; otherwise it draws the cells, shaded by the logarithm of their count, and the status line says to zoom in or click a cell, which zooms to it. The engine counts the cells on demand, in place of vector tiles made in advance, so nothing is generated or stored and the counts always match the stage. When nothing can be placed, it shows the engine's reason and fix. Clicking a place selects that row's coordinate cell: the properties panel shows its lineage and an open grid scrolls to it; a cell selected anywhere marks its place on the map, larger and in the text colour, since red, amber and green mean status. Without a basemap a graticule every 10° shows where the map is; Basemap chooses a local PMTiles file, raster or vector, and any vector schema is drawn plainly (a fill and a line for each source layer, water as water), with the attribution the archive names. Draw area turns a drag into a box in WGS 84 longitude and latitude; the view previews the filter step it makes (rows whose geometry meets the box, or whose point is inside it) with the rows it keeps, and Filter… asks for a reason and applies it. A box filters only data whose positions needed no transformation; for other data the view says to transform the coordinates to EPSG:4326 first. MapLibre is in its own code-split chunk, so the rest of the application does not load it. The browser tests draw the map with WebGL in headless Chromium (SwiftShader), load a generated PMTiles file, click a place, draw a box and apply the filter, show 25,000 wells as density cells and click one to see its wells, on both engines, and the accessibility scan includes the map.

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
| Spatial files not yet opened by GIS software in the suites        | Shapefile, KML and FlatGeobuf follow their published specifications, are read back by the product's own readers and by independent Python readers, and both engines write the same bytes; a GDAL read-back of each spatial profile joins the suites when the build runners carry GDAL |
| Authorship constraint                                             | Hygiene check in `npm test`; About screen, LICENSE and NOTICE in the owner's name                                                                                                                  |

---

## 17. Roadmap of next slices

| Slice                 | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit evidence                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **1 (this document)** | Core workflow end to end on CSV/TSV, XLSX and GeoJSON in the browser engine; `.twp`; validated export packages                                                                                                                                                                                                                                                                                                                                              | `npm test` green; oracles pass                                            |
| **2**                 | Native headless engine (Rust + DuckDB + Parquet) behind `stdioTransport`; conformance parity on slice 1 scenarios; 10 GB benchmark; Parquet working files and `.twp` caches (FR-IMP-09); recipes `.twr` with "only new or changed issues" (FR-RCP-01..03); autosave/crash recovery journal (OPFS / disk); `.xls`, Parquet and JSON import; Parquet export profile; mapping templates (FR-IMP-06); data health score (FR-VAL-05); CSV formula neutralisation | Parity suite green on both engines; benchmark published                   |
| **3**                 | CRS transformation (one exact implementation in both engines, decision D-15: done, the `transform_crs` step in both engines and the UI); map view with MapLibre and offline PMTiles, linked to the grid, and the draw-an-area filter (done, section 15); density view for large point sets (FR-MAP-03; done, section 15); the Shapefile export profile for QGIS and ArcGIS with its rules (FR-EXP-04; done, section 10.1); the Google Earth (KML) profile (done, section 10.1); the FlatGeobuf profile, which also replaces a Shapefile past 2 GB (FR-EXP-03; done, section 10.1); the GeoPackage profile on an SQLite file format writer and reader of our own (done, section 10.1, decision D-16); spatial import formats (FlatGeobuf, KML/KMZ, zipped Shapefiles and GeoPackage done, FR-IMP-02)                                                                                                                                                                                                     | Spatial reference cases; GDAL read-back                                   |
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
