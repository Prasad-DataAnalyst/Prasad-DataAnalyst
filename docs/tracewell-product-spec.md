# Tracewell — Product Specification

| | |
|---|---|
| **Product** | Tracewell Data Workbench |
| **Document** | Product specification (PRD) |
| **Version** | 0.1 — draft for review |
| **Date** | 19 October 2026 |
| **Author and owner** | Prasad (Prasad-DataAnalyst) |
| **Status** | Discussion draft. No code has been written. |
| **Evidence base** | `reports/Oil gas LNG data workbench market.md` and `research_notes/` in this repository |

---

## 1. Summary

Tracewell is an offline desktop data workbench for the oil, gas and LNG industry. It lets a user bring in messy technical data, check it, review and correct it, process it with documented methods, filter what they need, and export it in a format the next tool, regulator or counterparty can use immediately.

Its defining promise is **traceability**: every number in every output can be traced back to its source file, the rule or method applied, the version of that rule, and every human decision made along the way.

The first release targets the sharpest unmet need found in the market research: **methane measurement-versus-inventory reconciliation**, with a built-in geospatial layer. Production, LNG and well-data modules follow as separate validated releases on the same core.

---

## 2. Problem

Findings from the October 2026 market research (see the report for sources and evidence labels):

1. **Engineers and analysts lose a large share of their time to data handling.** Files arrive in many formats and layouts; units, depth references, coordinate systems and time zones are inconsistent; reconciliation is done by hand in spreadsheets.
2. **Large exports break common tools.** Historian and sensor exports exceed Excel's 1,048,576-row limit; drone LiDAR flights produce about 1–1.3 GB each.
3. **Methane reporting has an unsolved reconciliation problem.** OGMP 2.0 Level 5 and the EU Methane Regulation require site-level measurements to be reconciled with source-level inventories. Measured emissions run about 1.6–4 times inventories at basin and national scale. Official guidance sets no fixed method. 31 operators were at Level 5 by December 2025, up from 7.
4. **Every commercial methane and analytics platform reviewed is cloud-hosted**, and vendors are reserving new AI features for cloud customers. No offline or open-source tool performs full reconciliation with uncertainty and an audit trail.
5. **Many users cannot or will not send data to the cloud**: plant-network (OT) security policies, data-localisation laws (e.g. Saudi Arabia, UAE, Nigeria, India, China), client confidentiality, and poor connectivity at remote sites.
6. **Rules keep changing.** In October 2026 the European Commission proposed delaying importer methane rules; US federal rules are being rolled back; Canada's are tightening. Templates hard-coded into software go stale quickly.

---

## 3. Goals and non-goals

### 3.1 Goals

- G1. Cut the time to turn raw technical files into a correct, ready-to-use output from hours or days to minutes.
- G2. Make every output verifiable by a reviewer, auditor or regulator without access to the author.
- G3. Work fully offline on an ordinary company laptop, with no data leaving the machine.
- G4. Handle files of 10 GB and larger.
- G5. Keep regulatory logic current through versioned rule-packs, without reinstalling the application.
- G6. Establish the author's professional credibility through published validation evidence.

### 3.2 Non-goals

- Not an engineering simulator (no reservoir, multiphase-flow or process simulation).
- Not a cloud platform, and no online accounts.
- Not a full GIS editor (integrate with QGIS and ArcGIS instead).
- No live connections into plant control systems (SCADA/DCS).
- No AI-generated reported numbers. Any future AI helper suggests; rules and the user decide.
- Not certified for safety-critical or fiscal decisions. Outputs support, and do not replace, qualified review.

---

## 4. Users

| Persona | Typical tasks | Primary needs |
|---|---|---|
| **Emissions / MRV analyst** | Builds inventories, imports measurement campaigns, prepares OGMP and regulatory reports | Reconciliation, uncertainty, rule-packs, audit trail |
| **Verifier / auditor** | Checks an operator's report and evidence | Read-only review, evidence package, reproducibility |
| **HSE / environmental lead** | Reviews results, signs off submissions | Clear issues list, summary, approval workflow |
| **GIS / drone specialist** | Prepares asset locations, plume outlines, survey data | Coordinate handling, map views, format conversion |
| **Production engineer / analyst** | Cleans historian and daily report data | Large-file handling, gap and spike detection, Excel-ready outputs |
| **LNG terminal / commercial analyst** | Checks cargo quantities and quality | Recalculation, ship-vs-shore comparison, unit conventions |
| **Geoscience / data manager** | Prepares well files for regulators | Format validation against submission rules |
| **Manager** | Needs status at a glance | One-page summary, data health score |
| **Student / researcher** | Learns methods on open data | Sample projects, explained checks |

**Most likely early adopters** (from research): consultancies and service companies handling client data, small and mid-size operators, verifiers, national oil company staff under data-sovereignty rules, universities, decommissioning teams and new LNG importers.

---

## 5. Product principles

1. **Never block, never hide.** The application does not stop to ask questions. It detects, applies sensible defaults, and visibly marks every assumption so the user can correct it later.
2. **Pick the destination, not the format.** Users choose where the output is going; Tracewell applies every rule that destination needs.
3. **Validate every output before it leaves.** Exports are read back and checked automatically.
4. **One application, layered for every user.** Simple mode and Expert mode in the same product.
5. **"Best" is measured and published,** never claimed.
6. **Big data is normal.** Stream data; never load whole files into memory.
7. **The author's name, the author's brand.** Authorship, publisher name and code signing belong to the owner.
8. **Register at download, private in use.** The website collects name, email and country; the application collects and sends nothing.
9. **Enterprise quality bar.** Design system, usability testing, accessibility and a release checklist.

---

## 6. Release plan

| Release | Contents | Exit criteria |
|---|---|---|
| **R0 — Core** | Project model, import, validation engine, review and audit, processing, filter, export, recipes, rule-pack loader, conventions engine, large-file engine, map view | Core test suite green; 10 GB benchmark met; messy-file library passes |
| **R1 — Tracewell Methane (+ Geo)** | Inventory import, measurement import, attribution, annualisation, reconciliation with uncertainty, OGMP and verifier outputs | Reference cases reproduced; external MRV specialist review; validation report published |
| **R2 — Tracewell Production** | Historian and daily-report QC, resampling, operating-hours feed into Methane | Reference datasets checked; practitioner review |
| **R3 — Tracewell LNG** | Cargo energy recalculation, ship-vs-shore comparison, per-cargo emissions statement | LNG metering expert sign-off |
| **R4 — Tracewell Wells** | LAS/DLIS/survey validation against regulator rules (UK NDR first) | Regulator rule tests pass on sample submissions |

Each release is labelled **prototype → verified → validated**. A release is never described with a higher label than its evidence supports.

---

## 7. Core workflow

Every module uses the same six stages.

```text
Import → Check → Review → Process → Extract → Export
```

| Stage | What happens |
|---|---|
| **Import** | Files are added; type, columns, units, coordinate system and time zone are detected; originals are never modified |
| **Check** | The validation engine runs rules and produces an issues register |
| **Review** | The user fixes, accepts or excludes issues, each with a reason; every decision is logged |
| **Process** | Standardise units, coordinates and time steps; run documented calculations |
| **Extract** | Filter by date, asset, area (drawn on the map) or field; full or partial datasets |
| **Export** | Choose a destination profile; the output is generated, read back and validated |

Steps from Check to Export are saved as a **recipe** that can be re-run on next month's data.

---

## 8. Core functional requirements

Priority: **M** = must (R0), **S** = should (R0 or R1), **C** = could (later).

### 8.1 Projects

| ID | Requirement | P |
|---|---|---|
| FR-PRJ-01 | A project holds original files (untouched), working data, recipes, issues, decisions and exports | M |
| FR-PRJ-02 | A project saves as a single portable file (`.twp`) that another user can open and fully inspect | M |
| FR-PRJ-03 | Autosave and crash recovery; no work is lost on an unexpected close | M |
| FR-PRJ-04 | Original files are stored with SHA-256 checksums and verified on open | M |
| FR-PRJ-05 | Projects can be organised by site and asset in a project tree | M |

### 8.2 Import

| ID | Requirement | P |
|---|---|---|
| FR-IMP-01 | Tabular: CSV/TSV (any delimiter, encoding, decimal separator), Excel (.xlsx, .xls), Parquet, JSON | M |
| FR-IMP-02 | Spatial: GeoJSON, Shapefile, KML/KMZ, GeoPackage, FlatGeobuf, GeoTIFF/COG, CSV with coordinates | M |
| FR-IMP-03 | Point clouds: LAS/LAZ (1.4) and COPC, for viewing and clipping | S |
| FR-IMP-04 | Well data: LAS 2.0/3.0, DLIS, IOGP P7 deviation surveys | C (R4) |
| FR-IMP-05 | Messy Excel handling: multi-row headers, merged cells, units in header text, dates stored as text, multiple tables per sheet | M |
| FR-IMP-06 | Column mapping screen with detected meaning, unit and confidence; mappings saved per template and reused automatically | M |
| FR-IMP-07 | Detection of units, coordinate reference system, time zone and null-value markers (e.g. -999.25), each with a confidence level | M |
| FR-IMP-08 | Low-confidence detections are applied and marked "assumed", never silently hidden | M |
| FR-IMP-09 | Files are converted to Parquet internally on import; originals kept unchanged | M |

### 8.3 Validation engine

| ID | Requirement | P |
|---|---|---|
| FR-VAL-01 | Rules are declarative, versioned, and identified by a stable rule ID | M |
| FR-VAL-02 | Generic rules: missing values, duplicates, out-of-range values, type mismatches, unit inconsistencies, timestamp gaps and overlaps, spikes, flatlines, invalid geometry, coordinates outside the expected area, swapped latitude and longitude | M |
| FR-VAL-03 | Each issue records rule ID, severity (error / warning / note), affected rows, and a plain-language explanation with the rule's source | M |
| FR-VAL-04 | Issues register with filter, sort, assign, resolve and comment | M |
| FR-VAL-05 | Data health score per dataset, with breakdown by rule category | S |

### 8.4 Review and audit trail

| ID | Requirement | P |
|---|---|---|
| FR-AUD-01 | Every change records old value, new value, reason, user profile and timestamp | M |
| FR-AUD-02 | The audit log cannot be edited from inside the application | M |
| FR-AUD-03 | Local user profiles with roles: Analyst, Reviewer, Viewer | M |
| FR-AUD-04 | Read-only Reviewer mode with comments and sign-off stamps | S |
| FR-AUD-05 | Comparison view: two dataset versions or two periods side by side, with differences explained | S |

### 8.5 Processing

| ID | Requirement | P |
|---|---|---|
| FR-PRC-01 | Unit conversion through a single units library; every conversion logged | M |
| FR-PRC-02 | Coordinate transformation through PROJ with EPSG codes; every transformation logged | M |
| FR-PRC-03 | Time-series resampling and aggregation with explicit handling of gaps | M |
| FR-PRC-04 | Joins, filters and calculated fields without writing code | M |
| FR-PRC-05 | Every calculation method has a cited source, stated applicability range and reference test case | M |

### 8.6 Conventions engine

| ID | Requirement | P |
|---|---|---|
| FR-CNV-01 | Explicit, selectable conventions: standard conditions (60 °F / 14.696 psia, 15 °C / 101.325 kPa, 0 °C), energy units (MMBtu, kWh, GJ), combustion and metering reference temperatures, tonne-to-energy factors | M |
| FR-CNV-02 | Conventions are set per project, per contract or per rule-pack, and shown in the status bar | M |
| FR-CNV-03 | Mixing conventions within one calculation raises an error | M |

### 8.7 Rule-packs

| ID | Requirement | P |
|---|---|---|
| FR-RUL-01 | Regulatory and reporting logic is delivered as signed, versioned rule-pack files (`.twrules`) | M |
| FR-RUL-02 | Rule-packs can be installed offline from a file, without reinstalling the application | M |
| FR-RUL-03 | Every output records the rule-pack names and versions used | M |
| FR-RUL-04 | Administrators can lock rule-pack versions through the policy file | S |
| FR-RUL-05 | Initial rule-packs: OGMP 2.0 reporting; EU Methane Regulation (once templates are final); generic data quality | M (R1) |

### 8.8 Recipes and automation

| ID | Requirement | P |
|---|---|---|
| FR-RCP-01 | Steps from Check to Export are saved as a versioned recipe (`.twr`) | M |
| FR-RCP-02 | Re-running a recipe on new data shows only new or changed issues | M |
| FR-RCP-03 | Recipes contain no data and can be shared | M |
| FR-RCP-04 | Watch folders and scheduled recipe runs, fully offline | C |
| FR-RCP-05 | Command-line batch mode for IT automation | C |

### 8.9 Export

| ID | Requirement | P |
|---|---|---|
| FR-EXP-01 | Destination profiles: Excel, CSV, Parquet, Power BI/Tableau, QGIS/ArcGIS, Google Earth, PDF report, regulator template, verifier package | M |
| FR-EXP-02 | Excel outputs: numbers stored as numbers, real dates, units in headers, single header row, no merged cells in data sheets, frozen header and filters; separate Report and Log sheets | M |
| FR-EXP-03 | Format limits handled automatically: data over Excel's row limit is delivered as CSV/Parquet with an Excel summary; Shapefile over 2 GB is replaced by GeoPackage or FlatGeobuf; the substitution is stated in the output | M |
| FR-EXP-04 | Shapefile exports always include `.prj` and `.cpg`, with a field-name mapping file for names truncated to 10 characters | M |
| FR-EXP-05 | GeoJSON exports in WGS84 as required by RFC 7946 | M |
| FR-EXP-06 | Every export is read back and validated before success is reported | M |
| FR-EXP-07 | Every export is a package: the file(s), a readme with sources, checksums, rule-pack versions, change log and open warnings | M |

### 8.10 Map

| ID | Requirement | P |
|---|---|---|
| FR-MAP-01 | Map view linked to the data grid and charts (selection filters all views) | M |
| FR-MAP-02 | Offline basemap from a regional PMTiles file; optional online basemap when connected; provider configurable | M |
| FR-MAP-03 | Large point sets and point clouds rendered through locally generated vector tiles, with density view when zoomed out | S |
| FR-MAP-04 | Draw an area to filter data | M |

---

## 9. R1 — Tracewell Methane requirements

### 9.1 Scope

Support an operator, consultant or verifier in reconciling source-level (bottom-up) methane inventories with site-level (top-down) measurements, in line with OGMP 2.0 Level 5 and the EU Methane Regulation, and in producing reports and evidence that a verifier can reproduce.

### 9.2 Inputs

| Input | Typical formats |
|---|---|
| Source-level inventory (equipment, emission factors or measured source rates, activity data) | Excel, CSV, OGMP template |
| Asset and equipment locations | GeoJSON, Shapefile, GeoPackage, KML, CSV with coordinates |
| Aerial and drone campaign results | CSV emission rates, GeoJSON plume outlines, GeoTIFF/COG concentration rasters |
| Satellite detections | GeoTIFF/COG, GeoJSON, CSV (e.g. Carbon Mapper, EMIT, UNEP MARS notifications) |
| Continuous monitor data | CSV time series |
| Operating data (hours, states, throughput) | Excel, CSV historian exports (from R2 when available) |
| Wind and weather data | CSV |

### 9.3 Functional requirements

| ID | Requirement | P |
|---|---|---|
| FR-MET-01 | Technology library holding detection threshold, quantification uncertainty and temporal coverage per measurement technology, with cited defaults that users can edit (e.g. continuous monitors ~0.2–1.5 kg/h, aerial LiDAR ~1–3 kg/h, satellites ~66–150 kg/h) | M |
| FR-MET-02 | Consistent asset / site / source hierarchy, with conflicts between definitions flagged | M |
| FR-MET-03 | Plume-to-equipment attribution on the map using location, distance, wind direction and neighbouring sites; ambiguous attributions flagged, never forced | M |
| FR-MET-04 | Matching of inventory and measurements on the same spatial and temporal basis before comparison | M |
| FR-MET-05 | Annualisation assistant combining snapshot measurements with operating data, with sensitivity of the annual total to assumptions shown | M |
| FR-MET-06 | Non-detects treated as "below detection threshold", never as zero | M |
| FR-MET-07 | Uncertainty propagated for both inventory and measurements (Monte Carlo supported); every result shown as a value with a range | M |
| FR-MET-08 | Reconciliation view: inventory vs measurement per site, gap chart, uncertainty bands, drill-down to sources and measurements | M |
| FR-MET-09 | Discrepancy investigation log: each significant gap gets a recorded explanation and resulting adjustment | M |
| FR-MET-10 | Every individual measurement retained and reportable, as OGMP guidance expects | M |
| FR-MET-11 | Coverage checks against OGMP expectations (configured in the rule-pack and verified against the current guidance) | S |
| FR-MET-12 | Outputs: OGMP 2.0 reporting template, EU Methane Regulation templates (once the implementing regulation is final), reconciliation report (PDF), verifier evidence package | M |
| FR-MET-13 | Satellite detections can trigger investigation but are not accepted as the site-level measurement method where the guidance excludes them | S |

### 9.4 Reference basis (to verify against current versions before implementation)

- OGMP 2.0 Uncertainty and Reconciliation Guidance (Steering Group final draft, 2022; re-hosted 2025).
- Regulation (EU) 2024/1787 and its implementing acts, including the draft reporting templates of 9 October 2026 and the postponement proposal of 14 October 2026.
- Published reconciliation studies cited in the research report.

---

## 10. Later modules (summary)

### R2 — Tracewell Production
Historian, SCADA and daily-report imports; gap, flatline, spike, time-zone and daylight-saving checks; resampling; historian-vs-accounting comparison; Excel-ready daily and monthly reports; operating-hours output for Methane annualisation.

### R3 — Tracewell LNG
Custody-transfer recalculation (delivered energy from volume, density and gross calorific value, with displaced vapour and engine-room gas); calorific value from composition per ISO 6976; ship-vs-shore comparison; boil-off tracking; per-cargo emissions statement; explicit conventions (MMBtu/kWh, reference temperatures, conversion factors). Requires an LNG metering expert for validation. Positioned as an independent check, not the official custody-transfer system.

### R4 — Tracewell Wells
LAS/DLIS/WITSML 1.4.1.1/P7 import; null-value, curve-name, depth-reference and unit checks; TVD from deviation surveys (minimum curvature); validation against regulator submission rules (UK National Data Repository first, then Australia and the Netherlands).

---

## 11. User interface requirements

### 11.1 Style

Enterprise engineering software, not a chat-style AI application. Reference standard: ArcGIS Pro, Spotfire, Power BI Desktop, Petrel, VS Code.

### 11.2 Main window

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ File  Edit  View  Data  Analysis  Map  Reports  Tools  Help                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Import] [Check] [Review] [Process] [Extract] [Export]   Rule-pack: OGMP v1.0 │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│ PROJECT TREE  │  Tabs: Data | Map | Chart | Reconciliation   │ PROPERTIES    │
│               │                                              │               │
├───────────────┴──────────────────────────────────────────────┴───────────────┤
│ ISSUES | LOG | JOBS                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● Offline   Saved 10:42   Rule-pack OGMP v1.0   Units SI   2.4M rows         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 11.3 Screens

1. Start page (recent projects, templates, sample projects, rule-pack status)
2. Import wizard with column-mapping grid
3. Data workspace (virtual grid for millions of rows, filters, column statistics)
4. Issues register
5. Map view
6. Reconciliation view (R1)
7. Recipe editor (visual step list, no code)
8. Export centre (destination profiles, preview, validation)
9. Review and sign-off
10. Settings and administrator policy

### 11.4 Standards

| ID | Requirement |
|---|---|
| UI-01 | Design system defined before implementation (colour, typography, spacing, icons, components) |
| UI-02 | Neutral palette with one brand accent; red, amber and green used only for status |
| UI-03 | Tabular figures for all numeric columns |
| UI-04 | Compact and comfortable density modes; light and dark themes |
| UI-05 | WCAG 2.2 AA accessibility, full keyboard operation, screen-reader labels, colour-blind-safe charts and maps |
| UI-06 | Command palette, keyboard shortcuts, undo/redo for every action, dockable panels, saved layouts, multi-monitor support |
| UI-07 | Error messages state what happened and how to fix it |
| UI-08 | Units, conventions and assumptions always visible |
| UI-09 | Interface translatable, including right-to-left languages; English first |
| UI-10 | Usability test with practitioners before each release |

---

## 12. Non-functional requirements

Targets are to be benchmarked on a reference laptop (16 GB RAM, SSD, 4+ cores).

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Interface response to any click | < 100 ms |
| NFR-02 | First preview of a newly imported file | < 5 s, regardless of file size |
| NFR-03 | Import and convert a 10 GB CSV | Minutes, not hours (target set after first benchmark) |
| NFR-04 | Memory use | Never exceeds a configurable limit (default 50% of RAM); spills to disk instead of failing |
| NFR-05 | Long jobs | Run in background with progress, cancel and resume |
| NFR-06 | Determinism | Same input + same recipe + same rule-packs = same output |
| NFR-07 | Offline | All features work with no network; no telemetry; network use only for optional basemaps and only when enabled |
| NFR-08 | Security | Signed builds; published software bill of materials; visible network on/off indicator; security statement for IT approval |
| NFR-09 | Platforms | Windows first; macOS and Linux to follow |
| NFR-10 | Installation | Per-user install without admin rights; silent MSI for enterprise deployment; portable edition |
| NFR-11 | Minimum hardware | 8 GB RAM (slower); recommended 16 GB RAM, SSD, free disk ~3× data size |
| NFR-12 | Accessibility | WCAG 2.2 AA |

---

## 13. Architecture overview

Detailed design will be in a separate Software Architecture Document. Direction:

| Layer | Direction |
|---|---|
| Desktop shell | Tauri, with an HTML/TypeScript interface |
| Data engine | DuckDB for out-of-core SQL on CSV/Parquet; Parquet as the internal working format |
| Spatial | GDAL and PROJ (EPSG registry) |
| Map | MapLibre with PMTiles offline basemaps |
| Calculation library | Separate from the UI; cited methods; reference tests |
| Plugins | File-format adapters and modules as plugins with their own tests |
| Browser Lite edition | Same interface with an in-browser engine, for small files and quick checks |

Every third-party component's licence is reviewed before adoption. Components whose models or data are licensed for non-commercial use only are excluded from the core.

---

## 14. File types

| Extension | Content |
|---|---|
| `.twp` | Tracewell project (originals, working data, recipes, issues, audit log, exports) |
| `.twr` | Tracewell recipe (steps only, no data) |
| `.twrules` | Signed, versioned rule-pack |

---

## 15. Distribution, licence and privacy

| Topic | Decision |
|---|---|
| Source code | Open source on GitHub (licence to be confirmed after dependency review; Apache-2.0 preferred) |
| Official installers | Signed, distributed from tracewell.uk after registration |
| Registration fields | Name, email, country, plus licence acceptance and a separate unticked marketing opt-in |
| Email verification | Download link sent by email, expiring after ~48 hours |
| In-application data collection | None |
| Privacy | Privacy policy covering GDPR/UK GDPR and other applicable laws; access and deletion requests via privacy@tracewell.uk; encrypted storage; breach-response plan |
| Sanctions | Registration refused from countries subject to EU/UK oil and gas software restrictions (including Russia) and comprehensive sanctions; list maintained with legal advice |
| Export control | Publicly available open-source status and any encryption notification confirmed with counsel |
| Trademark | "Tracewell" searched and registered before public launch |
| Authorship | Copyright, About screen, installer publisher and code-signing certificate in the owner's name |

---

## 16. Verification and validation

| Item | Requirement |
|---|---|
| Messy-file test library | Synthetic broken files plus open datasets; every bug found becomes a new test file |
| Reference cases | Every calculation reproduced against a published worked example or independent implementation |
| Unit and property tests | Units, limits, monotonicity and conservation checks |
| Export tests | Outputs opened automatically by independent readers (GDAL, LibreOffice, Python) |
| Expert review | Each method reviewed by a qualified practitioner before the "validated" label |
| Release labels | Prototype → verified → validated, applied per feature |
| Validation report | Published with every release: what was tested, against what, and observed differences |

---

## 17. Success metrics

| Metric | How measured |
|---|---|
| Time from file drop to usable output | Benchmark tasks; user reports |
| Files imported with no manual fixes | Share of the messy-file library and of user files |
| Silent errors | Zero; every assumption visible |
| First-time export success | Share of exports opening correctly in the target tool |
| Errors caught before submission | Issues found and resolved per project |
| Returning users | Users re-running recipes in a later month (from voluntary feedback, not telemetry) |
| Registered downloads by country | From the website registration (published only as totals) |
| Practitioner endorsements | Named reviewers and case studies with permission |

---

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Spreading a solo build across five domains | Strict release order; one module validated before the next starts |
| Wrong numbers damaging credibility | Cited methods, reference tests, expert review, release labels |
| Regulatory changes | Versioned rule-packs; no hard-coded templates |
| Corporate IT blocking installation | Per-user install, portable edition, signed builds, security statement, open code |
| Demand is inferred, not measured | Early conversations (including LinkedIn responses); practitioner panel; sample projects |
| Licence conflicts in dependencies | Licence review before adoption; exclude non-commercial components from the core |
| Privacy and sanctions obligations of the download form | Legal review before launch |
| Name or trademark conflict | Trademark search before launch |

---

## 19. Open decisions

| Decision | Current direction |
|---|---|
| Open-source licence | Apache-2.0, pending dependency review |
| First jurisdiction for R1 outputs | OGMP 2.0 first; EU Methane Regulation templates when final |
| Engine implementation language | To be settled in the architecture document |
| First operating system | Windows |
| Global domain in addition to tracewell.uk | Deferred until before public launch |

---

## 20. Glossary

| Term | Meaning |
|---|---|
| **OGMP 2.0** | Oil & Gas Methane Partnership 2.0, UNEP's methane reporting framework; Level 5 requires reconciliation of source-level and site-level data |
| **EU Methane Regulation** | Regulation (EU) 2024/1787 on methane emissions in the energy sector |
| **MRV** | Measurement, reporting and verification |
| **Inventory (bottom-up)** | Emissions estimated source by source from factors or source measurements |
| **Site-level (top-down)** | Emissions measured for a whole site from aircraft, drones, satellites or continuous monitors |
| **Reconciliation** | Comparing and explaining differences between inventory and site-level results, then adjusting the reported figure |
| **Annualisation** | Converting short measurements into an annual total |
| **Rule-pack** | A versioned file of rules and templates for a framework or regulator |
| **Recipe** | A saved, re-runnable sequence of processing steps |
| **CRS / EPSG** | Coordinate reference system / the registry of coordinate system codes |
| **Custody transfer** | The measured handover of LNG between seller and buyer |

---

## 21. References

- Market research report: `reports/Oil gas LNG data workbench market.md`
- Research notes: `research_notes/Oil gas LNG data workbench market/`
