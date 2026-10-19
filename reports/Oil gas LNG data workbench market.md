# Cloud-First Vendors Leave the Offline Niche Open

As of October 2026 there is a real but narrow opening for an offline, locally run data workbench for oil and gas and LNG. The case for it is structural: no source found in this research measures demand for offline oil and gas data tools directly. The most defensible spending figure is Rystad's estimate that exploration and production (E&P) companies bought about **US$25bn of digital and AI products in 2025, rising to more than US$35bn by 2030**. Desktop data preparation and quality control (QC) is a thin slice of that, plausibly hundreds of millions of dollars, not the US$20–40bn "digital oilfield" headlines (inference). The opening exists because every flagship platform and every methane-reporting product reviewed is cloud-first. Vendors are keeping their newest generative-AI features for software-as-a-service (SaaS) customers. The vendor field consolidated sharply in 2025–2026: Schneider Electric agreed to buy Cognite for US$3.1bn (pending approval), and SLB agreed to buy S&P Global's Kingdom and Petra desktop portfolio. Meanwhile, plant-network (OT) security, data-sovereignty law and cost pressure keep much engineering work on local machines. Of the five data areas, **(9) methane measurement-versus-inventory reconciliation is the sharpest unmet need**. OGMP 2.0 Level 5 and the EU Methane Regulation require it, measured emissions run about 1.6–4 times inventories at basin and national scale, and no open-source or offline tool does the full reconciliation. LNG custody-transfer recalculation and per-cargo emissions (10), regulator-rule validation of well and survey files (7, 8) and QC of 10 GB+ production exports (6) are strong secondary wedges. Regulation is in flux. On 14 October 2026 the European Commission proposed a one-year delay to importer methane rules, US federal rules are being rolled back, and Canada's are tightening. That makes versioned rule-packs worth more than any single template. The product will not replace the 5–8 years of oil and gas experience that job postings require. But a standards-literate methane-and-geospatial module sits where aviation safety, drone (UAV), GIS and HSE skills meet, and few candidates hold that combination. A free download that asks for name, email and country still brings in privacy law (GDPR, Nigeria, India, Saudi Arabia) and EU/UK sanctions on oil and gas software for Russia.

*Evidence labels used throughout: **[Verified]** means the claim was confirmed on the cited primary or reputable page; a verified forecast is still a forecast. **[Reported]** means it rests on a secondary summary, a search-result excerpt, a page that blocked access, or an unaudited vendor or organiser claim. **[Estimate]** marks market-research, consultancy or vendor-commissioned figures with opaque methods. **[Inference]** marks this report's own reasoning from the evidence. Research closed on 19 October 2026, and several regulatory items changed in the two weeks before that.*

## Credible spending anchors put the niche in the hundreds of millions

Headline market sizes for oil and gas software disagree too much to serve as an addressable market. Publishers put the 2025 "digital oilfield" anywhere from **US$5.86bn** to **US$39.65bn**. Most cluster at US$31–40bn with 5.5–6.5% annual growth [Estimate] ([Meticulous Research](https://meticulousresearch.com/reports/digital-oilfield-solutions-market-5529); [Research and Markets](https://www.researchandmarkets.com/report/digital-oilfield); [Grand View Research](https://www.grandviewresearch.com/industry-analysis/digital-oilfield-market)). "Oil and gas data management" ranges from **US$4.2bn to US$33.5bn** for the same year, with growth from 5% to 17% ([HTF MI](https://www.htfmarketinsights.com/report/4367043-oil-and-gas-data-management-software-market); [Dataintelo](https://dataintelo.com/report/global-oil-gas-data-management-market); [Future Market Insights](https://www.futuremarketinsights.com/reports/oil-and-gas-data-management-software-market)). "Emission management software" runs from about US$1.5bn to US$21.79bn; the top figure comes from a page that labels two different numbers as 2025 [Estimate] ([Precedence Research](https://www.precedenceresearch.com/emission-management-software-market); [Market Research Future](https://www.marketresearchfuture.com/reports/emission-management-software-market-41142)). Several data-management totals of US$26–29bn roughly equal Rystad's estimate for *all* E&P digital and AI purchases. They must therefore bundle sensors, IT services and telecoms with software [Inference].

The defensible anchors are narrower:

- **Rystad:** E&P companies spent about **US$25bn on digital and AI purchases in 2025**. This rises to more than **US$35bn a year by 2030** and nears US$50bn by 2035 [Verified] ([JPT](https://jpt.spe.org/rystad-puts-benefits-of-digitalization-ai-in-upstream-oil-and-gas-at-500-billion)).
- **Deloitte (using IDC and Gartner data):** US oil and gas AI spending is about **US$4bn in 2025 and US$13.4bn in 2029**, with AI's share of IT spend rising from 23% to 57% [Verified] ([Energy Capital HTX](https://energycapitalhtx.com/amp/deloitte-ai-energy-spending-report-2674290595)). A Deloitte leader quoted by JPT gave "less than 20%" now, rising to "more than 50%", which conflicts with those shares [Reported] ([JPT](https://jpt.spe.org/2026-year-of-cost-control-and-digital-transformation-roadmaps)).
- **Verdantix (the more transparent analyst):** industrial AI analytics software across all process industries is **US$3.2bn in 2025, growing about 20% a year to about US$9.3bn by 2031**. Carbon management software is **US$744M in 2025, growing 15% to almost US$1.8bn by 2031**. Verdantix warns explicitly that softer regulation is a headwind [Estimate] ([Verdantix industrial AI](https://www.verdantix.com/venture/report/market-size-and-forecast--industrial-ai-analytics-2025-2031-global); [Verdantix carbon management](https://www.verdantix.com/insights/report/market-size-and-forecast--carbon-management-software-2025-2031-global)).
- **For scale:** SLB's whole digital segment earned about US$2.7bn in FY2025 [Reported] ([SLB 10-K](https://www.sec.gov/Archives/edgar/data/87347/000119312526021017/slb-20251231.htm)).

Capital spending sets the backdrop. The IEA's World Energy Investment 2026 expects oil supply investment to fall for a third straight year, to below US$500bn. Natural gas investment rises more than 10% to **US$330bn, a ten-year high led by US and Qatari LNG**. Upstream spending in Africa and Central/South America rises more than 10%, while Middle East oil and gas investment slips 1% because of war damage [Verified] ([Zawya/Reuters](https://www.zawya.com/en/business/energy/natural-gas-spending-to-hit-10-year-high-in-2026-as-oil-investment-falls-iea-says-v0al61qp); [Fast Company ME](https://fastcompanyme.com/news/global-energy-investment-set-to-reach-record-3-4-trillion-in-2026/)). Software-heavy segments are growing faster than the roughly 6% digital-oilfield total: industrial AI analytics at about 20%, data-management software at 5–17%. Data tooling is therefore the growing part of a flat-to-falling budget [Inference]. Cost pressure cuts both ways. Free tools gain ground when Deloitte calls 2026 a year of "cost control" [Reported] ([JPT](https://jpt.spe.org/2026-year-of-cost-control-and-digital-transformation-roadmaps)), but enterprise buyers also cut experimental purchases.

For a free tool, countable units say more than top-down totals. Prices show a clear hole between the free tier and the paid tiers:

| Tier | Examples and indicative price |
|---|---|
| Free | Excel, KNIME's desktop platform, open Python libraries, SLB's Techlog Viewer |
| Paid analytics seats | About **US$1,200 per user per year for Seeq** and **US$5,195 for Alteryx Designer** [Estimate] ([Capterra](https://www.capterra.com/p/171687/Seeq/); [AutomationAtlas](https://automationatlas.io/answers/alteryx-pricing-explained-2026/)) |
| Drone photogrammetry suites | US$1,850–3,990 a year [Estimate] ([Pix-Pro](https://www.pix-pro.com/index.php/blog/photogrammetry-software-prices-2026)) |
| Subsurface suites | Petrel at **US$30,000–50,000 per user per year**, quoted by a licence-optimisation firm with an interest in stressing cost [Estimate] ([Open iT](https://openit.com/ja/blog/reduce-cost-on-petrel-ep-licenses-with-usage-metering/)) |

A consultancy puts the annual IT budget of a small operator (100–500 wells) at US$100K–2M [Estimate] ([Petropt](https://petropt.com/articles/og-databases-historians-guide/)). Countable workloads include:

- roughly **6,000–6,700 large LNG cargoes a year**, each with a load-port and a discharge-port custody transfer (Inference from 2025 trade of 428–437 Mt at 65–70 kt per cargo);
- **163 OGMP 2.0 member companies** that report every year [Verified] ([OGMP](https://www.ogmpartnership.org/));
- **about 2,000 UK wells to decommission by 2034** [Verified] ([OEUK](https://oeuk.org.uk/world-class-expertise-underpins-resilient-performance-in-decommissioning-sector/));
- **about 22,000 Canadian oil-producing sites** under the new federal methane rules in 2030 [Verified] ([Canada Gazette](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)).

The serviceable market for paid desktop data-preparation tools is plausibly in the low hundreds of millions of dollars. For a free product, adoption and professional reputation matter more than revenue [Inference].

| Anchor | Figure | Label | Use in this study |
|---|---|---|---|
| E&P digital and AI purchases | ~US$25bn (2025) → >US$35bn (2030) | Verified report of a Rystad estimate | Ceiling for all digital spend |
| US oil and gas AI spend | ~US$4bn (2025) → US$13.4bn (2029) | Verified report of a Deloitte estimate | Growth direction |
| Industrial AI analytics software, all process industries | US$3.2bn (2025) → ~US$9.3bn (2031) | Estimate, credible analyst | Ceiling for the analytics slice |
| Carbon management software | US$744M (2025) → ~US$1.8bn (2031) | Estimate, credible analyst | Ceiling for emissions software |
| GIS in oil and gas | US$3.44bn (2025) → US$5.53bn (2032) ([Reanin](https://www.reanin.com/reports/geographic-information-systems-applications-for-oil-and-gas-industry-market)) | Estimate | Order of magnitude only |
| Oil and gas drone inspection | US$1.0bn (2024) to US$1.8bn (2025) ([GMI](https://gminsights.com/industry-analysis/inspection-drone-in-oil-and-gas-market); [Market Intelo](https://marketintelo.com/report/drone-inspection-in-oil-and-gas-market)) | Estimate, conflicting | Order of magnitude only |
| Methane monitoring (hardware, services, software) | US$2.5–4.8bn (2025–26) ([Dataintelo](https://dataintelo.com/report/methane-emissions-monitoring-market); [Custom Market Insights](https://www.custommarketinsights.com/report/methane-monitoring-market/)) | Estimate, low transparency | Do not use as addressable market |
| Digital oilfield; O&G data management | US$5.9–39.7bn; US$4.2–33.5bn (2025) | Estimates that cannot be reconciled | Do not use |

## Consolidation and cloud-only AI are widening the offline gap

The vendor landscape consolidated faster in 2024–2026 than at any point in the past decade:

| Date | Deal | Status and source |
|---|---|---|
| April 2024 | Proemion agreed to buy TrendMiner | ([Verdantix](https://www.verdantix.com/insights/blogs/proemion-acquires-trendminer-to-complete-its-full-stack-industrial-data-and-analytics-offering)) |
| 12 March 2025 | Emerson completed its buyout of AspenTech, owner of the IP.21 historian | [Verified] ([Emerson](https://www.emerson.com/en-us/news/2025/emerson-completes-acquisition-of-remaining-outstanding-shares-of-aspentech)) |
| February 2026 | Zeitview acquired aerial-measurement firm Insight M | [Reported] ([Highwood Bulletin 083](https://www.highwoodemissions.com/bulletin/the-highwood-bulletin-083/)) |
| April 2026 | **SLB agreed to buy S&P Global's upstream software portfolio** (Kingdom, Petra, Harmony Enterprise, PowerTools, WellTest and others), whose users are mainly US onshore operators; closing expected between late 2026 and early 2027 | [Reported] ([SLB](https://www.slb.com/resource-library/article/2026/strengthening-customer-value-through-the-s-p-global-upstream-software-acquisition); [S&P Global](https://press.spglobal.com/2026-04-24-S-P-Global-Announces-New-Strategic-Direction-for-Upstream-Energy-Business)) |
| 30 June 2026 | **Schneider Electric agreed to buy Cognite for US$3.1bn in cash**, to merge it into AVEVA; pending regulatory approval | [Verified] ([Bloomberg](https://www.bloomberg.com/news/articles/2026-06-30/schneider-to-buy-industrial-ai-firm-cognite-for-3-1-billion); [ARC Advisory](https://www.arcweb.com/blog/schneider-electric-acquire-cognite-strengthen-industrial-ai-portfolio)) |

Methane-camera maker Kuva is also now part of Sensirion ([Kuva](https://www.kuvasystems.com/)). SLB's digital unit runs a 42% adjusted EBITDA margin on more than US$1bn of recurring revenue while moving Delfi users to SaaS [Verified] ([ADI Analytics](https://adi-analytics.com/2026/04/27/how-are-digital-and-software-growing-in-oil-gas/)). Consolidation like this usually brings price and roadmap uncertainty for desktop users. The most exposed are small US independents whose workflows are built on Kingdom and Petra [Inference].

The newest features are going to cloud customers first:

- **Seeq** now treats SaaS as its main deployment and offers its generative-AI features only to SaaS customers, so sites limited to on-premises installs cannot use them [Verified] ([Seeq support](https://support.seeq.com/latest/on-premise/seeq-saas-as-the-primary-deployment-model); [Seeq KB](https://support.seeq.com/kb/R65/on-premise/seeq-ai-assistant)).
- **SLB's Lumi data-and-AI platform** and **Microsoft Fabric's natural-language analytics** run as hosted services [Verified] ([SLB Lumi](https://www.slb.com/products-and-services/delivering-digital-at-scale/software/lumi/ai-delivered-by-the-lumi-platform); [CIO.com](https://www.cio.com/article/4228492/microsoft-is-pivoting-toward-a-unified-data-and-ai-platform-with-fabric.html)).
- **Every methane platform reviewed is a hosted web portal**: Highwood, Envana, Validere, Project Canary, Kuva and Bridger. None advertises desktop or air-gapped deployment. The only published price is Persefoni's free tier, and Persefoni has no methane features [Verified] ([Highwood](https://www.highwoodemissions.com/platform/); [Validere](https://www.validere.com/); [Persefoni](https://www.persefoni.com/pricing)).
- **Microsoft** raised Power BI Pro by 40%, to US$14 per user per month, in April 2025 [Verified] ([The Register](https://www.theregister.com/2025/04/02/microsoft_power_bi_hikes/)).

The flagship AI features are therefore out of reach for operators with on-premises or air-gapped mandates. That is the clearest single argument for a capable offline tool [Inference].

Several structural forces keep work on local machines:

- **Network design:** OT networks are segmented. Host SCADA, control (DCS) and safety systems stay on-premises or at the edge even in cloud-forward stacks ([Petropt](https://petropt.com/articles/og-databases-historians-guide/)). Hardware data diodes sell one-way replication of PI historian data across air gaps [Reported] ([Owl Cyber Defense](https://cdn.mediavalet.com/eunl/content/MysY2PQDB0mIYpOYTai4PA/Gm52lYwThkWLG5ErXOddLA/Original/Owl%20Cyber%20Defense%3A%20Securely%20Replicate%20PI%20System%20Data%20Across%20Segmented%20Networks.pdf)).
- **Cyber risk:** DNV's 2025 survey of 375 energy professionals found 65% rank cybersecurity as leadership's top business risk, 71% feel more exposed to OT-specific cyber events, and 57% say OT defences lag IT [Verified, via JPT] ([JPT](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)).
- **Trust:** A 2026 study of 190 upstream IT professionals called cloud reluctance "rational" [Reported; abstract only] ([ScienceDirect](https://www.sciencedirect.com/org/science/article/pii/S2156183426000112)).

The counter-trend is real too. Low-earth-orbit satellite links such as Seadrill's fleet-wide Starlink rollout weaken the "no bandwidth offshore" argument ([Seadrill](https://www.seadrill.com/wp-content/uploads/2025/06/Seadrill-Starlink-Brochure.pdf)), and majors run analytics on Snowflake and Databricks ([Petropt](https://petropt.com/articles/og-databases-historians-guide/)). The realistic 2026 picture is hybrid. Offline demand concentrates in five places [Inference]:

- OT-adjacent engineering work
- national oil companies (NOCs) under data-localisation rules
- consultants holding confidential client data
- remote sites
- small operators without cloud data teams

Hype about AI is running ahead of the data it needs:

| Signal | Finding | Label and source |
|---|---|---|
| Deployment | 62% of oil and gas respondents have deployed AI; about half plan AI agents within 12–24 months (Gartner, as reported by a consultancy) | [Reported] ([Smartbridge](https://smartbridge.com/2026-gartner-ai-predictions-oil-and-gas/)) |
| Pilots | 70% of oil and gas digitisation projects never leave pilot (McKinsey); 95% of generative-AI pilots show no measurable P&L impact (MIT NANDA) | [Reported, via JPT] ([JPT](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)) |
| Expectations | Only 27% of executives say cloud or AI has met expectations; 85% struggle to scale beyond single use cases | [Verified] ([EY](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/campaigns/energy-resources/documents/ey-ogc-future-of-energy-external-report.pdf)) |
| Readiness | An ADNOC Offshore engineer describes "incomplete and messy real-world data" from systems "never built to talk to one another" | ([JPT](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)) |

Data, not models, is the bottleneck. Deterministic, auditable data preparation therefore complements AI rather than competing with it, for example as the clean-data feeder for whatever assistant an operator later adopts. Optional AI assistance that runs on the device is a possible differentiator, but no survey measures demand for it [Inference].

Open-source engines now make 10 GB+ files workable on a laptop, but only for people who can code. Rules of thumb put pandas at 5–10 times the dataset size in RAM, so about 50–100 GB for a 10 GB file ([Ibis](https://ibis-project.org/posts/1tbc/)). Benchmarks show the gap:

- With memory capped at 5.84 GiB, **pandas failed to load the data, Polars completed 9 of 10 queries and DuckDB all 10** ([Uvik benchmark](https://uvik.net/blog/polars-vs-pandas/)).
- On ~140 GB of Parquet, DuckDB peaked near 1.3 GB of RAM against about 17 GB for Polars ([Codecentric](https://codecentric.de/en/knowledge-hub/blog/duckdb-vs-polars-performance-and-memory-with-massive-parquet-data)).

Orchestrators such as Airflow and Dagster need servers and Python ([DataCamp](https://www.datacamp.com/ja/blog/dagster-vs-airflow)). The OSDU industry data platform published its v1.0 standard in June 2026 ([IT Brief UK](https://itbrief.co.uk/story/open-group-launches-osdu-data-platform-standard-v1-0)). It still covers subsurface data first, with production data "to follow" ([TCS](https://www.tcs.com/what-we-do/industries/energy-resources-utilities/white-paper/osdu-data-platform-game-changer-oil-and-gas-industry)), and smaller operators find it "a daunting task" ([AWS](https://aws.amazon.com/blogs/industries/accelerate-osdu-adoption-ikon-science/)). A point-and-click interface over an embedded DuckDB-class engine fills the space between "free but needs code" and "no-code but US$5,000 a seat". OSDU-compatible export makes it complementary rather than competitive [Inference].

## Production, subsurface, geospatial and LNG data each offer a distinct wedge

The five data areas differ in file size, maturity of standards and regulatory pull, so the workbench's pitch differs by area. Methane (area 9) gets its own section below.

| Area | Typical inputs and sizes | Incumbents | Unfilled gap | Workbench fit [Inference] |
|---|---|---|---|---|
| (6) Operational/production | Historian, SCADA and accounting extracts as CSV/Excel; multi-GB; Excel stops at 1,048,576 rows | AVEVA PI, Honeywell PHD, IP.21; Quorum, P2, Enertia; Spotfire, Seeq | No-code QC of 10 GB+ exports; reconciling the historian against allocation | High; the core engine |
| (7) Subsurface/well | LAS 2.0/3.0, DLIS/LIS, WITSML 1.4.1.1/2.1, SEG-Y, P7 deviation surveys; terabyte archives | Petrel, Techlog, DecisionSpace 365, Kingdom; lasio, dlisio, segyio | Point-and-click validation against regulator rules | High for validation and conversion |
| (8) Geospatial/survey/drone/LiDAR | LAS/LAZ/COPC point clouds (~1 GB per small flight, 400 GB per county project), GeoTIFF, IOGP P-formats | ArcGIS, PODS, Pix4D, DJI Terra, Metashape, OpenDroneMap | Coordinate-system-audited conversion and packaging for GIS and integrity systems | Medium-high; avoid photogrammetry |
| (9) Emissions/methane | Raster plumes (COG), plume GeoJSON, CSV rates, continuous-monitor time series, OGMP .xlsx | Highwood, Validere, Envana, sensor portals, all cloud | Vendor-neutral offline OGMP Level 5 reconciliation with full lineage | Very high; flagship |
| (10) LNG cargo/operations | Custody-transfer records, gas compositions, certificates: small but high-value | Kongsberg and Emerson CTS systems, Quorum, ION ETRM, spreadsheets | Independent recalculation; per-cargo emissions statements | High value, smaller user base; 10 GB not relevant |

### Operational and production data: 10 GB exports collide with Excel's row limit

Production data sits in a layered stack:

- **Real-time historians.** AVEVA PI dominates; a consultancy claims about 85% of top oil and gas companies use it, a figure not traced to a primary source [Reported]. Honeywell PHD and IP.21 follow.
- **Production accounting and allocation** on SQL Server back ends (Quorum, P2, Enertia).
- **Excel glue** between them, including a "manual morning report via email" at mid-size operators ([Petropt](https://petropt.com/articles/og-databases-historians-guide/)).

Quorum's allocation product claimed more than 100 customers in 55 countries and over 40% of global hydrocarbon production in 2023 [Reported, vendor] ([Quorum](https://www.quorumsoftware.com/about/press-releases/quorum-software-announces-significant-momentum-for-energy-components-hydrocarbon-management-solution/)). A 1-second tag produces 86,400 points a day ([Petropt](https://petropt.com/articles/og-databases-historians-guide/)). PI stores UTC while client tools convert to local time. On the 23-hour daylight-saving day, shift queries move by an hour, and community replies say there is "no easy solution" [Verified] ([AVEVA PI Square](https://community.aveva.com/pi-square-community/f/pi-system-onboarding-hub/87407/the-dst-change-effected-the-time-range-on-my-data-data-retrieval-on-pi-datalink-is-there-a-work-around-for-this)). Guides recommend chunking exports because of Excel's 1,048,576-row limit ([PISharp](https://www.pisharp.com/article/716/export-pi-archive-data-to-csv-tools-methods)).

The documented failure modes are:

- gaps and flat lines when SCADA loses contact with remote units ([Greasebook](https://medium.com/@marleerosegreasebook/enhancing-data-quality-for-oil-and-gas-monitoring-systems-e795eb246597));
- spikes from sensor or power faults;
- compression that discards detail;
- calculated tags mistaken for raw signals ([arXiv 2211.06440](https://arxiv.org/pdf/2211.06440));
- historian figures that do not match production accounting, where "spreadsheet reconciliation is the current state for most operators" ([Petropt](https://petropt.com/articles/og-databases-historians-guide/)).

Automation is arriving at the top end. ExxonMobil schedules and validates well tests across 2,300+ Permian wells [Verified] ([SPE-230051](https://onepetro.org/SPEADIP/proceedings-abstract/25ADIP/25ADIP/D021S043R005/793018)). A 2026 SPE paper sells digital well-test control as "eliminating manual data entry", which shows manual entry is still the norm elsewhere ([OnePetro](https://onepetro.org/SPEOGWA/proceedings-abstract/26OPES/26OPES/D021S022R002/799157)).

This is where the 10 GB+ requirement is most real. Multi-year, multi-well SCADA and historian extracts easily exceed Excel's limit, and the matching QC rules map directly onto the failure modes above [Inference]:

- flat-line and stuck-value detection
- spike and rate-of-change detection
- gap flags
- awareness of raw versus calculated tags
- daylight-saving/UTC normalisation
- unit harmonisation (bbl/m³, Mscf/Sm³, psi/bar)
- historian-versus-allocation reconciliation

No source quantifies how often unit errors occur [Inference].

### Subsurface and well data: decades-old formats still govern submissions

The working well-data stack is file-based and old:

| Format | Status | Source |
|---|---|---|
| LAS 2.0 | "The most used digital well log distribution format" | [Verified] ([USGS](https://www.usgs.gov/programs/national-geological-and-geophysical-data-preservation-program/las-format)) |
| LAS 3.0 | Specification dates from 2000 | ([BC Energy Regulator](https://www.bc-er.ca/files/operations-documentation/Oil-and-Gas-Operations-Manual/Supporting-Documents/las3filestructure.pdf)) |
| WITSML 1.4.1.1 | Still the prevailing drilling-data version; "practically no uptake" of 2.0 since 2016 | [Reported, vendor, 2022] ([Falkor](https://falkor.com/blog/myth-busting-well-data-information-systems-witsml-vs-osdu)) |
| SEG-Y rev 2.1 | Published 2023, yet "most software programs do not totally follow the specification" | ([SEG wiki](https://wiki.seg.org/wiki/SEG-Y)) |

Energistics' April 2026 meeting agenda still lists **WITSML 1.4.1.1↔2.1 conversion guidelines and a v2.1 adoption task force**. OSDU's idea of "better ways (than files)" to access log data is only a new-initiative proposal [Verified] ([Energistics agenda](https://energistics.org/sites/default/files/2026-03/energistics-agenda-oslo-norway-april-2026.pdf)).

The quality problems are concrete:

- Null values (-999.25, -9999) that differ from the header's declared null ([Kansas Geological Survey](https://www.kgs.ku.edu/software/DEWL/HELP/pc_read/index.html)).
- Duplicate curve mnemonics ([lasio docs](https://lasio.readthedocs.io/en/v0.30/data-section.html)).
- Confusion between depth references (kelly bushing in the US, drill floor elsewhere) ([Wikipedia](https://en.wikipedia.org/wiki/Depth_in_a_well)).
- Raster-only legacy logs. One US federal archive alone holds about 200,000 well-log images ([NARA](https://www.archives.gov/records-mgmt/rcs/schedules//departments/department-of-the-interior/rg-0473/n1-473-06-002_sf115.pdf)).

National data repositories publish machine-checkable rule sets. The **UK NSTA's September 2025 Form & Manner** requires [Verified] ([NSTA](https://www.nstauthority.co.uk/media/khybwf0b/information-reporting-form-and-manner-for-ndr-september-2025-1.pdf)):

- logs in LAS or DLIS, with the LAS ~WELL wellbore ID matching the WONS well ID character for character;
- deviation data in IOGP P7/2000 or P7/17;
- seismic in SEG-Y rev 0/1/2 with fixed trace lengths, delivered on 3592 tape or USB-3 drives for large volumes;
- coordinates in a listed set of compliant coordinate reference systems.

Australia's NOPTA narrows logs to LAS and DLIS ([NOPTA](https://nopta.gov.au/_documents/templates/31/well-data-transmittal.docx)). Nigeria's NUPRC set up a repository under 2024 regulations ([NUPRC](https://nuprc.gov.ng/wp-content/uploads/2024/08/National-Data-Repository-NDR-Regulations-1.pdf)). Norway's Diskos 2.0 is sized for more than 28 PB [Reported, vendor] ([Halliburton/BusinessWire](https://www.businesswire.com/news/home/20230530005201/en/Halliburton-Upgrades-Norwegian-Petroleum-Directorates-National-Data-Repository)).

The tool market splits in two:

- **Commercial suites** are expensive and opaque on price. Petrel is the only one with a public price estimate, at US$30–50k per user per year, while SLB gives away a Techlog *viewer* ([SLB Techlog Viewer](https://WWW.SOFTWARE.SLB.COM/products/techlog/techlog-core-systems/viewer)).
- **Open-source libraries** are active but code-only:
  - Active releases: lasio 0.32 (August 2025), dlisio 1.0.4 (December 2025), segyio 1.9.14, and Equinor's xtgeo 4.27.0 (14 October 2026) [Verified] ([PyPI lasio](https://pypi.org/project/lasio/); [PyPI dlisio](https://pypi.org/project/dlisio/); [PyPI xtgeo](https://pypi.org/project/xtgeo/)).
  - Stalled: the higher-level welly and striplog have had no release since February 2022 [Verified] ([PyPI welly](https://pypi.org/project/welly/)).

The open community covers file reading better than QC and workflows. A point-and-click validator with per-regulator "submission readiness" profiles (UK NDR and NOPTA first, because their rules are explicit) fills that gap [Inference]. Files of 10 GB+ are realistic for DLIS image logs, SEG-Y and WITSML archives, but no direct DLIS size statistic was found [Inference].

### Geospatial, survey, drone and LiDAR data: coordinate errors and gigabyte point clouds

**Pipeline GIS standards.** Esri ArcGIS is the entrenched enterprise GIS. Pipeline models have converged on PODS 7, including an Esri Utility Network variant from April 2024 ([Pipeline Journal](https://pipeline-journal.net/news/new-data-model-release-pods-703-utility-network-advanced-pipeline-referencing-apr)). PHMSA, the US pipeline safety regulator, uses PODS as the baseline for its national pipeline map [Verified] ([Texas RRC](https://rrc.texas.gov/media/unfdpnjf/pods-data-management-for-reporting-monique-roberts.pdf)).

**Geodetic registry and formats.** IOGP maintains the EPSG geodetic registry, at v12.054 in March 2026. Software lags behind it: Esri shipped EPSG 12.018 only in November 2025 [Verified] ([EPSG](https://epsg.org/whatsnew.html); [Esri Community](https://community.esri.com/t5/coordinate-reference-systems-questions/epsg-release-and-arcgis-projection-engine/m-p/1679412)). The P1/11, P2/11 and P6/11 positioning formats moved to v2.0 in 2024 ([IOGP](https://www.iogp.org/blog/announcements/geomatics-announcements/iogp-releases-version-2-0-of-the-p6-11-seismic-bin-grid-data-exchange-format/)).

**Coordinate errors.** Industry guidance cites:

- a well spudded **about 400 km off target** after a crew misread latitude north as south;
- a contractor that drilled **12 dry wells in a row** because of confusion between true, magnetic and grid north;
- datum choice that can shift the same point by up to 500 m.

None of these cases names an operator ([Exprodat](https://www.exprodat.com/blog/managing-geodetic-risks-in-ep-4/)). Typical database checks only confirm that coordinates exist and fall in a UTM zone, so plausible-but-shifted points pass ([US Patent 10936561](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10936561)). Blue Marble sells coordinate translation that displays each system's area of use, which shows people pay for this ([Geo Week News](https://www.geoweeknews.com/?p=26419)).

**Drone and LiDAR.** Estimates of the oil and gas drone inspection market run from **US$1.0bn (2024, North America leading)** to **US$1.8bn (2025, Asia-Pacific leading at 35.2%)**, a direct conflict [Estimate] ([GMI](https://gminsights.com/industry-analysis/inspection-drone-in-oil-and-gas-market); [Market Intelo](https://marketintelo.com/report/drone-inspection-in-oil-and-gas-market)). EPA approved Percepto's autonomous drone optical gas imaging as an alternative test method under the NSPS OOOOb methane rule in September 2025 [Verified] ([EPA MATM-14](https://www.epa.gov/system/files/documents/2025-09/percepto-matm-014-508-9.26-to-edit.pdf)). Typical volumes:

- One small UAV LiDAR flight (about 5.8 ha) produced **1.0–1.3 GB of LAZ** ([Dryad](https://datadryad.org/dataset/doi:10.5061/dryad.jdfn2z3hk)).
- One crewed-aircraft county project delivered 403.2 GB ([USGS](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/WI_Shawano_2015/WI_Shawano_2015/reports/Shawano_WI_LiDARFinalDeliveryCheck_20160317_131603.pdf)).

**Beyond-visual-line-of-sight (BVLOS) rules remain the bottleneck:**

- **US:** The FAA's Part 108 final rule has been under White House (OIRA) review since 10 July 2026 and was unpublished as of early September [Reported] ([AirData](https://airdata.com/blog/2026/part-108)).
- **EU:** EASA adopted SORA 2.5 on 29 September 2025 ([Bureau Veritas](https://aero.bureauveritas.com/newsroom/easa-adopts-sora-25-new-simplifications-specific-category-drones)).
- **Saudi Arabia:** GACA issued AC 107-01 in June 2025 ([GACA](https://gaca.gov.sa/-/media/Files/PDF/LawsAndRegulation/Aviation-Safety-and-Environmental-Sustainability/Safety-and-Aviation-Standards-Advisory-Circulars/GACA-AC-107-01-Advanced-Operations-with-Unmanned-Aircraft-Systems.pdf)).

Employers want inspection findings tagged by asset, location, evidence type, confidence and severity, with PPK corrections, change detection, export to SAP PM or AVEVA integrity systems, and a full audit trail [Verified] ([AAA blog](https://blog.aaa.edu.au/drone-inspection-oil-and-gas/)).

The workbench should not compete with Pix4D, DJI Terra, Metashape or OpenDroneMap on 3D reconstruction. It should take their outputs and validate, reproject, tile, thin and package them, with these coordinate-system safeguards [Inference]:

- a bundled, versioned EPSG copy
- mandatory datum and transformation choices
- area-of-use warnings
- a reproducible transformation log

### LNG cargo and operations data: small files, high stakes, spreadsheet-bound

**How custody transfer works.** Ship-to-shore LNG custody transfer is still a static, tank-based measurement. Opening and closing custody transfer surveys record tank level, temperature, pressure, trim and list. A line sample analysed by gas chromatograph gives composition, from which density and gross calorific value (GCV) are *calculated*. Energy transferred is **E = V × D × GCV − displaced vapour ± gas burned in the engine room** ([sea-man.org, summarising the GIIGNL handbook](https://sea-man.org/lng-measurement.html)). The governing references are:

- the GIIGNL Custody Transfer Handbook, 6th edition (2021); no 7th edition was found ([GIIGNL](https://www.giignl.org/resources/custody-transfer-handbook-6th-edition-2021));
- ISO 10976:2023 for on-board measurement [Verified] ([ISO](https://www.iso.org/standard/83687.html));
- ISO 6976:2016 for calorific value.

The handbook discourages mixing ISO and GPA calculation bases ([sea-man.org](https://sea-man.org/lng-measurement.html)).

**Conventions differ by region:**

- EU terminals quote kWh at 25 °C combustion and 0 °C metering, while international trade uses MMBtu ([GAZ-SYSTEM](https://gaz-system.pl/dam/jcr:4854ad28-4d3c-4e93-a9e8-9862d86fe331/PX-OI-30-1-F-5_rev7-0_LNG_quality_certificate.pdf)).
- Published tonne-to-energy factors conflict: 53.38 versus 52.14 MMBtu per tonne ([Konkurentsiamet](https://www.konkurentsiamet.ee/sites/default/files/konsultatsioonid/annex_13_-_conversion_table_-_30_sep_2022.pdf); [henergy](https://henergy.com/conversion)).
- Platts standardised its MMBtu-to-GJ factor at **1.055056 on 24 August 2026** [Verified] ([S&P Global Platts](https://www.spglobal.com/energy/en/pricing-benchmarks/our-methodology/subscriber-notes/082426-platts-standardizes-mmbtu-gig-conversion-factor)).

**Tools and spreadsheets.** On-board systems such as Kongsberg's K-Gauge automatically generate the custody transfer report, "the official document used for purchasing the gas" ([Kongsberg](https://www.kongsberg.com/maritime/products/tank-gauging-and-measurment-systems/custody-transfer-system)). Quorum claims "more than 50% of the world's LNG" runs through its software [Reported, vendor] ([Quorum](https://www.quorumsoftware.com/solutions/lng-distribution/import-export-terminal-management/)). Spreadsheets still carry much of the load:

- A US patent states that many LNG projects "use simple spreadsheets for scheduling ships" ([USPTO 10878349](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10878349)).
- Emerson says terminal data is "entered manually into complex spreadsheets that were written years ago", with macro errors flowing into audit trails that "could result in fines or cancellation of contracts" [Reported, vendor] ([Gas Processing & LNG](https://www.gasprocessingnews.com/articles/2024/02/navigating-the-complex-lng-value-chain)).

**Boil-off.** Boil-off adds another reconciliation layer. Charterparties typically guarantee no more than **0.15% per day** ([Steamship Mutual](https://www.steamshipmutual.com/publications/articles/lng0805)). Gard reports disputes over whether the calculation basis is 100% or about 98% of capacity, and over exclusions ([Gard](https://www.gard.no/en/insights/when-cargo-becomes-fuel-complexities-of-boil-off-and-reliquefaction-in-lng)). From 2026, ship methane slip falls under the EU ETS. Default slip factors conflict between sources (3.1% versus 7% for some engine types), and one measured vessel showed 1.34–1.36% ([Manifold Times/DNV](https://www.manifoldtimes.com/news/dnv-eu-guideline-for-reporting-and-verifying-actual-methane-slip-for-fueleu-eu-mrv-ets/); [Gasum](https://www.gasum.com/en/news-and-customer-stories/articles/2026/eu-ets-and-fueleu-maritime-the-double-dividend-of-lng-compliance-in-2026/); [JMSE](https://mdpi-res.com/d_attachment/jmse/jmse-14-01315/article_deploy/jmse-14-01315.pdf)).

**Per-cargo emissions are moving from voluntary to contractual:**

- Cheniere's cargo emission tags (since 2022) are model estimates, "not a precise measurement" ([Cheniere](https://www.cheniere.com/our-responsibility/climate/ce-tags)).
- In March 2024 MiQ had certified about 20% of US gas production, at a premium of only 1–5 cents ([Hellenic Shipping News](https://www.hellenicshippingnews.com/miq-targets-lng-buyers-amid-oversupplied-us-certified-gas-market/)).
- The JERA- and KOGAS-led CLEAN questionnaire drew methane answers from only 7 of 20 LNG projects ([FoE Japan](https://foejapan.org/wpcms/wp-content/uploads/2025/08/FoE-Japan.-Is-CLEAN-Clean.-EN.pdf)).
- Under the EU Methane Regulation, the core problem is tracing portfolio and FOB US cargoes back to producers ([CSIS](https://www.csis.org/analysis/eu-methane-rules-impact-global-lng-exporters)).

**Market volume.** The market is large and fragmented. GIIGNL counts **428 Mt of 2025 imports**, IGU **437 Mt** and Shell **422 Mt**. Liquefaction capacity reached about 524 MTPA, with 9 FIDs and three new exporters (Canada, Mauritania, Senegal) ([GIIGNL](https://www.giignl.org/annual-report); [IIF-IIR/IGU](https://iifiir.org/en/news/world-lng-report-2026-north-american-exports-drive-record-growth-for-global-lng-trade); [Shell](https://www.shell.com/what-we-do/oil-and-natural-gas/liquefied-natural-gas-lng/lng-outlook-2026.html)).

**What this means for the workbench.** The data per cargo is small but high-stakes. Illustrative arithmetic: a 155,000 m³ cargo is about 3.7 million MMBtu, so at an assumed US$10/MMBtu a 0.1% energy discrepancy is worth about US$37,000 [Inference]. Here the 10 GB requirement is irrelevant. The value lies in a deterministic recalculation that records the standard edition and reference conditions, side-by-side ship/shore comparison, and audit packs. Likely users are surveyors, buyers' measurement teams, the 49 FSRU operators and new importers (Bahrain, Senegal, Egypt) whom enterprise systems underserve [Inference]. Because these are fiscal calculations, the tool must present itself as an independent check, not a certified measurement [Inference].

## Methane reconciliation is the sharpest unmet need

### Reconciliation is an annual audit trail, not a single comparison

OGMP 2.0's official guidance defines reconciliation as "comparing source-level (Level 4) inventories with independent site-level measurements to produce Level 5 asset emissions estimates". It calls this "an iterative process of investigation, year over year". The guidance sets out these requirements [Verified] ([OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)):

- the two estimates must be on "the same basis", in both spatial coverage and time frame;
- uncertainty must follow GUM and Monte Carlo methods (JCGM 100/101);
- every individual measurement must be reported, whether or not the estimates converge;
- the site-level and source-level campaigns must be independent;
- because emission distributions are skewed and fat-tailed, small samples "can bias low".

The FAQ adds three rules [Verified] ([OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)):

- site-level measurement should cover a nominal one-third of assets;
- satellites "cannot be used as site-level technology" unless a site emits constantly above their detection threshold;
- when a satellite sees nothing, it is "not appropriate to assume emissions for that facility are zero".

The guidance is a 2022 "final draft" and deliberately non-prescriptive. It sets no statistical test, no data schema and no file format. Every operator and vendor builds its own method, and that missing standard is exactly where transparent, documented tooling earns its place [Inference].

Regulation turns this into a deadline. Under the EU Methane Regulation, as mirrored from the legal text [Verified, mirror site; EUR-Lex not checked] ([LawPlayer](https://lawplayer.com/eu/act/32024R1787)):

- Article 12(3) requires source-level quantification "complemented by site-level measurement" with independent verification, by 5 February 2027 for operated assets and 5 August 2028 for non-operated assets, then annually by 31 May.
- Article 12(5) lets operators use OGMP 2.0 technical guidance until EU measurement standards exist.
- OGMP 2.0 Level 5 is a named route to importer equivalence ([European Commission](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)).

OGMP had **163 member companies in 90 countries covering 43% of global production**. At its 15 October 2026 report launch it said **69% of reported emissions are now measurement-based** [Verified] ([OGMP](https://www.ogmpartnership.org/)). EDF's December 2025 analysis, using the earlier count of 153 members, found **31 companies reporting Level 5 for at least half of operated production, up from 7 in 2023** [Verified] ([EDF Leveling Up 2025](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)).

### Measured emissions run one and a half to four times inventories

The gap is large and consistent across methods:

| Study or source | Finding | Label and source |
|---|---|---|
| Sherwin et al. 2024 (*Nature*) | 986,238 aerial site measurements put the US weighted loss rate at **2.95%** of gas production, about three times the government inventory's ~1%, with regions ranging from 0.75% to 9.63% | [Verified] ([Stanford EAO](https://eao.stanford.edu/publications/journal-articles/us-oil-and-gas-system-emissions-nearly-one-million-aerial-site)) |
| Alvarez et al. 2018 | US supply-chain emissions about 60% above the EPA inventory | ([Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)) |
| IEA Global Methane Tracker 2025 | Energy methane about **80% higher** than what countries report to the UNFCCC; gap narrowest in Europe | [Verified] ([IEA](https://www.iea.org/reports/global-methane-tracker-2025/key-findings)) |
| Permian aerial LiDAR inventory | 3.13% loss rate; authors disclose a financial interest in the sensor vendor | ([ACS ES&T](https://pubs.acs.org/esthag/article/60/19/13968/5069689/Aerial-LiDAR-Based-Source-Resolved-Methane)) |
| MethaneSAT data on the Permian | About four times reported emissions; source is a US Senate minority (political) release, and the satellite was lost in June 2025 | [Reported] ([Senate EPW](https://www.epw.senate.gov/public/index.cfm/2026/3/whitehouse-investigates-alarming-mismatch-between-reported-methane-emissions-and-actual-methane-emissions-in-permian-basin); [EDF](https://www.edf.org/media/methanesat-loses-contact-satellite)) |

At company level, reaching Level 5 produces a "methane U-curve": reported intensity falls from Level 2 to Level 4, then rises at Level 5 as site surveys find missed sources ([EDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)):

- **Devon's** reported emissions rose **309%**.
- **Cheniere's** rose **379%**. Up to 58% of its emissions were inaccessible to optical-gas-imaging crews, and intensity varied six-fold between surveys.
- **Eni's** reported 60% fall was mostly a reporting-boundary change; without it the fall would have been 5%.
- **Petrobras** reports "significant challenges in reconciling short-duration measurements with annualized inventories".

These swings carry reputational and contractual weight, so a defensible, explainable reconciliation is worth paying for [Inference].

The measurement layers differ by two to three orders of magnitude in detection limit. That is the integration problem:

| Measurement layer | Detection threshold | Reported quantification error | Typical outputs |
|---|---|---|---|
| Continuous monitors (point and path) | 0.22 kg/h minimum detected (path sensor); 3–30 kg/h at 90% detection across a 2023 blind test ([Elementa](https://online.ucpress.edu/elementa/article/12/1/00022/202933/Single-blind-detection-localization-and); [ES&T](https://pubs.acs.org/doi/10.1021/acs.est.2c09235)) | −44% to +586% at 0.1–1 kg/h | Time series, annual summaries |
| Drones (mass balance) | Sub-kg/h claimed | ~16% RMSE in steady wind; over 100% for some systems ([AMT 2025](https://amt.copernicus.org/articles/18/1301/2025/)) | Flux estimates, imagery |
| Aerial LiDAR | ~1.0 kg/h at 4 m/s wind in testing; 3 kg/h commercial spec ([eScholarship](https://escholarship.org/uc/item/5bw1m4g2)) | −64% to +87% per estimate | Plume maps, rates |
| High-resolution satellites | ~100 kg/h (GHGSat); 66–144 kg/h (Tanager-1) ([EGUsphere](https://egusphere.copernicus.org/preprints/2026/egusphere-2026-3662/); [Carbon Mapper preprint](https://egusphere.copernicus.org/preprints/2025/egusphere-2025-2275/egusphere-2025-2275.pdf)) | Wind-dependent | 16-bit GeoTIFF plus CSV; API or bulk after 30 days |
| NASA EMIT (on the space station) | Plume complexes at 60 m ([NASA](https://data.nasa.gov/dataset/emit-l2b-estimated-methane-plume-complexes-60-m-v002)) | Uncertainty layer supplied | Cloud-optimised GeoTIFF plus GeoJSON |

### Every commercial tool is cloud-hosted, and no open tool closes the loop

Commercial offerings cluster around measurement-informed inventories:

- **Highwood** launched its platform in January 2025 as "the world's first software for OGMP 2.0 methane reporting" ([PR Newswire](https://www.prnewswire.com/news-releases/highwood-launches-the-emissions-intelligence-platform-eip-for-oil-and-gas-companies-the-worlds-first-software-for-ogmp-2-0-methane-reporting-and-measurement-informed-inventories-302351128.html)).
- **Envana** cites PETRONAS, PTTEP and Aker BP as users ([Envana](https://www.envana.com/ogmp/)).
- **Validere** integrates with GHGSat, Snowflake, SAP and Maximo ([Validere](https://www.validere.com/)).
- **Sensor vendors** (Qube, Kuva, Bridger, Project Canary) export summaries from their own portals.

None publishes pricing or offers offline deployment [Verified page review]. Independent checking is rare. UT-Austin's EEMDL reproduced Cheniere's model outputs, while the external assurance on that work was "a procedural check… not a validation of the emissions magnitudes" ([EDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)).

The open building blocks are solid but stop short of reconciliation:

- **pyELQ** (Shell, Apache-2.0) detects, locates and quantifies emissions from point or beam sensors ([PyPI](https://pypi.org/project/pyelq-sdk/1.0.10)).
- **UNEP's MARS-S2L** satellite plume code is LGPL, but its trained models and data are licensed non-commercially ([PyPI](https://pypi.org/project/marss2l/)).
- **LDAR-Sim** was actively maintained as of October 2026 ([GitHub](https://github.com/LDAR-Sim/LDAR_Sim)).
- **Public plume data** is freely downloadable: EMIT, Carbon Mapper and UNEP's methanedata portal.

No open-source project performs the full chain [Inference]:

- an asset hierarchy
- spatial matching of plumes to assets
- temporal annualisation
- Monte Carlo comparison
- an audit trail

### Boundaries, timing and lineage cause the real pain

The hard problems are not arithmetic. Highwood and Astra's September 2026 briefing sets out a six-step diagnostic, and explicitly warns against "adjusting emission factors to force agreement" [Reported, vendor] ([Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)):

1. verify scope;
2. align timing with operator logs;
3. verify activity data;
4. establish operating modes (tank filling, vapour recovery unit status, flare status);
5. characterise uncertainty;
6. only then revise rates.

Validere's practitioner list adds:

- hierarchies that differ across operations, HSE and sustainability teams, turning reconciliation "into arguments about boundaries";
- "a non-detection is not a zero";
- "no lineage from sensor reading to reported cell" [Reported, vendor] ([Validere](https://blog.validere.com/ogmp-2-0)).

Activity data is itself incomplete: one study found nearly 900 more gathering compressor stations than EPA had counted ([Highwood](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)). Satellite alerts add triage work. UNEP's Methane Alert and Response System has notified more than 5,000 actionable events in 34 countries, with about 12% receiving a response in 2025 [Reported, IEA excerpt] ([IEA](https://www.iea.org/reports/responding-to-satellite-notifications-from-the-methane-alert-and-response-system)). UNEP's own press release gives more than 3,500 alerts in 33 countries, a different count from a different date ([UNEP](https://www.unep.org/en/news-and-stories/press-release/better-data-driving-action-methane-emissions-more-work-needed)).

A reconciliation workbench therefore needs seven core functions [Inference]:

1. A canonical asset/site/source hierarchy with site polygons and equipment points.
2. A common measurement schema carrying rate, uncertainty, detection limit and probability-of-detection curve, time window, platform, wind source and a detect/non-detect flag.
3. Spatial matching of plumes to sites, with ambiguity flags for neighbouring sites.
4. A temporal join with SCADA, maintenance, blowdown and flare logs.
5. Monte Carlo annualisation of intermittent events.
6. Versioned methods, so a method change cannot pass for a real reduction.
7. Export to OGMP's .xlsx templates and, once adopted, the EU reporting templates published in draft on 9 October 2026 ([European Commission](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)).

Four customer groups need this [Inference]:

- operators;
- accredited verifiers, who must independently re-run calculations and whose shortage the Commission cited as a reason for its delay proposal ([Linklaters](https://sustainablefutures.linklaters.com/post/102o5fh/european-commission-proposes-delaying-key-eu-methane-regulation-import-and-report));
- consultants;
- EU importers, who must collect producer data with "no common reporting template" ([European Commission](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)).

A simple "alert-to-asset" matcher for satellite notifications is a quick, concrete first feature [Inference].

## Regulatory churn and sovereignty rules shape regional demand

### Rules are tightening in Europe and Canada and loosening federally in the US

The EU Methane Regulation's operator duties are already running. Source-level reports were due from August 2025. Leak detection and repair (LDAR) programmes were due by May 2025, with repair thresholds as low as 500 ppm or 1 g/h. Records must be kept for at least ten years, and routine flaring is banned for existing sites ([LawPlayer](https://lawplayer.com/eu/act/32024R1787)). The importer side is being softened in stages:

| Date (2026) | Step | Source and status |
|---|---|---|
| March | Importer guidance tool published | ([European Commission](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)) |
| 20 July | Recommendations EU/2026/1834 and 1835: model contract clauses, and a request that Member States hold back penalties | ([European Commission](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)) |
| 9 October | Draft reporting templates | ([European Commission](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)) |
| 14 October | **Proposal to delay importer MRV equivalence and methane-intensity reporting by about a year**, citing energy security amid Middle East market stress; needs Parliament and Council approval | ([Linklaters](https://sustainablefutures.linklaters.com/post/102o5fh/european-commission-proposes-delaying-key-eu-methane-regulation-import-and-report)) |

Reports conflict on the proposal's new dates. Linklaters gives importer equivalence moving from 1 January 2027 to 31 May 2029, while MLex and bne IntelliNews say January 2028 ([MLex](https://www.mlex.com/mlex/articles/2537643); [bne IntelliNews](https://www.intellinews.com/eu-adopts-proposal-to-postpone-eu-methane-regulations-by-one-year-476877)). Whether operator Article 12 dates move is unclear. Demand for importer tools slips one to two years, while operator-side demand continues [Inference].

In the US, the federal picture is a rollback:

- The Waste Emissions Charge rule was nullified on 14 March 2025 [Verified] ([EPA](https://www.epa.gov/inflation-reduction-act/waste-emissions-charge)).
- Many NSPS OOOOb deadlines moved to 22 January 2027 ([ALL4](https://www.all4inc.com/4-the-record-articles/u-s-epa-extends-compliance-deadlines-for-oil-and-natural-gas-sector/)).
- EPA proposed suspending Subpart W (petroleum and natural gas emissions reporting) until 2034, but this was not final as of 15 September 2026 ([Gable Gotwals](https://www.gablelaw.com/news-articles-blogs/client-alerts/environmental-alert-epas-greenhouse-gas-reporting-program-remains-in-effect-despite-proposed-rollback/)). Reports for 2025 under the expanded rule are therefore due on **30 October 2026** [Verified] ([Federal Register](https://www.federalregister.gov/documents/2026/02/27/2026-03995/extending-the-reporting-deadline-under-the-greenhouse-gas-reporting-rule-for-2025)).

State rules continue regardless. Colorado's annual inventory and New Mexico's 98% gas-capture target for the end of 2026 still apply, and European buyers are asking US LNG suppliers for methane documentation ([TetraSoft](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)).

Canada's SOR/2025-280 goes the other way. Main obligations start on 1 January 2028. Its performance pathway requires sensor readings every 15 minutes and annual reports by 30 June [Verified] ([Canada Gazette](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)).

The regimes overlap and do not match. Subpart W, Colorado and New Mexico calculate the same sources differently ([TetraSoft](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)). Changing rules is itself a buying criterion, which favours versioned rule-packs and one-dataset-to-many-regimes crosswalks [Inference].

### Regions differ more in constraints than in needs

| Region | Demand pull | Main constraint | Best-fit users | Fit [Inference] |
|---|---|---|---|---|
| Europe | EU methane operator duties, ETS shipping methane, data-repository rules, decommissioning | GDPR applies to registrations; North Sea jobs shrinking | Late-life operators, decommissioning contractors, verifiers, LNG terminals | High |
| Middle East/GCC | NOC expansion, Qatar LNG growth, localisation rules that favour local processing | ICV/IKTVA scoring, in-house AI stacks, war disruption, nationalisation quotas | Contractors, consultants, universities | Medium, indirect |
| Africa | Upstream up >10% in 2026, new LNG exporters, flaring programmes, national data repositories | Local-content rules for IT work, NDPA registration, thin budgets | Indigenous operators, service firms, universities, regulators | Very high for a free tool |
| North America | Largest software market, state methane rules, Canada 2028, consolidation of desktop tools | Federal rollback, layoffs, majors locked into enterprise platforms | Small independents, consultants, LNG exporters' emissions teams | High |
| Asia-Pacific | Indian and Chinese sovereignty, Australian open data and decommissioning, Japan/Korea supplier questionnaires | China effectively closed; India's DPDP Act applies from May 2027 | Indian NOC staff and universities, Australian late-life operators, trading houses | Medium-high, excluding China |

**Europe** combines the strictest methane regime with decline:

- UK decommissioning spend passed £2bn in 2024 and could exceed capex as early as 2028 [Verified] ([OEUK](https://oeuk.org.uk/world-class-expertise-underpins-resilient-performance-in-decommissioning-sector/)).
- Norwegian investment is forecast to fall 6.5% in 2026 [Reported] ([Offshore Magazine](https://www.offshore-mag.com/regional-reports/north-sea-europe/news/55342950/norwegian-offshore-directorate-nod-predicts-steady-lower-exploration-levels-offshore-norway-in-2026)).
- The EU Data Act has applied since 12 September 2025 ([Eubelius](https://www.eubelius.com/en/news/the-eu-data-act-in-force-what-changes-on-12-september-2025)).
- Gartner expects European sovereign-cloud spending to triple between 2025 and 2027 [Reported] ([DCD](https://www.datacenterdynamics.com/en/news/europe-spending-on-sovereign-cloud-infrastructure-to-triple-from-2025-2027-gartner/)).

Legacy well files for about 2,000 UK abandonments make decommissioning data packs a concrete use case [Inference].

**The GCC** has the most aggressive digital adopters, and they build their own sovereign stacks. ADNOC reported about US$500m of AI value in 2023 [Reported] ([Gulf News](https://gulfnews.com/business/energy/adnoc-generated-500-million-in-value-with-ai-1.1709628155819)). Sovereignty rules are tightening:

- **Saudi Arabia** published draft PDPL amendments on 8 October 2026. The draft adds an **express requirement to store personal data inside the Kingdom**; consultation closes on 5 November [Verified] ([Clyde & Co](https://www.clydeco.com/en/insights/2026/10/sdaia-publishes-draft-amendments-to-the-pdpl)).
- **The UAE** requires full PDPL compliance by 1 January 2027 [Verified] ([Kayrouz](https://www.kayrouzandassociates.com/insights/cross-border-data-transfers-under-uae-law-in-2026)).

Local-content scoring is a high bar for foreign vendors. Aramco's IKTVA target rises from 66% to 70% over a contract [Verified] ([Pinsent Masons](https://www.pinsentmasons.com/out-law/analysis/2025/12/middle-east-oil-gas-contract-negotiations-contractors)), and ADNOC bidders without an ICV certificate score zero [Reported] ([Mondaq](https://www.mondaq.com/Article/819646/Service-Providers-And-ICV)). A free tool avoids this scoring, but it will rarely become an NOC enterprise standard. Its route in is through contractors and universities, with "nothing leaves the device" as the honest pitch [Inference].

**Africa** is arguably the best fit. Upstream investment is about US$37–41bn and rising: the IEA figure is US$37bn for 2025, while Moore Global gives US$40bn for 2025 rising to US$41bn in 2026, a conflict [Reported] ([Leadership.ng](https://leadership.ng/?p=657461); [Moore Global](https://www.moore-global.com/news/africas-41-billion-upstream-oil-and-gas-investment-surge-in-2026/)). Other drivers:

- Mozambique LNG restarted in January 2026, targeting first LNG in 2029 ([World Oil](https://worldoil.com/news/2026/1/29/mozambique-lng-restarts-onshore-offshore-activities-after-force-majeure-lift)).
- Nigeria, Algeria and Libya are among the nine countries that account for 83% of global flaring ([World Bank](https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data)).

The constraint is local content. Nigeria's content board enforces engagement of local companies for "all IT-related jobs" [Reported] ([Shipping Position](https://shippingposition.com.ng/ncdmb-nitda-set-up-committee-on-local-content-development-in-oil-gas/)), so training and support should run through Nigerian partners [Inference].

**North America** is the largest software market, but the most exposed segment is small independents facing the SLB–S&P transition [Inference]. US majors cut staff heavily in 2025: Chevron about 20% and ConocoPhillips 20–25% [Reported] ([UPI](https://www.upi.com/Top_News/US/2025/09/04/conocophillips-lay-offs/3821757006954/)).

**Asia-Pacific** splits three ways:

- **Australia** runs open-file data (NOPIMS needs no registration) ([Geoscience Australia](https://ga.gov.au/nopims/about-us)) and approved day-and-night drone flights beyond line of sight over Cooper Basin oilfields ([AAA blog](https://blog.aaa.edu.au/drone-inspection-oil-and-gas/)).
- **India and China** have the strongest sovereignty pull. India's DPDP transfer rules apply from 13 May 2027 [Verified] ([Hogan Lovells](https://www.hlc.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-)). China's important-data regime has applied since January 2025 ([Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2024/12/prc-network-data-security-management-regulations)). China's NOCs use domestic software, so its market is effectively closed [Inference].
- **Japan and Korea** matter as LNG buyers. Japanese Gulf LNG imports fell 95% year on year to April 2026 [Reported] ([AGBI](https://www.agbi.com/trade/2026/08/japan-and-lng-biggest-victims-of-hormuz-trade-disruption/)).

## Engineers lose a quarter or more of their time to data, and employers hire for domain years

### Pain points are about finding, fixing and proving data

The widely quoted "50–80% of time on data" claims for oil and gas rest on old or vendor sources:

- AAPG gave a 30–70% range for interpreters, without a formal survey ([AAPG](https://www.aapg.org/news-and-media/explorer/managing-data-or-finding-oil/)).
- Vendors claim up to 70–90% ([INT](https://www.int.com/blog/how-osdu-can-help-data-management/)).

The most neutral recent evidence is Seequent's 2023 survey of about 700 geoscience professionals [Verified, vendor-run] ([Seequent](https://seequent.com/how-well-does-the-energy-industry-manage-its-data-we-have-the-facts-figures-and-opinions-from-around-the-world)):

- **24% spend more than 30% of their time on data management.**
- **Oil and gas has the lowest share with an established data-management framework, at 14%** (mining 39%).
- **57% cite unmanaged historical data.**

Seequent's 2021 survey found 35% spent more than 30% of their time on data, but its respondents were 72% mining and only 6% energy ([Seequent 2021](https://files.seequent.com/PDFs/Seequent-Geoscience-Data-Management-Report-2021.pdf)). The defensible statement is that **roughly a quarter to a third of technical staff spend more than 30% of their time on data**. Higher percentages are folklore [Inference].

The pain points differ by role:

- **Engineers:** daylight-saving shifts, historian-versus-accounting mismatches and manual well-test entry (production); null and mnemonic errors and coordinate-system drift (subsurface).
- **HSE and emissions staff:** record-keeping (at least three years for Subpart W, ten years for EU LDAR), deadlines that keep moving, and methodology crosswalks between regimes ([TetraSoft](https://tetrasoftco.com/blog/ghgrp-subpart-w-still-required-2026/)).
- **LNG terminal staff:** macro-laden legacy spreadsheets.
- **Data staff:** tool sprawl. One Continental Resources role maintains both Spotfire and Power BI and is told to "automate manual workflows" with UiPath, Grooper or Alteryx [Verified] ([Jobright/Continental](https://jobright.ai/jobs/info/69e91657e0cd471b2f13a330)).

### Employers want SQL, BI tools and years in the industry

Real 2026 postings put **advanced SQL plus Spotfire and/or Power BI** first, with Python and Databricks "preferred":

- An Experis upstream data analyst contract pays **US$60–70 an hour** [Verified] ([Experis](https://www.experis.com/en/job/407294/data-analyst-iii)).
- Continental requires **at least 8 years in oil and gas** [Verified] ([Jobright](https://jobright.ai/jobs/info/69e91657e0cd471b2f13a330)).

Other roles have their own gates:

- **Pipeline GIS:** ArcGIS Pro, pipeline referencing, PODS/APDM, ArcPy, and up to 7 years of oil and gas experience [Reported] ([Energyhire/Hilcorp](https://app.energyhire.com/job-board/sr-gis-analyst-houston-tx-b6916ba1-0c24-4816-b786-8c5e4ce9d4e1)).
- **Emissions:** OGMP 2.0, Subpart W and EU Methane Regulation knowledge, including UNEP consultancy posts advertised in September 2026 [Reported] ([UN Careers](https://careers.un.org/jobSearchDescription/284798)).
- **Drones (Australian example):** RePL pilot and ReOC organisation licences, BVLOS approvals and a documented safety management system (SMS) [Verified] ([AAA blog](https://blog.aaa.edu.au/drone-inspection-oil-and-gas/)).
- **HSE entry:** NEBOSH IGC or OSHA 30 plus IOSH, BOSIET/HUET offshore survival tickets, ISO 45001 auditing, ICAM or TapRooT investigation, and HAZID/HAZOP and bow-tie analysis [Verified] ([Rigzone](https://www.rigzone.com/insights/career-advice-4/how-to-transition-into-an-hse-officer-role-in-oil-and-gas-613)).

EY's survey of 508 oil and gas and chemicals respondents shows which skills executives most often rate "inadequate": **geospatial analytics at 26%**, AI at 22% and programming at 20% [Verified] ([EY](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/campaigns/energy-resources/documents/ey-ogc-future-of-energy-external-report.pdf)).

The only reliable cross-regional pay data covers engineering and HSE roles, not data roles. Airswift's GETI 2026 gives HSE manager permanent salaries of [Verified] ([Airswift](https://www.airswift.com/blog/what-energy-jobs-pay)):

| Region | HSE manager salary (USD/yr) |
|---|---|
| Australasia | 189,736 |
| North America | 101,021 |
| Middle East | 99,508 |
| Europe | 89,299 |
| Africa | 82,578 |

The same page has labelling inconsistencies.

### Employees need less manual work, not another platform

The workforce is ageing and wary of new tools. GETI 2026 found [Verified] ([World Oil](https://worldoil.com/news/2026/2/4/oil-and-gas-hiring-challenges-deepen-as-workforce-ages-and-mobility-falls-geti-reports/)):

- **48% of the traditional-energy workforce is aged 45 or over**, and only 19% is 25–34;
- only about a third of hiring managers actively recruit graduates;
- willingness to relocate fell to 75%;
- about 45% use AI at work.

In GETI 2025, support for employers adopting automation and digital tools *fell* four points to 21% [Verified] ([JPT](https://jpt.spe.org/report-finds-upstream-salaries-on-the-rise-along-with-renewed-workforce-pressures)). Training is thin: fewer than a third of EY's respondents actively retrain staff, and 82% of executives think reskilling costs outweigh the benefits ([EY](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/campaigns/energy-resources/documents/ey-ogc-future-of-energy-external-report.pdf)). Deloitte expects 39% of workers' core skills to change by 2030, with entry-level knowledge work most disrupted ([EWTC](https://energyworkforce.org/people-culture-committee-addresses-ai-workforce-impacts/)). Job insecurity sits on top of this: 55% of OEUK member firms cut headcount, and the UK has lost an estimated 25,000 oil and gas jobs since the last general election ([World Oil](https://www.worldoil.com/news/2026/9/22/north-sea-oil-and-gas-decline-threatens-115-000-job-workforce-report-says/)).

Taken together, the product should promise *fewer handoffs and less manual re-keying*, not "a new platform". It should embed know-how in guided templates for teams that learn on the job, and install without licence approvals [Inference].

## A free registered download still triggers privacy, export and sanctions law

Name, email and country are personal data under every regime reviewed, and several reach foreign distributors of free software:

| Jurisdiction | What applies | Source |
|---|---|---|
| EU (GDPR) | Covers non-EU controllers offering services to people in the EU "irrespective of whether a payment… is required" (Art. 3(2)(a)). Requires a written EU representative unless processing is occasional and low-risk (Art. 27). | [Verified] ([GDPR Art. 3](https://gdpr-info.eu/art-3-gdpr/); [GDPR Art. 27](https://gdpr-info.eu/art-27-gdpr/)) |
| Nigeria (NDPA/GAID) | Extraterritorial. Registration as a controller "of major importance" starts at **200 data subjects in six months**. Fines up to 2% of revenue or N10m. | [Verified] ([DLA Piper](https://www.dlapiperdataprotection.com/index.html?t=law&c=NG)) |
| India (DPDP Act) | Notice and consent duties apply from 13 May 2027. | ([Hogan Lovells](https://www.hlc.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-)) |
| Saudi Arabia (draft) | Would add registration for controllers transferring data abroad, plus 72-hour breach notice. | ([Clyde & Co](https://www.clydeco.com/en/insights/2026/10/sdaia-publishes-draft-amendments-to-the-pdpl)) |
| California (CCPA) | Applies only above thresholds (US$25m revenue, 100,000 consumers, or 50% of revenue from selling data), which a small free distributor likely falls below. | ([California AG](https://oag.ca.gov/privacy/ccpa)) |

Practical steps [Inference]:

- Collect only the three fields, plus an optional organisation type for segment sizing.
- Publish a privacy notice and keep marketing opt-in separate.
- Use a processor with a data processing agreement and standard contractual clauses.
- Keep a 72-hour breach plan, since GDPR, Nigeria, Qatar and the Saudi draft all set that clock.

Where the distributor is legally established decides the baseline regime and needs counsel.

Export controls are light if the tool is genuinely open source. BIS treats publicly available encryption source code, and object code whose source is public, as outside the US Export Administration Regulations once an email notice under 15 CFR 742.15(b) is sent [Verified] ([BIS](https://www.bis.gov/learn-support/encryption-controls/encryption-items-not-subject-to-ear)).

Sanctions are the sharper risk:

- OFAC runs 36 programmes ([OFAC](https://ofac.treasury.gov/sanctions-programs-and-country-information)).
- The EU's 16th package (February 2025) added **oil and gas exploration software** to its ban on supplying Russia [Reported] ([Estonian Tax and Customs Board](https://emta.ee/en/news/eu-adopts-16th-package-sanctions-against-russia-and-belarus)).
- UK rules from April 2025 restrict oil and gas exploration, production, reservoir-simulation and drilling software, including SaaS, for Russia [Reported] ([Covington](https://www.cov.com/en/news-and-insights/insights/2025/04/new-uk-sanctions-targeting-russia)).

The country field should block registrations from comprehensively sanctioned jurisdictions and from Russia and Belarus. Any paid support tier should add screening against denied-party lists, because public availability does not clear sanctions exposure for services [Inference].

The "all data stays local" claim is only a differentiator if it is true and checkable. That means [Inference]:

- no telemetry;
- registration kept separate from the application;
- an air-gapped installer;
- public source code as the evidence.

## Aviation safety plus drones and GIS is a rare credibility bridge

The product will not erase hiring gates, so it should prove domain fluency instead. Operator postings demand years inside the industry: 8 years for a senior data analyst, and 5 years each of helicopter flying or maintenance, aviation SMS and oil and gas for Repsol's aviation advisor ([Altea Energy](https://altea-energy.com/jobs/aviation-advisor/)). No evidence was found that GitHub portfolios lead to oil and gas hires. A credible, standards-literate tool therefore works as *supporting evidence*, alongside professional-body activity [Inference].

The strongest positioning is where the product owner's skills meet in the work itself:

- **Methane reconciliation.** Drones carried out six of Petrobras's eight Level 5 pilot campaigns ([EDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)). Plume-to-asset attribution is a GIS problem. OGMP's sampling and uncertainty rules read like an aviation safety audit protocol [Inference].
- **Aviation and RPAS assurance.** Oil and gas has formal aviation-risk structures that hire safety specialists: IOGP's OGARP Reports 690/691, Report 691 opening with an SMS module ([IOGP](https://www.iogp.org/blog/news/latest-addition-to-iogps-oil-and-gas-aviation-recommended-practices-ogarp-series-published/)); Flight Safety Foundation's BARS standards ([SKYbrary](https://skybrary.aero/articles/basic-aviation-risk-standard-bars)); and freelance RPAS safety-auditor roles that want BVLOS experience and RPAS-specific SMS knowledge ([AEROTHRIVE](https://aerothrive.com/oil-and-gas-rpas-auditors-vacancy/)).
- **Crew resource management.** IOGP Reports 501/502 brought aviation CRM into well operations ([IOGP](https://www.iogp.org/blog/oil-and-gas-safety/crew-resource-management-can-be-standard-industry-practice/)).

Gaps to close, where not already covered, are NEBOSH/IOSH, BOSIET/HUET, process-safety vocabulary (HAZOP, barriers, management of change) and asset familiarisation. Rigzone estimates the transition at three to six months ([Rigzone](https://www.rigzone.com/insights/career-advice-4/how-to-transition-into-an-hse-officer-role-in-oil-and-gas-613)). Contractor-side roles are the quickest bridges [Inference]:

- drone inspection firms
- BARS, IOGP and RPAS auditors
- emissions-measurement service companies

For a sole author, five data areas are too much to build at once. A sequenced plan fits better [Inference]:

1. **Core engine.** A DuckDB-class import-validate-filter-export engine for 10 GB+ CSV and Parquet (area 6).
2. **Flagship.** Offline OGMP-style methane reconciliation with GIS attribution (area 9), using pyELQ under its permissive licence and not shipping UNEP's non-commercial models.
3. **Quick win.** A LAS/DLIS/P7 validator with UK NDR and NOPTA profiles (area 7) and coordinate-system-audited LAZ/GeoTIFF packaging (area 8).
4. **Later.** LNG recalculation (area 10), ideally reviewed with a measurement specialist because errors carry fiscal weight.

An optional module on aviation and drone operations analytics (helicopter contractor KPIs against OGARP/BARS, RPAS inspection data, HSE leading indicators) would sit squarely on the aviation-to-energy bridge, where few data people have domain knowledge [Inference].

Credibility comes from conformance and visibility [Inference]:

- State the standard editions supported: LAS 2.0/3.0, DLIS RP66, WITSML 1.4.1.1/2.1, IOGP P7/17, PODS 7, ISO 6976:2016 and ISO 10976:2023, and the OGMP templates.
- Interoperate with Spotfire, Power BI, SQL and Databricks rather than replacing them.
- Publish reproducible validations on open datasets: Volve, NOPIMS, NLOG, EMIT and Carbon Mapper.

Visibility channels include SPE's Data Science and Engineering Analytics community, which runs a "Python for Petroleum Data Analytics" course ([SPE](https://www.spe.org/en/training/courses/python-for-petroleum-data-analytics/)), Software Underground's free TRANSFORM event ([TRANSFORM](https://transform.softwareunderground.org/overview)), and HeliOffshore and Flight Safety Foundation forums. ADIPEC drew a reported 239,709 attendees in 2025 and runs **2–5 November 2026**, two weeks after this report [Reported, organiser figures] ([WAM](https://www.wam.ae/en/article/bmkc68q-adipec-2025-sets-record-with-over-70000-visitors)). The most effective framing is "17 years of safety-critical aviation data and SMS applied to oil and gas problems", not a generic data-science portfolio [Inference]. Registration data, handled minimally, doubles as evidence of reach by country and organisation type [Inference].

## Several headline 2026 claims need checking before reuse

The research notes contain major 2026 events that rest partly on search-result excerpts or blocked pages. They are summarised here so they are not repeated as settled fact.

| Claim | What the notes report | Evidence quality | Conflict or caveat |
|---|---|---|---|
| Strait of Hormuz closure | De facto closure from late February/early March 2026 removed close to 20% of global LNG supply ([EIA](https://www.eia.gov/todayinenergy/detail.php?id=67564); [Shell](https://www.shell.com/what-we-do/oil-and-natural-gas/liquefied-natural-gas-lng/lng-outlook-2026.html)) | EIA and Shell read; IEA pages (including a mid-June US–Iran interim framework) seen only as excerpts ([IEA](https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary)) | Reopening timeline and current status unverified |
| Ras Laffan damage and force majeure | Offline from 2 March after a drone attack; force majeure declared ([Argus](https://www.argusmedia.com/en/news-and-insights/latest-market-news/2795563-qatarenergy-issues-force-majeure-to-some-lng-buyers)); two trains affected ([Fast Company ME](https://fastcompanyme.com/news/global-energy-investment-set-to-reach-record-3-4-trillion-in-2026/)) | Read | "Repairs up to five years, 17% capacity offline" is excerpt-only ([AGBI](https://www.agbi.com/trade/2026/08/japan-and-lng-biggest-victims-of-hormuz-trade-disruption/)); July force-majeure extension with Edison conflicts with August loading reports ([gasworld](https://www.gasworld.com/story/qatarenergy-extends-force-majeure-with-edison/2253616.article/)) |
| Wider war damage | More than 30 Middle East energy facilities damaged and about 20 tankers struck (IEA WEI 2026 coverage) | Secondary coverage read ([Fast Company ME](https://fastcompanyme.com/news/global-energy-investment-set-to-reach-record-3-4-trillion-in-2026/)) | No primary IEA text read in full |
| EU methane delay | Commission proposal to delay importer rules by one year | EC page, Linklaters, Eunews read ([Eunews](https://www.eunews.it/en/2026/10/14/methane-commission-proposes-a-one-year-delay-to-import-rules/)) | Dated 13 or 14 October; new deadline January 2028 versus 31 May 2029; proposal only; operator effect unclear |
| EU penalty grace | Member States asked to refrain temporarily from penalties; "three-year grace" headline | EC page read; HSF Kramer blocked ([HSF Kramer](https://www.hsfkramer.com/insights/2026-08/eu-methan-regulation-eu-commission-clarifies-compliance-options-and-recommends-three-year-penalty-grace-period)) | Scope from excerpt only |
| Schneider–Cognite | US$3.1bn, agreed 30 June 2026 | Verified, multiple outlets | Regulatory approval pending |
| SLB–S&P upstream software | Agreed April 2026 | Press pages cited; summary-level | Closing late 2026 to early 2027; terms undisclosed |
| US endangerment finding | Repeal finalised February 2026 | Secondary only ([Onterris](https://www.onterris.com/our-thinking/federal-methane-rules-in-2026-what-oil-and-gas-operators-need-to-do-now)) | Litigation status unknown |
| Subpart W suspension | Proposed; not final as of 15 September 2026 | Deadline verified | Status after 22 September not checked |
| FAA Part 108 | Under OIRA review since 10 July 2026 | Drone-industry blogs | Unknown after early September |
| Saudi data localisation | Draft Article 23 | Read | Consultation ends 5 November 2026 |
| OGMP size | 163 members and 43% (October 2026) versus 153 and 42% (December 2025) | Both read | Growth, not error |

Other figures in the notes conflict and should not be cited without saying so:

| Topic | Conflicting values | Sources |
|---|---|---|
| 2025 LNG trade | 428 Mt (GIIGNL), 437 Mt (IGU), 422 Mt (Shell) | Report bases differ |
| LNG fleet | 899 vessels (GIIGNL) versus 804 active units (IGU) | Definitions differ |
| 2025 Asian LNG imports | Down 11 Mt (GIIGNL) versus Asia-Pacific up 3.6 Mt (IGU) | Region definitions likely differ |
| Drone inspection market | North America leads (GMI) versus Asia-Pacific leads (Market Intelo) | Above |
| African upstream investment | US$37bn versus US$40bn for 2025 | Above |
| Deloitte AI share of IT spend | 23% versus "less than 20%" | Above |
| EU Methane Regulation details | Entry into force 4 or 5 August 2024; repair deadlines of 5/30 days (article text) versus "5 or 15 working days" (Commission page); existing-site venting ban 5 February 2026 versus 5 August 2026 | ([European Commission](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en); [Reed Smith](https://www.reedsmith.com/articles/eu-methane-regulation-application-lng-coal-mine-operators-importers/)) |
| India DPDP cross-border rules | November 2025 versus May 2027 | ([Mondaq](https://www.mondaq.com/india/privacy-protection/1708830/dpdp-act-compliance-mandate)) |
| UAE PDPL executive regulations | Pending versus issued in 2023 | Weak source for the latter |
| Saudisation 30% engineering quota | Effective 31 December 2025 versus 30 June 2026 | ([Gulf Business](https://gulfbusiness.com/saudisation-rates-raised-in-these-2-professions/)) |
| Golden Pass | 9th versus 10th US export terminal | ([EIA](https://www.eia.gov/todayinenergy/detail.php?id=67564)) |
| MARS alert counts | More than 5,000 (34 countries) versus more than 3,500 (33 countries) | Different dates |

## Remaining research gaps

| Gap | Why it matters | Next step |
|---|---|---|
| No direct survey of demand for offline or air-gapped oil and gas tools, or willingness to pay | The core thesis rests on inference | Interview 15–20 practitioners across the best-fit segments; track registration analytics |
| No global headcount of petroleum, production, GIS, HSE and emissions staff | Bottom-up sizing is impossible without it | Use SPE, IOGP and Energy Institute membership data and national labour statistics |
| No practitioner-forum evidence (Reddit, LinkedIn, Eng-Tips) | Pain points come mostly from vendors and consultancies | Targeted forum and LinkedIn review |
| No pricing for methane SaaS; Baker Hughes, Honeywell, Microsoft and AWS emissions offerings not reviewed | Competitive gaps may be overstated | Vendor demos and procurement contacts |
| EU draft reporting template contents not reviewed; EU Methane Regulation text not checked on EUR-Lex; OGMP reconciliation guidance revision status unknown | Export formats depend on these | Read the 9 October 2026 draft and the Official Journal text |
| Middle East, India, Brazil, Canada and US offshore data-repository format rules not retrieved | Regulator profiles beyond the UK and Australia are unspecified | Collect official submission specifications |
| No typical DLIS, drone-corridor or methane-campaign file sizes | The 10 GB+ claim is indirect for these areas | Gather sample datasets |
| ADNOC, Aramco, QatarEnergy and Australian methane rules not researched; Gulf, UK and Saudi drone licensing for methane surveys not sourced | Gaps in regional regulatory picture | Follow-up regulatory scan |
| OFAC comprehensive-embargo list, Syria's 2025 status, free-software exemptions and China PIPL registration rules unverified | Distribution compliance | Legal counsel |
| No salary data for data, GIS, drone or emissions roles by region; no evidence that open-source portfolios aid hiring | Career planning for the product owner | Hays and Brunel guides; recruiter conversations |
| Unverified items: GIIGNL 7th edition, EU Russian-LNG proof-of-origin rules, Pavilion's per-cargo GHG statement method, LNG laytime and demurrage practice, US restrictions on DJI drones, NATRF2022 datum timing | Each would add or remove a feature | Targeted primary-source checks |

## Conclusion

The opportunity is less "an oil and gas data platform" than a **trustworthy offline layer between messy files and the cloud systems, regulators and counterparties that consume them**. Enterprise vendors are consolidating and moving upmarket into hosted AI, which leaves behind a large, under-resourced population: contractors, small operators, verifiers, NOC staff under sovereignty rules, decommissioning teams and new LNG importers. For them, verifiable local processing is a requirement, not a preference. Methane reconciliation is where this matters most. Measured emissions routinely double or triple inventories, the governing guidance specifies no schema or test, every commercial tool is hosted, and regulators are about to demand independent verification that most verifiers cannot yet perform. A transparent, versioned, offline reconciliation engine would be used, and it would be scrutinised.

For the product owner, the product's value is professional before it is commercial. The 2026 regulatory delays buy roughly a year in which methods, templates and verifier practice are still being set, and that is the window to become known for rigour. Turning aviation's audit discipline (traceability, independence, documented uncertainty) into a methane-and-geospatial tool that shows its working would be a rare and memorable credential in an industry that hires on proven domain judgement. The main risks are spreading a solo build across five domains and making claims, offline or fiscal, that a sceptical security or measurement team could disprove.
