# Messy-file library

Small files that break an importer in the ways real oil, gas and LNG files do, each with the result
Tracewell must produce from it (SAD section 13.2). Unit, golden and conformance tests load them
through `fixtures/index.ts` (`@tw/fixtures`); the e2e suite uploads them from `fixtures/messy`.

```text
fixtures/
├── index.ts                     loader: FIXTURE_NAMES, FIXTURES_DIR, fixturePath, fixtureBytes, fixtureSource, fixtureExpectation
├── names.ts                     FixtureName and FIXTURE_NAMES
├── expectation.ts               FixtureExpectation and the check of expected files
├── fixtures.test.ts             checks the library itself (checksums, bytes, expected files, XLSX structure)
├── expectation.test.ts          the expected-file check on malformed documents
├── generators.test.ts           the generators reproduce the library; the large CSV is deterministic
├── messy/
│   ├── <name>                   29 fixtures, byte-exact (.gitattributes marks them binary)
│   ├── <name>.expected.json     what importing and checking <name> must give
│   └── SHA256SUMS               SHA-256 of every fixture, for `sha256sum -c SHA256SUMS`
└── generators/
    ├── make_xlsx_fixtures.py    the 6 XLSX files (openpyxl, 4 of them saved again by LibreOffice)
    ├── gen-text-fixtures.mjs    the 22 CSV, TSV, GeoJSON and JSON files with exact bytes, the Parquet file, then SHA256SUMS
    ├── gen-large-csv.mjs        seeded large CSV for the @slow tests (never committed)
    └── shared.mjs               fixture list, seeded random numbers, the Hampel test used by the generators
```

## Rules for the library

- **Never edit a fixture by hand.** Change its generator, run `npm run fixtures` (XLSX first, then
  the text files and SHA256SUMS), and review every expected file the change touches. The text
  generator must reproduce the committed text files byte for byte (a test checks this). With
  openpyxl 3.1.5 and LibreOffice 24.2 the XLSX generator is reproducible too.
- **Every bug found becomes a fixture** (PRD section 16): add the file to the generator, to
  `FIXTURE_NAMES` in `index.ts`, to `ALL_FIXTURES` in `generators/shared.mjs`, write its
  `.expected.json` and add a row to the catalogue below.
- Fixture data is invented. Well, vessel, company and person names are fictional; locations are
  plausible but not real wells.

## The loader

```ts
import { FIXTURE_NAMES, fixtureBytes, fixtureSource, fixtureExpectation } from '@tw/fixtures';

const bytes = fixtureBytes('csv_utf8_bom_crlf.csv'); // a fresh Uint8Array on every call
const source = fixtureSource('xlsx_date1904.xlsx'); // a ByteSource over those bytes
const expected = fixtureExpectation('csv_null_markers.csv'); // the parsed, checked expected file
```

The loader is for Node (tests and tools). It reads from disk synchronously and throws a plain
`Error` naming the file when a fixture or its expected file is missing or malformed.

## Expected files

`<name>.expected.json` is a `FixtureExpectation` (see `index.ts`):

| Field            | Meaning                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`, `format` | The fixture and its format: `csv`, `tsv`, `xlsx`, `geojson`, `json` or `parquet`.                                                                                                                                                                           |
| `detections`     | Dataset-level detections. CSV/TSV: `encoding`, `delimiter`, `decimalSeparator`, `skipLines`, `headerRows`, and `crs` when the file has latitude/longitude columns. XLSX: `sheet`, `date1904`, `skipLines`, `headerRows`. GeoJSON: `encoding`, `crs`.        |
| `confidence`     | The confidence of each listed detection (`high`, `medium`, `low`). A detection is assumed when it is not `high` or is a default.                                                                                                                            |
| `rowCount`       | Data rows imported.                                                                                                                                                                                                                                         |
| `columns`        | Every column in source order: `name` (after the unit is taken out of the header), logical `type`, registry `unit` code or `null`, `role`, and `assumed`: the column's assumed detections, in alphabetical order. `assumed` is left out when there are none. |
| `issues`         | Rule ID to affected count after import and one check run with `tracewell.generic-dq` and the import-note rules, with no project area set. A rule ID that is not listed must not be raised.                                                                  |
| `notes`          | Import note codes the readers emit, unique and sorted.                                                                                                                                                                                                      |
| `locators`       | Optional: the source locator of every data row and of each note, where a fixture tests them.                                                                                                                                                                |
| `workingDigest`  | Optional: the view digest of the imported working view, added once stable.                                                                                                                                                                                  |

## Conventions behind the expectations

These are the rules the expected files were counted with. Detection, ingest and rule
implementations must follow them, or the golden tests fail.

### Detections and columns

- **Encoding** follows `io.sniffEncoding`: a byte-order mark is `high`; ASCII or valid UTF-8 is
  `high`; the windows-1252 fallback is `low` and a default (raises `TW-IMP-004`).
- **Decimal separator**: in a comma-delimited file a point is `high` even without fractions; in
  other files three or more numbers with a fractional part prove the separator.
- **CSV skip lines and header rows**: `skipLines` counts the physical lines above the header,
  title rows included. A two-row header (names, then units) gives `headerRows: 2`.
- **XLSX**: `skipLines` is the 0-based sheet row of the first header row; `headerRows` counts every
  header row, a units row included. A flattened header reads `Level 1 / Level 2 [unit]`; in these
  fixtures the units row holds registry codes, so every flattened header text is
  `` `${name} [${unit}]` `` (or just `name`) from the expected columns.
- **Column names and units** come from `units.parseHeaderUnit`. A unit is assumed when that
  function's confidence is not `high` (`gas_rate_kg_h` and `Depth ft` are `medium`).
- **Types** are taken from the values: `integer` when every value is a whole number written without
  a fractional part, `number` for other numbers, then `boolean`, `date` and `datetime`, otherwise
  `string`. Values with leading zeros (`0012`) keep a column `string`. ISO 8601 date-times may use a
  space instead of `T` and may leave out the seconds. Null markers and below-detection-limit text do
  not count against a type. A column's **type is assumed** when some of its values do not fit it
  (each raises `TW-DQ-004`), when plain numbers are read as Excel serial dates because the header
  names a date, and when GeoJSON property values that are objects or arrays are kept as JSON text.
  In these fixtures at most 2 values in 10 of a column fail to fit.
- **Date formats**: day/month order is resolved by a value above 12; without one, `dmy` is assumed
  (`dateFormat` is assumed and the column raises `TW-TIME-005`).
- **Time zones** apply to `datetime` columns only. A `Z` or an offset gives `utc` or `offset`; a
  value without one, XLSX date-times included, is read as UTC and the `timezone` detection is
  assumed (`TW-TIME-004`).
- **Null markers**: `''` and `N/A`-style markers are found with high confidence; a numeric sentinel
  (`-999.25`, `-9999`) is adopted only when it occurs at least twice in the column, and is assumed.
- **Roles**: `id` for a name that is `id` or ends in `_id`, ` id` or `-id` (any case);
  `latitude` for `lat`/`latitude`, `longitude` for `lon`/`long`/`lng`/`longitude`; `time` for date
  and date-time columns; `measure` for other integer and number columns; `geometry` for the
  GeoJSON geometry; `text` for everything else (strings and booleans). Role detections are never
  assumed in these fixtures.
- **CRS**: GeoJSON is `OGC:CRS84` (`high`) unless a legacy `crs` member names another system
  (`high`). A CSV with latitude and longitude columns gets `EPSG:4326` with `medium` confidence.
- **GeoJSON columns**: properties in first-seen order, then the geometry column `geometry`.
- **TW-IMP-005** is raised once (dataset scope) when any dataset or column detection is assumed.

### Issues

Counts are per rule ID: for a rows-scope issue the number of rows it flags, for a column- or
dataset-scope issue 1, summed over the rule's issues (one per column, or one for the dataset).

| Rule                         | Scope            | Counts                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TW-DQ-001                    | rows, per column | Cells with no value in every non-geometry column: empty cells, null markers, missing fields of short rows, absent GeoJSON properties. A value kept as raw text (`TW-DQ-004`, `TW-DQ-007`) is not missing.                                                                                                         |
| TW-DQ-002                    | rows             | Every row of each group of identical rows, the first one included.                                                                                                                                                                                                                                                |
| TW-DQ-003                    | rows             | Every row of each group sharing (id, time); needs an `id` and a `time` column.                                                                                                                                                                                                                                    |
| TW-DQ-004                    | rows, per column | Values that do not parse into the column type, error cells included.                                                                                                                                                                                                                                              |
| TW-DQ-005                    | rows, per column | Measure values outside the physical bounds of their unit's quantity (`units.physicalBounds`). Gauge pressure has no lower bound.                                                                                                                                                                                  |
| TW-DQ-006                    | rows, per column | Non-empty values matched as null markers.                                                                                                                                                                                                                                                                         |
| TW-DQ-007                    | rows, per column | Below-detection-limit text (`<x`, `ND`).                                                                                                                                                                                                                                                                          |
| TW-UNIT-001                  | column           | Measure columns without a unit.                                                                                                                                                                                                                                                                                   |
| TW-UNIT-002                  | rows, per column | In a string column whose values carry a unit (`units.splitValueUnit`), values whose unit differs from the column's most frequent unit (ties: the unit seen first).                                                                                                                                                |
| TW-TIME-001                  | rows             | Like TW-DQ-003, grouped by the id column when there is one, otherwise by time alone.                                                                                                                                                                                                                              |
| TW-TIME-002                  | rows             | Rows whose time is earlier than the previous row's of the same id group, in file order.                                                                                                                                                                                                                           |
| TW-TIME-003                  | rows             | After sorting each id group by time (then file order): rows whose step from the previous row exceeds 3 times the group's median step. Zero steps (duplicates) are left out of the median and never flagged.                                                                                                       |
| TW-TIME-004                  | column           | `datetime` columns with an assumed time zone.                                                                                                                                                                                                                                                                     |
| TW-TIME-005                  | column           | Date columns with an assumed day/month order.                                                                                                                                                                                                                                                                     |
| TW-TIME-006                  | rows, per column | Measure values in runs of 6 or more identical consecutive values (sorted as for TW-TIME-003; a null ends a run).                                                                                                                                                                                                  |
| TW-TIME-007                  | rows, per column | Hampel identifier per measure column, sorted as for TW-TIME-003, nulls left out: window 7 (3 values each side), MAD scaled by 1.4826, k = 3. A value is flagged when MAD > 0 and its distance from the window median exceeds 3 x 1.4826 x MAD. Values with fewer than 3 neighbours on either side are not tested. |
| TW-GEO-001                   | rows             | Rows whose geometry has a problem from `geo.geometryProblems` (other than `SKIPPED_TOO_LARGE`).                                                                                                                                                                                                                   |
| TW-GEO-002                   | rows             | WGS84 datasets only: rows with a valid geometry outside -180..180 / -90..90, or with latitude/longitude values out of range.                                                                                                                                                                                      |
| TW-GEO-003                   | rows             | WGS84 datasets only: rows `geo.likelySwapped` flags. Without a project area only a latitude beyond 90 that is valid once swapped counts, and such a row also counts for TW-GEO-002.                                                                                                                               |
| TW-GEO-004                   | dataset          | CRS not `OGC:CRS84` or `EPSG:4326`.                                                                                                                                                                                                                                                                               |
| TW-GEO-006                   | rows             | Rows with a null geometry.                                                                                                                                                                                                                                                                                        |
| TW-IMP-001                   | rows             | Ragged rows, short or long.                                                                                                                                                                                                                                                                                       |
| TW-IMP-002, -003, -004, -005 | dataset          | Additional table found, multi-row header flattened, encoding assumed, detections assumed.                                                                                                                                                                                                                         |

The time-series rules (TW-DQ-003, TW-TIME-001 to -003, -006, -007) need a `time` column; they use
the first `time` column and group by the first `id` column when there is one. Every generated
series is kept clean of stray spikes under a wider form of the Hampel test as well (edges tested
over the part of the window that exists, MAD 0 not exempt), so the spike counts hold whichever of
those variants an implementation picks.

## Catalogue

Producer, encoding and line endings are given for each file. Rows means data rows.

### CSV and TSV

| File                                          | Rows | What it breaks                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csv_well_daily_golden.csv`                   | 271  | The reference file: a daily report for 3 wells over 90 days (1 Dec 2025 to 28 Feb 2026), UTF-8 (ASCII), LF. Clean except for what the conformance scenario needs: the dates are naive date-times (`2026-01-01T06:00:00`, TW-TIME-004), the latitude/longitude columns make the CRS an assumed WGS84, and NS-A02's reading for 15 January was re-sent with the pressure 0.4 psi higher (duplicate key: row IDs 136 and 137, lines 138 and 139). January holds 94 rows. |
| `csv_semicolon_decimalcomma_cp1252.csv`       | 20   | A German export: windows-1252 (`°`, `³`, `ö`, `ü`, `€` as single bytes 0xB0, 0xB3, 0xF6, 0xFC, 0x80, and no valid UTF-8 sequence), CRLF, `;` delimiter, decimal commas, `.` digit grouping in the gas column (`12.444,3`), `dd.mm.yyyy` dates, and a comma inside an unquoted remark.                                                                                                                                                                                 |
| `csv_utf8_bom_crlf.csv`                       | 12   | UTF-8 with a byte-order mark and CRLF; letters outside Latin-1 (`Ł`, `ė`, `ś`, `Š`, `Č`); a quoted field holding a comma; integer volume and energy columns; times with `Z`. Raises nothing.                                                                                                                                                                                                                                                                          |
| `tsv_utf16le_bom.tsv`                         | 10   | Excel's "Unicode text": UTF-16LE with a byte-order mark (`FF FE`), tabs, CRLF, Greek and Polish names. Raises nothing.                                                                                                                                                                                                                                                                                                                                                |
| `csv_title_rows_units_in_header.csv`          | 8    | Three title lines above the header (`skipLines` 3, header on line 4, data on lines 5-12) and units written four ways: `(psia)`, `[°F]`, `_kg_h` and ` ft`. The last two are medium-confidence, so assumed.                                                                                                                                                                                                                                                            |
| `csv_null_markers.csv`                        | 16   | One well over 16 days. The pressure column holds `-999.25` three times, `N/A` twice and one empty cell; the oil column holds a single `-9999`, which is not adopted as a marker, so it stays a value: physically impossible and a spike.                                                                                                                                                                                                                              |
| `csv_quoted_newlines_ragged.csv`              | 10   | Quoted fields with LF and CRLF line breaks inside (records on lines 2, 4, 5, 6, 8, 9, 13, 14, 15, 16), doubled quotes, a short row (line 8, its downtime missing) and a long row (line 13, an extra field). The ragged rows make the comma only medium-confidence.                                                                                                                                                                                                    |
| `csv_duplicates_rows_and_keys.csv`            | 28   | Hourly data for 2 meters. Two records were posted twice in a row (identical rows) and two corrections were re-sent at the end of the file (same key, different flow), so they are also out of order.                                                                                                                                                                                                                                                                  |
| `csv_dates_ambiguous_and_mixed.csv`           | 10   | Five date columns: `reported` d/m/y with no day above 12 (ambiguous, `dmy` assumed), `inspected` m/d/y resolved by days above 12, `logged` ISO with two values in other formats (`3 Feb 2026`, `Feb 7 2026`), `shipped` y/m/d with slashes, `started` naive date-times with a space and no seconds. No id column.                                                                                                                                                     |
| `csv_leading_zero_ids_ndl.csv`                | 10   | Sample identifiers and batch numbers with leading zeros (stay text) and below-detection-limit text in numeric columns: `<0.5` twice and `ND` for benzene, `<1` for H2S.                                                                                                                                                                                                                                                                                               |
| `csv_latlon_swapped_out_of_range.csv`         | 12   | Gulf of Mexico well locations (longitudes below -90). GM-004 and GM-009 have latitude and longitude swapped (latitude beyond -90, detectable without a project area); GM-006 has latitude 128.3307 and GM-011 longitude -193.4471, typos that swapping does not fix.                                                                                                                                                                                                  |
| `csv_timeseries_gaps_dups_flatline_spike.csv` | 88   | Hourly SCADA data from 1 April 2026 for P-101 and P-102. P-101: hours 10-14 missing (a 6-hour step), a second record for hour 30, flow stuck at 149.50 for hours 20-27 (8 rows), a temperature spike at hour 38. P-102: hours 25-28 missing (a 5-hour step), hours 40 and 41 written in reverse order, a pressure spike at hour 16.                                                                                                                                   |
| `csv_mixed_units_in_cells.csv`                | 8    | Units inside the cells, mixed within a column: pressure in psia (5), bar (2) and kPa (1); temperature as `degF`/`°F` (6) and `degC`/`°C` (2). These columns stay text. `Choke size` is numeric with no unit.                                                                                                                                                                                                                                                          |
| `csv_pipe_delimited.csv`                      | 8    | A legacy well master: `                                                                                                                                                                                                                                                                                                                                                                                                                                               | ` delimiter, commas inside unquoted operator names (so splitting on commas also gives multi-field lines), and no line break after the last row. Raises nothing. |
| `csv_physical_impossible.csv`                 | 10   | One test per well. Impossible: -5.0 psia, -300.0 °C, -12.5 bbl/d, water cut 104.20 % and -0.50 %. Possible although odd: -10.0 °C and a gauge pressure of -3.2 psig.                                                                                                                                                                                                                                                                                                  |

### XLSX

| File                                    | Producer                   | Rows | What it breaks                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | -------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xlsx_merged_two_row_header_units.xlsx` | openpyxl, then LibreOffice | 12   | Sheet `Report`: a title in A1 merged across A1:H1, a two-row header with merged cells (A2:A3, B2:B3, C2:D2, E2:F2, G2:G3, H2:H3), a units row (row 4), data from row 5. Flattened headers: `Well ID`, `Date`, `Pressure / Max [psia]`, `Pressure / Min [psia]`, `Temperature / Max [degF]`, `Temperature / Min [degF]`, `Oil rate [bbl/d]`, `Gas rate [Mscf/d]`.                                                  |
| `xlsx_text_and_serial_dates.xlsx`       | openpyxl, then LibreOffice | 8    | Sheet `Readings`: `Read date` holds date cells except B5 and B8, which hold the same dates typed as text (`2026-03-03`, `2026-03-05`); `Read time` holds date-time cells (no time zone); `Install date` holds plain numbers with the General format (45292 is 2024-01-01, 45444 is 2024-06-01); `Calibrated` holds d/m/y text resolved by `15/01/2026`.                                                           |
| `xlsx_two_tables_one_sheet.xlsx`        | openpyxl                   | 7    | Sheet `Summary`: a production table at A1:E8 and, after two blank rows, a downtime table at A11:C15. The first is imported; TW-IMP-002 names `A11:C15`. Strings are inline (`t="inlineStr"`).                                                                                                                                                                                                                     |
| `xlsx_date1904.xlsx`                    | openpyxl                   | 10   | The 1904 date system (`<workbookPr date1904="1"/>`). Daily!B2 is serial 44591, which is 2026-01-31 in the 1904 system (and 2022-01-30 if read as 1900).                                                                                                                                                                                                                                                           |
| `xlsx_hidden_sheets_formulas.xlsx`      | openpyxl, then LibreOffice | 10   | Sheets `Config` (hidden, first), `Production` (visible, the default) and `Notes` (very hidden). Formulas with cached values: `Liquid` is `IF(COUNT(C:D)=2,C+D,"")`, `Water cut` divides by the liquid rate and multiplies by `Config!$B$2`. NS-E02 has no readings on 4 March (row 7): oil and water are blank, the liquid formula gives an empty string and the water cut cell is the error `#DIV/0!` (`t="e"`). |
| `xlsx_numbers_as_text.xlsx`             | openpyxl, then LibreOffice | 8    | Sheet `Wells`: identifiers with leading zeros (`0042`) and numbers stored as text (shared strings, `t="s"`): every oil value, and half of the water values next to real numbers.                                                                                                                                                                                                                                  |

LibreOffice 24.2 saves a very hidden sheet as hidden; the generator writes `state="veryHidden"`
back into `xl/workbook.xml` for `Notes`. That and fixed ZIP entry times are the only changes made
after a producer saves a file.

### GeoJSON

All are UTF-8 FeatureCollections written with two-space indentation and a final line break.

| File                                          | Rows | What it breaks                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `geojson_wells_points_wgs84.geojson`          | 10   | Clean RFC 7946 points in the North Sea with property keys holding units (`TD (m)`) and non-ASCII names. Raises nothing.                                                                                                                                                                                                                          |
| `geojson_legacy_crs_27700.geojson`            | 6    | A legacy top-level `crs` member (`urn:ogc:def:crs:EPSG::27700`, before `features`) and British National Grid coordinates in metres, which are not longitudes and latitudes.                                                                                                                                                                      |
| `geojson_invalid_geometries.geojson`          | 12   | Features 2, 4, 6, 7, 8, 10 and 12 (1-based) are invalid: ring not closed, ring of three positions, bow-tie ring, line with one position, `null` longitude, MultiPolygon without coordinates, unknown type `Circle`. Feature 11 has a null geometry. The rest are valid; every feature is still imported. The `note` property says what is wrong. |
| `geojson_swapped_lonlat.geojson`              | 10   | Points off Western Australia (longitudes near 115.7); WA-03, WA-06 and WA-09 are written latitude first, which puts their latitude beyond 90.                                                                                                                                                                                                    |
| `geojson_mixed_geometry_nested_props.geojson` | 8    | Every geometry type, a GeometryCollection included; nested properties (`operator` objects, `tags` arrays, one empty) kept as JSON text; `Capacity (MMscf/d)` numeric except `"pending"`; `commissioned` absent from MX-07; boolean `active`.                                                                                                     |
| `json_api_wrapper_nested.json`                | 6    | An API response: the rows sit under `data`, beside paging members (`status`, `count`, `next`). `Water cut (%)` is absent from NS-B04 and null in NS-B03; `comment` first appears in NS-B05; `choke` holds objects (kept as JSON text); NS-B06 has a water cut of 140 %.                                                                          |
| `jsonl_well_tests_crlf.jsonl`                 | 7    | JSON Lines with CRLF line endings and a blank fourth line; WT-04 has `-999.25` as a number, which occurs once and so is read as data (`TW-DQ-005`: below the physical limit); `notes` first appears in WT-06. Rows are located by line.                                                                                                          |
| `parquet_well_daily_typed.parquet`            | 8    | Typed Parquet columns: text, DATE, TIMESTAMP_MICROS (UTC), DOUBLE with a unit in its name and one null, INT64 and BOOLEAN; `remark` is null except on the shut-in day.                                                                                                                                                                           |

## Large generated CSV

`gen-large-csv.mjs` streams a daily well report of any size to disk for the `@slow` tests and
benchmarks. It is never committed.

```text
node fixtures/generators/gen-large-csv.mjs --rows 1000000 --seed 42 --out <path>
```

The columns are those of `csv_well_daily_golden.csv` plus `Water (bbl/d)`, 10 in all. The same
seed and row count always give the same bytes, on every platform.
