# Subsurface/Well Data and Geospatial/Drone/LiDAR Data Management in Oil & Gas (state as of Oct 2026)

Research date: 2026-10-19. Scope: data formats, tools, market sizes, regulations and pain points for (a) subsurface and well data and (b) geospatial, survey, drone and LiDAR data in oil & gas. It feeds a market study for an offline desktop workbench that imports, validates, converts and exports these data, including files of 10 GB+.

Method note: about 45 web searches and fetches were run. Primary sources were read where possible: the NSTA NDR Form & Manner (Sept 2025), the Energistics April 2026 agenda, the Seequent 2021 report and PyPI package metadata, all text-extracted and read in full. The shared web-search budget ran out partway through, so some regional and tool-ownership questions stay open (see the Gaps sections). Market-research numbers are **estimates** from commercial publishers and are labelled as such. "Verified" means read on the primary source page or document.

---

## 1. Subsurface and well data: formats, versions, data-quality issues, typical volumes

### Takeaway
The working well-data stack is still dominated by old, file-based formats: LAS 2.0 (ASCII), DLIS/LIS (binary RP66), WITSML 1.4.1.1 for drilling, SEG-Y rev 0/1/2 for seismic, and IOGP P7 or ASCII for deviation surveys. Newer standards exist but adoption is slow: LAS 3.0 (2000), WITSML 2.1 / RESQML 2.2 / PRODML 2.2 (2022), SEG-Y rev 2.1 (2023) and OSDU. Recurring data-quality failures are null-value handling, duplicate or mislabelled mnemonics, depth-reference (KB/DF/GL/MSL) and MD/TVD confusion, non-conforming headers, and legacy raster logs. Together these create steady demand for validation and conversion tooling.

### Cited Findings

**LAS (CWLS Log ASCII Standard)**
- The LAS 3.0 File Structure spec is CWLS "Release 3.00", dated June 6, 2000. The ~Version and ~Well sections must come first and second. Data is organised in groups (Parameter, Column Definition, Column Data). LAS 3.0 adds tops, core data, deviation surveys and drill tests, and is designed to be backward compatible with 2.0 readers. — [BC Energy Regulator copy of CWLS LAS 3.0 spec](https://www.bc-er.ca/files/operations-documentation/Oil-and-Gas-Operations-Manual/Supporting-Documents/las3filestructure.pdf)
- USGS describes LAS 2.0 as "the most used digital well log distribution format." — [USGS NGGDPP – LAS format](https://www.usgs.gov/programs/national-geological-and-geophysical-data-preservation-program/las-format)
- The UK National Archives PRONOM registry holds a file signature for LAS 3.0 (starts with ~VERSION, then a mandatory ~Well section) and points to the CWLS specifications. — [PRONOM fmt/391](https://pronom.nationalarchives.gov.uk/fmt/391)
- State geological surveys run QA on LAS with CWLS "LAS Certify" plus Python scripts (Kentucky example). — [USGS – well log data](https://www.usgs.gov/programs/national-geological-and-geophysical-data-preservation-program/well-log-data)

**DLIS / LIS**
- DLIS is a structured binary format (API RP66). The UK NSTA points to Energistics' hosted RP66 V2 documentation as the DLIS format definition. — [NSTA NDR Form & Manner, Sept 2025](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)
- Equinor's open-source dlisio reads "DLIS (RP66v1) and LIS79". Its latest release is 1.0.4 (2025-12-03). — [PyPI dlisio](https://pypi.org/project/dlisio/)

**Energistics (WITSML / RESQML / PRODML / ETP) and OSDU**
- Energistics' current published standards are WITSML v2.1, PRODML v2.2, RESQML v2.2 and Energistics Common v2.3, released as an omnibus in May 2022 (per the Energistics site as surfaced in search; no newer release found). — [Energistics standards page](https://energistics.org/node/31)
- WITSML 2.1 was labelled OSDU-compliant, with fields added to 2.1 objects that mirror OSDU schemas. — [Oil IT Journal, 2023 Energistics update](https://oilit.com/HTML_Articles/2023_3_9.php)
- **Verified (April 27–30, 2026 Energistics F2F agenda):** active projects include "WITSML v1.4.1.1/v2.1 conversion guidelines", a certification/conformance tool, a WebAPI for WITSML data, and a "WITSML v2.1/ETP v1.2 Adoption Task Force… to focus and jump-start the adoption of WITSML v2.1 and ETP v1.2". The new-initiatives list has "Well Log v2.0. The OSDU Forum is looking at better ways (than files) to access/use log data." Energistics has been an affiliate of The Open Group since January 2022. — [Energistics F2F agenda April 2026 (PDF)](https://energistics.org/sites/default/files/2026-03/energistics-agenda-oslo-norway-april-2026.pdf)
- Vendor view (Falkor, formerly Kongsberg Digital, Dec 12, 2022): WITSML 1.4.1.1 is "the prevailing WITSML version", with 1.3.1.1 a distant second. "There has been practically no uptake of WITSML version 2.0 since its release in 2016", and there are breaking changes between 1.x and 2.x. Some customers hold "terabytes of WITSML data from several thousand historical wells". — [Falkor blog](https://falkor.com/blog/myth-busting-well-data-information-systems-witsml-vs-osdu)
- OSDU status, Dec 2025: Forum priorities for 2026 include delivering a Community Implementation ("Journey to Venus"), reaching "V1.0" quality across the code base, tackling barriers to adoption and making data "AI-ready". The post names no operator production deployments. — [The Open Group blog, Houston Summit 2025](https://blog.opengroup.org/2025/12/04/osdu-forum-highlights-from-the-open-group-houston-summit-2025)
- Migrating legacy stores into OSDU "could take a year or more" given data volumes. — [TechTarget](https://www.techtarget.com/searchapparchitecture/news/252498727/OSDU-Data-Platform-opens-door-to-new-apps-in-energy-sector) Mid-size and small operators find OSDU implementation "a daunting task". — [AWS for Industries blog](https://aws.amazon.com/blogs/industries/accelerate-osdu-adoption-ikon-science/)

**SEG-Y (seismic, for context)**
- SEG-Y rev 2.1 was published in 2023 (announced November 2023). A clarification on Extended Textual Headers followed in May 2025. The SEG wiki notes that "most software programs do not totally follow the specification." — [SEG wiki – SEG-Y](https://wiki.seg.org/wiki/SEG-Y); [SEG Technical Standards](https://seg.org/Publications/SEG-Technical-Standards)
- The UK NDR accepts SEG-Y "rev 0 using rev 1 trace header locations, rev 1, rev 2 and newer". Its rules: fixed-length traces, big-endian for rev 0/1, mandatory binary-header byte locations, and projected CDP XY in trace headers in an NDR-compliant CRS. — [NSTA NDR Form & Manner, Sept 2025](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)

**Deviation surveys / well trajectory**
- UK NDR: digital deviation data must be in IOGP **P7/2000 or P7/17** (classification tag WDD_FILE, "P72, P717"). Deviation reports are PDF. — [NSTA NDR Form & Manner, Sept 2025](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)
- IOGP P7/17 is the wellbore positioning data exchange format (IOGP Report 483-7, user guide 483-7u). — [IOGP P-formats library](https://www.iogp.org/bookstore/product-category/geomatics/p-formats/)
- Australia's NOPTA well transmittal form accepts deviation surveys as ASCII, LAS or XLS. — [NOPTA well data transmittal form](https://www.nopta.gov.au/forms/nopta-forms/data_mgmt/Transmittal_wells.docx)
- Open-source wellpathpy ("light package to load well deviations") is at 0.5.2 (Feb 2025). — [PyPI wellpathpy](https://pypi.org/project/wellpathpy/)

**Data-quality issues**
- Null values: "Common Null Values are -999.25, -9999, etc." The declared NULL in the header can differ from what the data actually uses. — [Kansas Geological Survey LAS help](https://www.kgs.ku.edu/software/DEWL/HELP/pc_read/index.html)
- Duplicate curve mnemonics are common. lasio renames them with ":1", ":2" suffixes, so a plain mnemonic lookup can fail. lasio has an `ignore_header_errors` option for malformed headers. — [lasio docs – data section](https://lasio.readthedocs.io/en/v0.30/data-section.html)
- Depth references: common datums are GL, drill floor (DF), rotary table (RT), kelly bushing (KB/RKB) and MSL. KB is the usual reference in the US; most other places use the drill floor. TVDSS = TVD minus the elevation of the depth reference point above MSL. — [Wikipedia – Depth in a well](https://en.wikipedia.org/wiki/Depth_in_a_well)
- For multi-well work, depths are normally shifted to a permanent datum. Depths "are never really true" and carry intrinsic uncertainty. — [SLB Energy Glossary – depth datum](https://glossary.slb.com/en/terms/d/depth_datum)
- Energistics Common defines a WellboreDatumReference enumeration for local/permanent vertical and MD reference datums. This is the standards hook for capturing KB/DF/GL/MSL metadata. — [Energistics docs](https://docs.energistics.org/COM/COM_TOPICS/COM-000-096-0-R-sv2100.html)
- One case study: an MD-to-TVD conversion on a deviated well introduced about 0.4–0.5 ft of error at the bottom of the hole (a single example, not a general figure). — [UT Austin TVD well-tie note](https://www.jsg.utexas.edu/flemings/files/TVD_welltie.docx)
- Regulator-level identifier validation: the UK NDR requires the LAS ~WELL section to carry the Wellbore Registration ID exactly matching the WONS Well ID (spaces, "/" and "-" included, no extra characters). — [NSTA NDR Form & Manner, Sept 2025](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)

**Legacy scanned/raster logs**
- Paper logs are scanned to TIFF, then digitised to LAS curve by curve. USGS says TIFF-to-LAS conversion is resource-intensive, and some state surveys send it to private vendors. — [USGS – well log data](https://www.usgs.gov/programs/national-geological-and-geophysical-data-preservation-program/well-log-data)
- A US federal records schedule cites an archive of about 200,000 well-log images at 200 dpi. — [NARA records schedule N1-473-06-002](https://www.archives.gov/records-mgmt/rcs/schedules//departments/department-of-the-interior/rg-0473/n1-473-06-002_sf115.pdf)
- A 2025 EAGE paper uses vision-language prompting plus Segment Anything to extract curves, remove grids, normalise depth and export LAS, with normalised RMSE 0.167. — [EAGE 2025 abstract](https://www.earthdoc.org/content/papers/10.3997/2214-4609.202539054) Commercial digitising services exist, e.g. Katalyst. — [Katalyst well log digitization](https://katalystdm.com/digital-transformation/well-log-scanning/well-log-digitization)

**Typical volumes**
- Equinor's Volve open dataset is about 40,000 files and about 5 TB. — [Agile Scientific, 2018](https://agilescientific.com/blog/2018/6/17/big-open-data-or-is-it); [Equinor Volve data sharing](https://www.equinor.com/en/energy/volve-data-sharing) Its well-data package is about 7 GB, a mix of ASCII, DLIS, PDF and TIF. Other parts are in proprietary formats (Eclipse, OpenWorks, RMS) plus WITSML real-time drilling data. — [Oil IT Journal, 2018](https://oilit.com/HTML_Articles/2018_3_7.php)
- Norway's Diskos 2.0 NDR (launched May 2023) is sized for "over 28 petabytes of data, including a copy" (vendor press release). — [Halliburton/BusinessWire](https://www.businesswire.com/news/home/20230530005201/en/Halliburton-Upgrades-Norwegian-Petroleum-Directorates-National-Data-Repository)
- Seismic delivery to the UK NDR still uses physical media for large volumes: "Single copy to be provided on either 3592 JA/JC tape or USB-3/C storage device." — [NSTA NDR Form & Manner, Sept 2025](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)

### Inferences
- A workbench must read LAS 1.2/2.0 and 3.0, DLIS (RP66 v1) and LIS79, WITSML 1.4.1.1 **and** 2.1, and SEG-Y rev 0/1/2/2.1 headers. Writing LAS 2.0 and DLIS covers most regulator submissions. Writing WITSML 2.1 and RESQML 2.2 is a smaller but growing niche, as the conversion-guideline and adoption-task-force work in 2026 shows.
- The highest-value validations are the ones regulators and practitioners keep tripping on: null consistency, duplicate mnemonics, unit sanity per curve, depth-datum presence (KB/DF/GL elevation in the header), MD/TVD consistency with the deviation survey, identifier match (e.g. UK WONS ID), and SEG-Y header/endianness/fixed-trace checks.
- Files of 10 GB+ are realistic for DLIS with image or array logs, SEG-Y, and multi-well WITSML archives. Streaming, chunked parsing is needed; whole-file loading will not work. This file-size evidence is indirect: no direct DLIS size statistic was found.
- OSDU's "better ways than files" direction (Well Log v2.0) is still a proposal. File formats will stay dominant through at least 2027–2028, which supports demand for a file-centric offline tool.

### Gaps
- No primary source found for LAS 3.0 adoption share versus LAS 2.0. The CWLS site itself was not fetched.
- No statistic on typical DLIS file sizes (wireline vs image logs) or WITSML real-time data rates per well.
- OSDU release numbering for 2025–2026 (e.g. M24/M25) and named production deployments could not be confirmed.
- No quantified count of raster-only legacy logs worldwide. The "millions" figure is commonly claimed but unverified.

---

## 2. Tools: commercial suites, open-source ecosystem, costs/accessibility, national data repositories

### Takeaway
Commercial interpretation suites (SLB Petrel/Techlog, Halliburton DecisionSpace 365, S&P Global Kingdom, Lloyd's Register IP, Emerson/AspenTech Geolog) are expensive and opaque on price. The one public figure is a vendor-quoted US$30k–50k per user per year for Petrel. A mature, actively maintained open-source Python stack (lasio, dlisio, segyio, xtgeo, resqpy, laspy/PDAL) covers parsing, but it needs coding skills and has no GUI-based validation. That leaves a gap for a point-and-click, offline workbench. National data repositories mostly standardise on LAS + DLIS for logs, SEG-Y/SEG-D for seismic and IOGP P-formats for positioning.

### Cited Findings

**Commercial suites and cost**
- Petrel licences are quoted at "$30,000 to $50,000 per user per year". The source is Open iT, a licence-optimisation vendor with an interest in stressing high costs, so treat this as an **estimate**. — [Open iT blog](https://openit.com/ja/blog/reduce-cost-on-petrel-ep-licenses-with-usage-metering/)
- SLB does not publish Petrel pricing ("contact for pricing"; priced per feature). — [Capterra – Petrel](https://www.capterra.com.au/software/124118/petrel-e-p-software-platform) A 2019 user review complains that licence cost is "very high" and excludes plugin costs. — [Capterra review](https://www.capterra.com.au/reviews/124118/petrel-e-p-software-platform)
- Gartner's "Oil and Gas Upstream Modeling Suites" category lists Halliburton's DecisionSpace 365 as a direct Petrel competitor (subsurface interpretation, drilling design). — [Gartner Peer Insights category](https://www.gartner.com/reviews/market/oil-and-gas-upstream-modeling-suites)
- SLB offers a free-licence Techlog Viewer that imports .LAS, .DLIS, .TLP and .TLPX. — [SLB Techlog Viewer](https://WWW.SOFTWARE.SLB.COM/products/techlog/techlog-core-systems/viewer)
- Kingdom (geology/geophysics/petrophysics) moved from IHS Markit to S&P Global Commodity Insights branding. — [S&P Global Kingdom Geology brochure](https://www.spglobal.com/dam/spglobal/ci/en/documents/products/pdf/CI_1024_Kingdom-Geology-Upstream-Brochure.pdf)
- Interactive Petrophysics (IP) is marketed by Lloyd's Register as "Best in Class… also cost effective". — [Lloyd's Register IP](https://www.lr.org/en/ip-well-analysis-software/)
- Diskos members can work on NDR data inside Halliburton's DecisionSpace 365 "without moving data" (vendor-hosted iEnergy cloud). — [Halliburton/BusinessWire 2023](https://www.businesswire.com/news/home/20230530005201/en/Halliburton-Upgrades-Norwegian-Petroleum-Directorates-National-Data-Repository)
- Free browser-based LAS viewers exist (e.g. GeophysX / geomechanics.io). They handle LAS but not DLIS. — [geomechanics.io free LAS tool](https://www.geomechanics.io/free-tool/visualise-and-analyse-las-files)

**Open-source Python ecosystem: latest PyPI releases, checked 2026-10-19**
- lasio 0.32 (2025-08-01, MIT): read/write LAS. — [PyPI lasio](https://pypi.org/project/lasio/)
- dlisio 1.0.4 (2025-12-03): DLIS RP66v1 and LIS79. — [PyPI dlisio](https://pypi.org/project/dlisio/)
- segyio 1.9.14 (2025-12-02): SEG-Y I/O. — [PyPI segyio](https://pypi.org/project/segyio/)
- welly 0.5.2 (2022-02-28) and striplog 0.9.2 (2022-02-16): no PyPI release in more than 4 years, i.e. maintenance has slowed. — [PyPI welly](https://pypi.org/project/welly/); [PyPI striplog](https://pypi.org/project/striplog/)
- xtgeo 4.27.0 (2026-10-14, LGPL-3.0; Equinor): 3D grids, surfaces, wells. — [PyPI xtgeo](https://pypi.org/project/xtgeo/)
- resqpy 5.2.0 (2026-06-22): Python API for RESQML models. — [PyPI resqpy](https://pypi.org/project/resqpy/)
- pyGIMLi 1.6.1 (2026-09-18): geophysical inversion and modelling. GemPy 2026.0.3 (2026-06-18, EUPL-1.2): 3D structural geomodelling. — [PyPI pygimli](https://pypi.org/project/pygimli/); [PyPI gempy](https://pypi.org/project/gempy/)
- laspy 2.7.0 (2026-01-14) and PDAL Python 3.5.5 (2026-07-31) for ASPRS LAS/LAZ point clouds. — [PyPI laspy](https://pypi.org/project/laspy/); [PyPI pdal](https://pypi.org/project/pdal/)
- The Software Underground "Awesome Open Geoscience" list (about 1.9k GitHub stars) also catalogues MDIO (Zarr-based cloud seismic), pyVDS/pyZGY (OpenVDS/OpenZGY wrappers), SeismicZFP, Fesapi (RESQML2), ecl (Eclipse files) and wellioviz. — [GitHub awesome-open-geoscience](https://github.com/softwareunderground/awesome-open-geoscience)

**Software Underground community**
- The Software Underground calls itself a "grass-roots community of digital subsurface professionals" that maintains open-source projects and open data. Its annual TRANSFORM festival (started 2019 in Normandy) is free, with sprints, tutorials and lightning talks, and is coordinated through Slack. — [TRANSFORM overview](https://transform.softwareunderground.org/overview); [SWUNG blog – TRANSFORM 2020](https://softwareunderground.org/blog/2020/6/18/transform-2020)

**National data repositories and formats**
- **UK NDR (NSTA), Form & Manner, Sept 2025.** Verified:
  - Well logs (wireline, MWD/LWD, mud, production, test, abandonment, joined) must be **LAS or DLIS**.
  - Deviation data must be P7/2000 or P7/17. Reports must be machine-readable PDF (not encrypted). Images must be at least 300 ppi JPEG/PNG. Supporting ASCII must be UTF-8.
  - Seismic field data: SEG-D rev 2.1/3.0/3.1, with SEG-Y also accepted. Other seismic: SEG-Y rev 0/1/2 (or DISKOSV98 where applicable).
  - Navigation: P1/84, P1/90 or P1/11 processed; P2/86, P2/91, P2/94 or P2/11 raw. Bin grids: UKOOA P6/98 or IOGP P6/11. SPS rev 2.1 where applicable.
  - A table of compliant CRSs is given (e.g. ED50/UTM 31N EPSG 23031 with transformation 1311, WGS84/UTM 31N 32631, ETRS89).
  - Non-compliant legacy SEG-D/SEG-A/B/C data can be converted "subject to additional charges". — [NSTA NDR Form & Manner, Sept 2025](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)
- **Norway Diskos 2.0** (launched May 2023 by Halliburton for the then-NPD, now Sodir): seismic, well and production data for 79 member organisations, hosted in a multi-cloud iEnergy environment sized for more than 28 PB including a copy. — [Halliburton/BusinessWire](https://www.businesswire.com/news/home/20230530005201/en/Halliburton-Upgrades-Norwegian-Petroleum-Directorates-National-Data-Repository)
- **Netherlands NLOG** (TNO/Geological Survey of the Netherlands): borehole data types include "Logs (LIS/LAS)", composite logs, deviation data and lithostratigraphy. Logs and reports are released after a five-year confidentiality period. — [NLOG boreholes](https://nlog.nl/en/node/447) EPOS-NL published a Petrel project of public Dutch wells, logs and 2D/3D seismic. — [NLOG EPOS-NL data](https://www.nlog.nl/en/epos-nl-data) A TU Delft geothermal dataset destined for NLOG ships LAS 2.0 + DLIS + PDF composites. — [4TU dataset](https://data.4tu.nl/datasets/2a7b2a63-dd7b-46bc-a275-97729b3ab348)
- **Volve (Equinor)**: about 40,000 files and about 5 TB, released under the Equinor Open Data Licence for academic and research use. — [Equinor Volve data sharing](https://www.equinor.com/en/energy/volve-data-sharing) In 2018 Agile flagged very large seismic files and unclear licence terms. — [Agile Scientific](https://agilescientific.com/blog/2018/6/17/big-open-data-or-is-it)
- **Australia NOPIMS**: a joint initiative of WA DMIRS, Geoscience Australia and NOPTA. No registration is needed to view or download open-file data. — [GA NOPIMS about](https://ga.gov.au/nopims/about-us)
  - The newer NOPTA transmittal narrows wireline/MWD/LWD log formats to LAS and DLIS (the older form also listed LIS) and adds web-portal delivery alongside portable hard drives. — [NOPTA well-data transmittal template](https://nopta.gov.au/_documents/templates/31/well-data-transmittal.docx)
- **Nigeria NUPRC NDR**: NDR Regulations (2024, under the Petroleum Industry Act) establish the repository to "receive, store and manage geological, geophysical, geochemical and other technical" data, funded by licensee annual contributions with free backup archival for paying licensees. — [NUPRC NDR Regulations](https://nuprc.gov.ng/wp-content/uploads/2024/08/National-Data-Repository-NDR-Regulations-1.pdf)

### Inferences
- The free/commercial gap is wide. Free tools are either viewers (Techlog Viewer, browser LAS viewers) or code libraries (lasio, dlisio, segyio). Suites cost tens of thousands of dollars per seat. A US$500–3,000 per seat offline workbench would sit in an underserved middle tier. This is an inference; no direct willingness-to-pay data was found.
- Regulator format tables (UK NDR, NOPTA) are concrete, machine-checkable rule sets. "Submission readiness" validators per regulator are a differentiating feature.
- Slowing maintenance of welly and striplog suggests the open-source community covers I/O better than higher-level QC and workflows.

### Gaps
- No public price data for Techlog, Kingdom, Geolog, IP, DecisionSpace 365 or OpendTect commercial plugins.
- Current ownership of IP and Geolog in 2025–2026 not confirmed.
- No primary Diskos format specification, India DGH NDR, Middle East NDR, or US/Canada regulator format tables retrieved (search budget exhausted).
- Software Underground membership size and 2025/2026 TRANSFORM details not found.

---

## 3. Geospatial in oil & gas: GIS platforms, pipeline data models, EPSG and IOGP P-formats, CRS errors and incidents

### Takeaway
Esri ArcGIS is the entrenched enterprise GIS in oil & gas. Pipeline data models have converged on PODS 7 (including a 2024 Esri Utility Network variant) and Esri's UPDM. IOGP maintains both the EPSG dataset (v12.x series, frequent releases) and the P1/P2/P6/P7 positioning formats (P1/P2/P6 v2.0 revised in 2024). Coordinate and datum errors are well documented in industry guidance, including a well spudded about 400 km off target and repeated "wrong lease" or dry-well cases. Few incidents are published with operator names.

### Cited Findings

**GIS platforms**
- Esri recruits a dedicated "GIS Industry Solutions Manager – Oil & Gas / Integrated Energy", showing a dedicated vertical. — [Esri careers](https://www.esri.com/careers/gis-industry-solutions-manager-oil-gas-integrated-energy-5052557007)
- Exprodat (an Esri partner) says new JVs and operators with little GIS are "moving directly to deploy the ArcGIS Platform" (dated vendor-partner claim). — [Exprodat](https://www.exprodat.com/?p=27883)
- Reanin's GIS-in-oil-and-gas report names Esri, Hexagon, SLB, CGG, Trimble, Siemens, Autodesk, Petrosys, Geosoft and Bentley as key players. — [Reanin](https://www.reanin.com/reports/geographic-information-systems-applications-for-oil-and-gas-industry-market)

**Pipeline data models**
- PODS 7.03 "Utility Network + Advanced Pipeline Referencing (APR)" (April 15, 2024) is described as the first Esri-centric PODS model. PODS now offers two core models: PODS 7, and PODS 7 with Utility Network. — [Pipeline Journal](https://pipeline-journal.net/news/new-data-model-release-pods-703-utility-network-advanced-pipeline-referencing-apr)
- PHMSA is a PODS member and uses PODS as a baseline for the National Pipeline Mapping System (NPMS) (July 2025 Texas RRC presentation). — [Texas RRC – PODS data management for reporting](https://rrc.texas.gov/media/unfdpnjf/pods-data-management-for-reporting-monique-roberts.pdf)
- A September 2025 GTI presentation lists a PODS Utility Network Extension (UNet) with trace and connectivity models. — [GTI SAGE 2025](https://www.gti.energy/wp-content/uploads/2025/09/06-Roberts-Monique-Presentation-SAGE2025.pdf)
- Esri's UPDM (Utility and Pipeline Data Model) with Utility Network lets operators model assets "from well head to meter" (integrator claim). — [SSP Innovations](https://sspinnovations.com/blog/modernizing-your-pipeline-gis-platform/)

**IOGP EPSG Geodetic Parameter Dataset**
- EPSG is maintained by the Geodesy Subcommittee of the IOGP Geomatics Committee. — [Wikipedia – EPSG dataset](https://en.wikipedia.org/wiki/EPSG_Geodetic_Parameter_Dataset); [IOGP – 40 years of EPSG](https://www.iogp.org/workstreams/engineering/geomatics/epsg-info/)
- Release history shows v12.054 on 2026-03-18 (new data for the Netherlands, Norway, Wallis and Futuna). Later 2026 releases may exist; epsg.org returned 403 to direct fetch. — [EPSG release history](https://epsg.org/whatsnew.html)
- IOGP Guidance Note 373-07-1 (dataset structure) is dated March 2025. — [IOGP 373-07-1](https://www.iogp.org/bookstore/wp-content/uploads/sites/2/woocommerce_uploads/2017/01/373-07-1.pdf)
- Software lags the registry: Esri's Projection Engine shipped EPSG 12.002 in May 2025 and 12.018 in November 2025. — [Esri Community – EPSG release and ArcGIS Projection Engine](https://community.esri.com/t5/coordinate-reference-systems-questions/epsg-release-and-arcgis-projection-engine/m-p/1679412)

**IOGP P-formats**
- P1/11 (post-processed position data) and P2/11 (raw navigation) reached version 2.0 in February 2024. P6/11 (seismic bin grid) was then also revised to v2.0, because the three share common elements. P6/11 is designed to keep bin-grid geometry traceable through resampling, merging and reprojection. — [IOGP P1/11 spec](https://www.iogp.org/bookstore/product/ogp-p111-geophysical-position-data-exchange-format/); [IOGP P6/11 v2.0 announcement](https://www.iogp.org/blog/announcements/geomatics-announcements/iogp-releases-version-2-0-of-the-p6-11-seismic-bin-grid-data-exchange-format/)
- P7/17 is the wellbore positioning format (Report 483-7). Regulators still accept legacy versions alongside it: UK NDR takes P1/84, P1/90 and P1/11; P2/86 through P2/11; UKOOA P6/98 and P6/11; and P7/2000 and P7/17. — [IOGP P-formats](https://www.iogp.org/bookstore/product-category/geomatics/p-formats/); [NSTA NDR Form & Manner](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)
- The UK NDR notes "ETRF89 and ETRS89 are equivalent to WGS84 for these offshore positioning purposes". ED50 entries are tied to specific EPSG transformation codes (e.g. 23031-1311). — [NSTA NDR Form & Manner](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)

**CRS/datum errors and incidents**
- Exprodat cites an offshore well spudded about 400 km from target in 2005 after a rig crew near the equator misread "Latitude North" as South. It also cites a contractor that drilled 12 dry wells in succession because of true/magnetic/grid north confusion (attributed to IOGP Guidance Note 1). Neither case names the operator. Exprodat lists recurring mistakes: assuming lat/long means WGS84, measuring on projected maps, trusting software defaults, and assuming CRSs carry correctly through export/import. — [Exprodat – Managing geodetic risks in E&P](https://www.exprodat.com/blog/managing-geodetic-risks-in-ep-4/)
- Over 600 datums exist in EPSG, and the same point can shift by up to 500 m depending on datum. — [Exprodat](https://www.exprodat.com/blog/managing-geodetic-risks-in-ep-4/); [Oil IT 2013](https://oilit.com/HTML_Articles/2013_2_6.php)
- OGP (now IOGP) has publicised cases where geodetic mistakes put wells in the wrong lease. — [Oil & Gas Journal](https://ogj.com/home/article/17226390/oil-companies-underscore-importance-of-geodetic-positioning)
- A Brazilian case: a wrong datum applied to a coordinate placed a planned well about 200 m from the intended site. Mixing datums in that region produced errors of about 10–370 m. — [SBGF 2009 expanded abstract](https://sbgf.org.br/mysbgf/eventos/expanded_abstracts/11th_CISBGf/1747_evt_6year_2009.pdf)
- SPE 96813 (Williamson & Wilson) lists geodetic mistakes in directional drilling, including different or wrong wellhead and target datums. — [SPE 96813 PDF](https://hydrometronics.com/downloads/Accounting%20for%20Earth%20Curvature%20in%20Directional%20Drilling%20%20%20SPE%2096813.pdf)
- Lake Peigneur (Louisiana, 1980) is sometimes attributed to wrong well-site coordinates, but accounts conflict (calculation, CRS or triangulation error). This is **disputed**. — [Agile Scientific – "The disappearing lake trick"](https://agilescientific.com/blog/tag/disaster)
- Typical database checks only confirm that coordinates exist and fall within a UTM zone, so they miss shifted-but-plausible points. — [US Patent 10936561 – well data integrity detector](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10936561)
- In the US, NGS's NATRF2022/NAPGD2022 will replace NAD83 and NAVD88. The rollout was delayed from 2022, with NRCan later citing 2025. — [NGS FAQ new datums](https://www.ngs.noaa.gov/datums/newdatums/FAQNewDatums.shtml); [Amerisurv 2020](https://amerisurv.com/2020/06/23/ngs-announces-delayed-release-of-the-modernized-nsrs/); [NRCan](https://natural-resources.canada.ca/science-data/science-research/geomatics/geodetic-reference-systems/height-reference-system-modernization)

### Inferences
- CRS handling is a core workbench capability. It should bundle a versioned EPSG copy, show the EPSG version used, require the datum and transformation (not just "lat/long"), warn when a coordinate falls outside the CRS area of use, and produce a reproducible transformation log. Professional tools (Blue Marble Geographic Calculator) already sell this (see §4), which confirms willingness to pay.
- US datum modernisation (NAD27 → NAD83 → NATRF2022) means multi-generation CRS conversions across legacy well-header databases. This is a lasting pain point, though its timing is uncertain.
- P-format support (P1/11, P6/11, P7/17 import/export plus legacy P1/90 and UKOOA P6/98) is a niche that mainstream GIS tools serve poorly.

### Gaps
- No quantitative ArcGIS vs QGIS adoption data in oil & gas. QGIS use in O&G is not documented by any source found.
- No named, regulator-investigated incident report of a well drilled in the wrong place due to a CRS error. The cases found are anonymised guidance examples.
- Esri's legacy APDM (ArcGIS Pipeline Data Model) status vs UPDM was not confirmed in sources. Search results used "UPDM".
- NATRF2022 release status as of Oct 2026 not confirmed.

---

## 4. Drone/UAV and LiDAR in oil & gas: use cases, market size, formats and volumes, software, regulations

### Takeaway
Drone inspection in oil & gas is a roughly **US$1–2.5 B (2024–2025) estimated** market growing 4–14% a year depending on publisher. Main uses are pipeline/right-of-way, flare stack, tank, well site and increasingly methane (EPA approved drone OGI as an OOOOa/OOOOb alternative test method in Sept 2025). Outputs are imagery, GeoTIFF orthomosaics and ASPRS LAS/LAZ (now COPC) point clouds, with per-flight point clouds of 1 GB+. Processing is split between Pix4D, DJI Terra, Metashape and Esri on one side and open-source ODM/PDAL/CloudCompare on the other. BVLOS remains the regulatory bottleneck. The US Part 108 final rule was still in OIRA review as of Sept 2026; the EU moved to SORA 2.5 in 2025; Saudi GACA issued AC 107-01 in June 2025.

### Cited Findings

**Use cases**
- GMI lists pipeline inspection, flare stack inspection, tank inspection, environmental monitoring and well-site inspection as application segments. Rotary-wing drones were more than US$470M in 2024. — [Global Market Insights](https://gminsights.com/industry-analysis/inspection-drone-in-oil-and-gas-market)
- Methane: EPA document MATM-14 (dated Sept 10, 2025) approves Percepto's Air Max UAS autonomous OGI system for fugitive-emissions screening under 40 CFR 60.5398b (OOOOb). — [EPA MATM-14 PDF](https://www.epa.gov/system/files/documents/2025-09/percepto-matm-014-508-9.26-to-edit.pdf) Percepto claims detection under 1 kg/hr and "100g/hr at 90% reliability" (vendor claim). — [Percepto press release](https://percepto.co/autonomous-ogi-drones-now-alternative-test-method-for-epa-subpart-ooooa-oooob/)
- ChampionX's aerial OGI (AOGI) platform received EPA OOOOb alternative-test-method approval in March 2025 (platform type not specified). — [World Oil](https://worldoil.com/news/2025/3/4/championx-s-aogi-platform-granted-epa-approval-for-methane-emissions-detection/) Insight M's manned-aircraft system was approved on Jan 14, 2025. — [EPA approval letter](https://www.epa.gov/system/files/documents/2025-01/final_approval_methane-atm_insight-m_signed.pdf)
- BVLOS pipeline precedents:
  - FAA exemption for AATI (a drone over 55 lb, flying above 400 ft, no visual observers) for Chevron Pipe Line in the San Joaquin Valley. — [Flying Magazine](https://flyingmag.com/drone-manufacturer-aati-claims-first-of-its-kind-faa-approval/)
  - BVLOS monitoring of the Trans-Alaska pipeline and Hilcorp's Swanson River pipeline. — [UAF Geophysical Institute](https://www.gi.alaska.edu/news/unmanned-aircraft-flies-first-us-beyond-line-sight-mission)
  - Transport Canada-permitted BVLOS pipeline trials. — [NS Energy](https://www.nsenergybusiness.com/news/canadian-uavs-gets-approval-for-bvlos-pipeline-monitoring-in-civil-airspace/)

**Market size: all estimates, conflicting**
- GMI (Dec 2024): US$1.0 B (2024) → US$2.8 B (2034), 10.8% CAGR. North America more than 30% share. DJI Enterprise, Terra Drone and ideaForge together more than 12%. — [GMI](https://gminsights.com/industry-analysis/inspection-drone-in-oil-and-gas-market)
- Market Intelo (updated June 2026): US$1.8 B (2025) → US$5.8 B (2034), 14.2% CAGR.
  - Service mix: visual 38.5%, thermal 28.2%, LiDAR 18.6%, other 14.7%.
  - Regions: **Asia-Pacific 35.2%**, Europe 28.4%, North America 22.3%, MEA 9.1%, LatAm 5%. This **contradicts GMI's North America lead**. — [Market Intelo](https://marketintelo.com/report/drone-inspection-in-oil-and-gas-market)
- Credence Research: US$988M (2024), 3.8% CAGR to 2032. — [Credence Research](https://www.credenceresearch.com/report/inspection-drone-in-oil-and-gas-market)
- Intel Market Research (via a low-quality repost): **services** US$2,316M (2025) → US$12.66 B (2034). — [syg.ma repost](https://syg.ma/@sneha/oil-and-gas-drone-inspection-services-market-growth-analysis-dynamics-key-players-and-innovations-outlook-and-forecast-2026-2034)
- Broader "oil & gas drones" (TBRC): US$9.36 B (2024) → US$12.67 B (2025). This is a much wider scope and not comparable. — [TBRC via GII](https://cn.gii.tw/report/tbrc1694653-oil-gas-drones-global-market-report.html) Spherical Insights' "drone-based gas leak detection" figure of US$6.2 B (2025) is implausibly large relative to the others; treat with caution. — [Spherical Insights](https://www.sphericalinsights.com/reports/drone-based-gas-leak-detection-in-oil-and-gas-market)
- GlobalData (2022): global drone market US$13.7 B (2021) → US$89.6 B (2030), with oil & gas cited as a driver (dated). — [GlobalData](https://www.globaldata.com/media/oil-gas/oil-gas-industry-drive-global-drone-market-89-6-billion-2030-forecasts-globaldata/)

**Data formats and volumes**
- ASPRS LAS 1.4 (approved Nov 2011, later revisions) expanded classes to 256, added WKT CRS encoding and up to 15 returns. LAS is not an indexed format. — [LiDAR Magazine](https://lidarmag.com/2011/11/26/asprs-approves-las-1-4/); [ASPRS LAS 1.4 R6 PDF](https://asprs.org/wp-content/uploads/2011/08/LAS_1-4_R6.pdf)
- COPC 1.0 (Hobu, 2021) is a range-readable, octree-organised LAZ profile limited to point formats 6/7/8, the point-cloud counterpart of Cloud-Optimized GeoTIFF. — [copc.io](https://copc.io/); [CNG Python book – COPC](https://cng-python.gishub.org/book/formats/copc/)
- Example UAV LiDAR (DJI Zenmuse L1 on M300, 50 m AGL, 8 m/s, about 5.8 ha, about 2,100 pts/m²): about **1.0–1.3 GB of LAZ per flight**. — [Dryad dataset](https://datadryad.org/dataset/doi:10.5061/dryad.jdfn2z3hk)
- Airborne (crewed) LiDAR delivery example: 1,143 LAS 1.4 tiles totalling **403.2 GB** for one county project. — [USGS delivery report, Shawano WI](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/WI_Shawano_2015/WI_Shawano_2015/reports/Shawano_WI_LiDARFinalDeliveryCheck_20160317_131603.pdf)

**Processing software: third-party price reports, 2026, conflicting**
- DJI Terra Standard: about US$1,850/yr or US$5,280 perpetual; Windows + NVIDIA only. PIX4Dmatic from about US$2,290/yr. Pix4Dmapper is quoted as about US$3,990/yr or US$2,900 perpetual (sources conflict). Agisoft Metashape Professional: US$3,499 perpetual, node-locked. Metashape Standard is quoted at US$179 or US$549 (conflicting) and has no georeferencing/survey tools. Metashape runs on Windows, macOS and Linux. — [SkyeBrowse DJI Terra vs Pix4D](https://www.skyebrowse.com/news/posts/dji-terra-vs-pix4d.md); [SkyeBrowse Pix4D vs Metashape](https://www.skyebrowse.com/news/posts/pix4d-vs-metashape); [AeroVision cost guide](https://www.aerovisiondrones.com/?p=80); [Pix-Pro 2026 prices](https://www.pix-pro.com/index.php/blog/photogrammetry-software-prices-2026)
- Esri: Site Scan for ArcGIS is presented as current and part of the ArcGIS Reality suite (Reality for ArcGIS Pro, Reality Studio, and **Drone2Map, which processes imagery offline without internet**). Pricing is "contact sales". — [Esri Site Scan page](https://www.esri.com/en-us/arcgis/products/site-scan-for-arcgis/overview)
- OpenDroneMap generates maps, point clouds, 3D models and DEMs. NodeODM offers a REST API, and ClusterODM load-balances for horizontal scaling. — [OpenDroneMap](https://www.opendronemap.org/)
- Blue Marble Geographic Calculator: coordinate translation and data conversion with EPSG "Area of Use" display. Blue Marble also sells Global Energy Mapper (oil & gas) and a Global Mapper LiDAR Module. — [Geo Week News](https://www.geoweeknews.com/?p=26419); [GPS World – Global Energy Mapper](https://www.gpsworld.com/blue-marble-releases-global-energy-mapper-version-14-1/)

**Regulations (BVLOS)**
- **US**: EO 14307 (June 6, 2025). Part 108 NPRM published Aug 7, 2025 (90 FR 38212), with about 3,100 comments. Comments reopened Jan 28 – Feb 11, 2026 on right-of-way and electronic conspicuity. The final rule went to OIRA on July 10, 2026.
  - Proposal: a permit tier (incl. rural infrastructure inspection) and a certificate tier (SMS required); aircraft up to 1,320 lb.
  - Part 107 BVLOS still needs case-by-case waivers. — [AirData, July 2026](https://airdata.com/blog/2026/part-108)
  - Not yet published as of early Sept 2026; OIRA review could run to about Oct 8, 2026. — [PickDrones](https://pickdrones.com/faa-part-108-bvlos-rule-delayed-oira-2026/); [Low Altitude Economy](https://lowaltitudeeconomy.aero/en/aam-events/faa-part-108-oira-review)
- **EU**: EASA ED Decision 2025/018/R (Sept 29, 2025) integrates SORA 2.5 into the AMC/GM to Regulation (EU) 2019/947. — [Bureau Veritas](https://aero.bureauveritas.com/newsroom/easa-adopts-sora-25-new-simplifications-specific-category-drones) STS-02 covers BVLOS over controlled ground areas with airspace observers. — [DroneIntelligence](https://droneintelligence.ai/intelligence/europe-bvlos-market) Pipelines and powerlines are a near-term fit via the Accredited Assessment Entity route (commentary). — [DroneDesk 2026 comparison](https://blog.dronedesk.io/faa-part-108-vs-easa-sora-2-5-vs-uk-sora-a-complete-comparison-of-bvlos-frameworks-2026/)
- **Saudi Arabia**: GACA Advisory Circular AC 107-01 v1.0 (2025-06-03), "Advanced Operations with UAS", sets out how to get Specific Category authorisation. Secondary sources say this is the route for BVLOS, night and over-people operations. — [GACA AC 107-01 PDF](https://gaca.gov.sa/-/media/Files/PDF/LawsAndRegulation/Aviation-Safety-and-Environmental-Sustainability/Safety-and-Aviation-Standards-Advisory-Circulars/GACA-AC-107-01-Advanced-Operations-with-Unmanned-Aircraft-Systems.pdf); [UAV Coach](https://uavcoach.com/drone-laws-in-saudi-arabia/)
- **UAE**: Federal Decree-Law No. 26 of 2022 governs civil drones. The GCAA issued the region's first U-space service-provider certification regulation (CAR Airspace Part U-space) in March 2025. Commercial operations including pipeline inspection face "stricter regulations". — [Gulf News – U-space rules](https://gulfnews.com/business/aviation/uae-sets-new-rules-to-integrate-drones-with-traditional-aircraft-safely-gcaa-1.500059697); [Gulf News – GCAA registrations](https://gulfnews.com/business/aviation/gcaa-sees-spike-in-drone-use-registrations-after-lifting-ban-flags-fines-up-to-dh2m-for-violations-1.500013206)
- **Nigeria**: NCAA advisory circular NCAA-GAD-AC-06 allows BVLOS approval as part of a Remotely Piloted Aircraft Operator Certificate (ROC). — [NCAA BVLOS AC](https://www.ncaa.gov.ng/documents/advisory-circulars/assessment-methodology-for-beyond-visual-line-of-sight-bvlos-operations-for-remotely-piloted-aircraft/) Aerial Robotix flew NCAA-supervised BVLOS pipeline demonstrations in the Niger Delta using Kongsberg Geospatial IRIS deconfliction (2019). — [DroneBelow](https://dronebelow.com/2019/03/10/kongsberg-geospatial-brings-bvlos-to-oil-and-gas-pipeline-inspections-in-nigeria/)

### Inferences
- Drone and LiDAR deliverables (multi-GB LAZ per flight, tens to hundreds of GB per corridor project, GeoTIFF orthomosaics) fit the "10 GB+" requirement directly. The workbench would need LAS/LAZ 1.4 and COPC read/write, COG GeoTIFF export, reprojection, tiling and thinning, and metadata/CRS validation. PDAL and laspy show these are buildable on open libraries.
- Photogrammetry processing is crowded (Pix4D, DJI Terra, Metashape, ODM). A workbench should probably **not** compete on reconstruction. It should take their outputs and validate, convert, reproject and package them for GIS/PODS and inspection systems.
- As BVLOS scales (Part 108, SORA 2.5, GACA AC 107-01), long linear pipeline datasets will grow, so offline batch handling of very large corridor point clouds matters more.

### Gaps
- No Drone Industry Insights or DroneDeploy primary data on oil & gas share of drone use was retrieved.
- No source on typical orthomosaic GeoTIFF sizes per km of pipeline right-of-way, or on per-km LiDAR corridor volumes.
- CloudCompare and PDAL feature and adoption details were not fetched.
- DJI restrictions in the US (FCC Covered List / NDAA) could not be verified: the FCC page returned 403 and the search budget was exhausted. This matters for US oil & gas fleets and should be checked.
- No primary text found for UAE GCAA BVLOS approvals, ADNOC or Aramco drone programmes, or SACAA (South Africa) and KCAA (Kenya) rules.

---

## 5. Pain points for geoscientists, petrophysicists, GIS specialists, survey and drone staff

### Takeaway
The best survey evidence (Seequent 2020/21, n=709; mostly mining, so a proxy) shows a third of geoscientists spend more than 30% of their time on data management, and only 1 in 10 find data access "extremely easy". Industry-specific pain points cluster around format conversion and validation (LAS/DLIS/WITSML/SEG-Y non-conformance), CRS mismatches through export/import, very large files that still move on USB drives or tape, expensive suite licences, and data scattered across repositories, with OSDU migration still a multi-year effort.

### Cited Findings
- Seequent Geoscience Data Management Report 2021 (2020 survey; 709 responses, 320 organisations; respondents 72% mining, **6% energy**):
  - 83% say data management is a critical issue.
  - **35% spend more than 30% of their time on data management tasks**, with no significant reduction over time.
  - Only 1 in 10 say data access is extremely easy.
  - 40% name version control as the biggest collaboration challenge.
  - 60% rate data security/confidentiality highly.
  - Desire for "one point of access / single source of truth" rose 12% since 2017.
  - 69% say they are cloud-ready.
  - About half store data as "folders/files on a centralised server". — [Seequent report PDF](https://files.seequent.com/PDFs/Seequent-Geoscience-Data-Management-Report-2021.pdf)
- The often-quoted "geologists spend 80% of their time searching for, formatting and organising data" figure is attributed only to unnamed "estimates" (weak). — [Geoscience Canada column](https://journals.lib.unb.ca/index.php/GC/issue/download/2186/25) A 2008 IPTC paper says up to 30% of technical professionals' time goes on searching for data. — [EarthDoc IPTC 12035](https://www.earthdoc.org/content/papers/10.3997/2214-4609-pdb.148.iptc12035) A study found about 40% of geoscience study duration spent looking for information. — [HAL 01368231](https://hal.archives-ouvertes.fr/hal-01368231)
- Format and conversion friction:
  - Most SEG-Y software does not fully follow the spec. — [SEG wiki](https://wiki.seg.org/wiki/SEG-Y)
  - Energistics is still drafting WITSML 1.4.1.1↔2.1 conversion guidelines in 2026. — [Energistics agenda 2026](https://energistics.org/sites/default/files/2026-03/energistics-agenda-oslo-norway-april-2026.pdf)
  - UK NDR charges extra to convert legacy SEG-D/SEG-A/B/C. — [NSTA Form & Manner](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)
  - TIFF-to-LAS digitisation is labour-intensive. — [USGS](https://www.usgs.gov/programs/national-geological-and-geophysical-data-preservation-program/well-log-data)
- Large files:
  - Volve seismic was delivered in "very large files", and users asked Equinor to split them. — [Agile Scientific](https://agilescientific.com/blog/2018/6/17/big-open-data-or-is-it)
  - UK NDR seismic still goes on 3592 tape or USB-3 drives. — [NSTA Form & Manner](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)
  - A single UAV LiDAR flight produces about 1+ GB of LAZ. — [Dryad](https://datadryad.org/dataset/doi:10.5061/dryad.jdfn2z3hk)
- CRS:
  - Practitioners wrongly assume CRSs carry through export/import and trust software defaults. — [Exprodat](https://www.exprodat.com/blog/managing-geodetic-risks-in-ep-4/)
  - Database checks miss plausible but shifted coordinates. — [US Patent 10936561](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10936561)
  - GIS software lags EPSG releases. — [Esri Community](https://community.esri.com/t5/coordinate-reference-systems-questions/epsg-release-and-arcgis-projection-engine/m-p/1679412)
- Licence cost: Petrel at about US$30–50k per user per year (vendor estimate), with plugins extra. — [Open iT](https://openit.com/ja/blog/reduce-cost-on-petrel-ep-licenses-with-usage-metering/); [Capterra review](https://www.capterra.com.au/reviews/124118/petrel-e-p-software-platform)
- Scattered systems and migration: OSDU migration "could take a year or more" — [TechTarget](https://www.techtarget.com/searchapparchitecture/news/252498727/OSDU-Data-Platform-opens-door-to-new-apps-in-energy-sector). It is "daunting" for mid and small operators. — [AWS](https://aws.amazon.com/blogs/industries/accelerate-osdu-adoption-ikon-science/) WITSML archives of terabytes from thousands of wells sit in legacy stores. — [Falkor](https://falkor.com/blog/myth-busting-well-data-information-systems-witsml-vs-osdu)

### Inferences
- The pain points line up with an offline workbench: (1) batch validation and repair of LAS/DLIS/SEG-Y/WITSML against spec and regulator rules; (2) CRS-aware conversion with audit trail; (3) streaming handling of 10 GB+ files on a laptop without cloud upload, relevant where data security ranks as the top concern (60%) and where field and offshore connectivity is limited; (4) a much lower price than suites.
- Data security being the top concern in Seequent's survey supports an offline, local-processing positioning versus SaaS converters.

### Gaps
- Reddit (r/geology, r/gis, r/petroleumengineering) and LinkedIn practitioner threads were not reached before the search budget ran out. No verbatim forum evidence is included.
- No oil-and-gas-only survey of time spent on data preparation was found. Seequent's sample is mining-heavy.

---

## 6. Market size estimates: GIS in oil & gas, subsurface/E&P software (all estimates)

### Takeaway
Only commercial-publisher estimates exist, with wide scope differences. GIS in oil & gas is about **US$3.4 B (2025)**, growing about 7% a year (Reanin). E&P/subsurface software has only dated or unattributed estimates (US$10–15 B range). Oil & gas drone inspection is US$1–2.5 B. None should be treated as verified; they set orders of magnitude only.

### Cited Findings
- **GIS in oil & gas**: US$3.44 B (2025) → US$5.53 B (2032), 7.0% CAGR. North America about 38%. Segments run from software, data, analytics and services to IoT, and applications from exploration and well planning to pipeline routing, HSE and land/lease (published Sept 2026). — [Reanin](https://www.reanin.com/reports/geographic-information-systems-applications-for-oil-and-gas-industry-market)
- **US GIS (all industries)**: US$4.3 B (2024) → US$10.1 B (2033), with oil & gas one end-use segment. — [IMARC](https://imarcgroup.com/united-states-geographic-information-system-market)
- **Global GIS (all industries)**: about US$13.6 B (2026), 5.8% CAGR to 2035. — [MarketReportsWorld](https://www.marketreportsworld.com/market-reports/geographic-information-system-gis-market-14716403)
- **E&P software (dated)**: Transparency Market Research (2017) forecast US$14.7 B by 2024, naming Schlumberger, Paradigm and Landmark as the top three. — [TMR via PR Newswire](https://www.prnewswire.co.uk/news-releases/worldwide-exploration-and-production-ep-software-market-is-expected-to-reach-a-valuation-of-us147-bn-by-2024-high-acceptance-of-technology-to-reduce-carbon-footprint-to-benefit-market-observes-tmr-614239963.html)
- **Drone inspection in oil & gas**: GMI US$1.0 B (2024); Market Intelo US$1.8 B (2025); Credence US$988M (2024). — see §4 sources ([GMI](https://gminsights.com/industry-analysis/inspection-drone-in-oil-and-gas-market); [Market Intelo](https://marketintelo.com/report/drone-inspection-in-oil-and-gas-market); [Credence](https://www.credenceresearch.com/report/inspection-drone-in-oil-and-gas-market))

### Inferences
- The addressable segment for a desktop data workbench is a thin slice: data-management and conversion tooling inside GIS, subsurface and drone budgets. A bottom-up estimate (number of petrophysicists, geoscientists, GIS analysts and drone data processors × price) would be more defensible than top-down market reports.

### Gaps
- A search snippet cited "USD 10.65 B (2025) E&P software, 13.6% CAGR to 2036, North America 42.2%", but the publisher could not be identified, so it is excluded from Cited Findings.
- No credible Petrel vs DecisionSpace vs Kingdom revenue-share data. That would need Rystad, Wood Mackenzie or vendor segment disclosures.
- No market sizing for "subsurface data management" (e.g. OSDU services, NDR operations) specifically.

---

## 7. Regional notes: national data repository requirements and formats

### Takeaway
Europe has the most codified, machine-checkable NDR rules (UK NDR, Norway Diskos, Netherlands NLOG). Australia's NOPIMS is open-access with LAS/DLIS norms. Nigeria has a 2024 regulatory NDR framework. North America relies on state and provincial agencies and surveys rather than one federal NDR. Middle East and broader Asia NDR format details were not retrievable. Regulatory drone regimes are converging on SORA-style risk assessment (EU, Saudi) and a pending US Part 108.

### Cited Findings
- **UK**: The NSTA NDR Form & Manner (Sept 2025; a separate April 2025 version also exists) sets LAS/DLIS logs with the WONS-matched well ID, P7 deviation data, SEG-Y/SEG-D seismic, P1/P2/P6 navigation and an NDR CRS table (ED50/WGS84/ETRS89 UTM 27–31N, TM 0N). Reporting costs are borne by the licensee. — [NSTA Sept 2025](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf); [NSTA April 2025](https://www.nstauthority.co.uk/media/tetbcbto/information-reporting-form-and-manner-for-ndr-april-2025.pdf)
- **Norway**: Diskos 2.0 (Halliburton iEnergy cloud, more than 28 PB including a copy, 79 members, in-place DecisionSpace 365 access). EPSG v12.054 (Mar 2026) added Norwegian and Dutch geodetic data. — [Halliburton/BusinessWire](https://www.businesswire.com/news/home/20230530005201/en/Halliburton-Upgrades-Norwegian-Petroleum-Directorates-National-Data-Repository); [EPSG release history](https://epsg.org/whatsnew.html)
- **Netherlands**: NLOG/TNO provides LIS/LAS logs after a 5-year confidentiality period, plus bulk spreadsheets for some data types (deviation, gas composition, poro/perm, Rock-Eval). — [NLOG](https://nlog.nl/en/node/447)
- **EU drones**: SORA 2.5 adopted Sept 2025 (ED Decision 2025/018/R). — [Bureau Veritas](https://aero.bureauveritas.com/newsroom/easa-adopts-sora-25-new-simplifications-specific-category-drones)
- **Middle East**: Saudi GACA AC 107-01 (June 2025) covers the Specific Category, including the BVLOS route. — [GACA PDF](https://gaca.gov.sa/-/media/Files/PDF/LawsAndRegulation/Aviation-Safety-and-Environmental-Sustainability/Safety-and-Aviation-Standards-Advisory-Circulars/GACA-AC-107-01-Advanced-Operations-with-Unmanned-Aircraft-Systems.pdf) UAE GCAA's U-space regulation dates from March 2025. — [Gulf News](https://gulfnews.com/business/aviation/uae-sets-new-rules-to-integrate-drones-with-traditional-aircraft-safely-gcaa-1.500059697) Market Intelo puts MEA at 9.1% of oil & gas drone inspection (estimate). — [Market Intelo](https://marketintelo.com/report/drone-inspection-in-oil-and-gas-market)
- **Africa**: The Nigeria NUPRC NDR Regulations (2024, PIA) are funded by licensee contributions. The NDR is cited as an approved data-package source for the 2025 bid round. — [NUPRC NDR Regulations](https://nuprc.gov.ng/wp-content/uploads/2024/08/National-Data-Repository-NDR-Regulations-1.pdf); [vLex – Nigeria 2025 bid round clarifications](https://vlex.com/vid/nigeria-2025-bid-round-1105678758) Nigeria NCAA BVLOS is approved via the ROC. — [NCAA](https://www.ncaa.gov.ng/documents/advisory-circulars/assessment-methodology-for-beyond-visual-line-of-sight-bvlos-operations-for-remotely-piloted-aircraft/)
- **Asia-Pacific**: Australia NOPIMS (GA, WA DMIRS, NOPTA) is open-file with no registration. NOPTA log formats are LAS/DLIS; deviation is ASCII/LAS/XLS; delivery is by portable hard drive or web portal. — [GA NOPIMS](https://ga.gov.au/nopims/about-us); [NOPTA template](https://nopta.gov.au/_documents/templates/31/well-data-transmittal.docx) A Northern Territory deliverables list (Dec 2021) asks for wireline/MWD as DLIS and LIS, or LAS. — [NT Project deliverables](https://resourcingtheterritory.nt.gov.au/__data/assets/pdf_file/0010/1074961/Project-deliverables.pdf) Market Intelo puts APAC as the largest drone-inspection region at 35.2% (estimate, conflicts with GMI). — [Market Intelo](https://marketintelo.com/report/drone-inspection-in-oil-and-gas-market)
- **North America**:
  - No single federal NDR was found. The USGS NGGDPP funds state surveys to preserve and digitise logs (TIFF→LAS; LAS Certify QA). — [USGS](https://www.usgs.gov/programs/national-geological-and-geophysical-data-preservation-program/well-log-data)
  - The BC Energy Regulator hosts the CWLS LAS 3.0 spec in its Oil and Gas Operations Manual supporting documents. — [BC-ER](https://www.bc-er.ca/files/operations-documentation/Oil-and-Gas-Operations-Manual/Supporting-Documents/las3filestructure.pdf)
  - PHMSA uses PODS as the NPMS baseline. — [Texas RRC](https://rrc.texas.gov/media/unfdpnjf/pods-data-management-for-reporting-monique-roberts.pdf)
  - EPA OOOOb drone OGI approval dates from Sept 2025. — [EPA MATM-14](https://www.epa.gov/system/files/documents/2025-09/percepto-matm-014-508-9.26-to-edit.pdf)
  - FAA Part 108 is pending. — [AirData](https://airdata.com/blog/2026/part-108)
  - GMI puts North America above 30% of drone inspection (2024). — [GMI](https://gminsights.com/industry-analysis/inspection-drone-in-oil-and-gas-market)

### Inferences
- A regulator-profile feature (UK NDR, NOPTA/NOPIMS, NLOG, NUPRC, US state/BC-ER) that checks format, version, CRS and identifier rules before submission is a concrete, region-specific value proposition. UK and Australia offer the most explicit, published rule sets to encode first.
- Physical-media and portable-drive delivery (UK tape/USB, NOPTA hard drives) shows offline, large-file workflows remain official practice in 2025–2026.

### Gaps
- No primary format requirements retrieved for: India DGH NDR, Malaysia (PETRONAS/MPM), Indonesia (MIGAS/SKK Migas), Saudi/UAE/Oman/Kuwait/Qatar NDRs, Brazil ANP (BDEP), Canada AER, US BOEM/BSEE, Ghana, Angola, Namibia, South Africa, Kenya. The search budget was exhausted before these could be checked.
- Diskos's own formal submission format specification was not retrieved.
