# Oil & Gas Operational/Production Data Management and Workflow Automation (state as of Oct 2026)

Scope note: research done 19 Oct 2026. Labels used below: **[Verified]** = primary or reputable source; **[Vendor]** = vendor or vendor-commissioned (likely biased); **[Estimate]** = market-research or third-party estimate with unclear or unpublished methodology; **[Dated]** = older than 2024, used as background only. A few pages (S&P Global/451 Research, Cognite BusinessWire release, ScienceDirect "Reluctant Cloud" paper) blocked full-text fetch, so those figures come from search-result abstracts and are flagged.

---

## 1. Typical data sources, formats and volumes (historians, SCADA, DPRs, well tests, allocation, CMMS)

### Takeaway
Operational data in oil & gas sits in a layered, fragmented stack: real-time historians (AVEVA PI dominant; Honeywell PHD and AspenTech IP.21 strong downstream), SCADA/DCS kept on-prem or at the edge, production accounting/allocation on SQL Server back ends (Quorum Energy Components, P2, Enertia, Peloton), and a large amount of Excel/CSV glue (morning reports, reconciliations, exports). Raw volumes are large (1-second tags = 86,400 points/tag/day; offshore platforms cited at 1–2 TB/day, though that figure is old), but what engineers actually handle is usually exported CSV/Excel extracts, which run into Excel's 1,048,576-row limit.

### Cited Findings
**Historians**
- AVEVA bought OSIsoft (PI System) in 2021 for $5B. A Mar 2026 practitioner guide says about 85% of top O&G companies use PI. PI has 225+ protocol connectors (OPC-UA/DA, Modbus, MQTT), lossy "swinging door" compression that cuts storage by 90%+, and store-and-forward buffering. A 1-second tag produces 86,400 points/day, which compresses to "a few hundred points". PI's query layer (PI SQL / Asset Framework) "is not SQL", and its tag model maps poorly to BI tools — [Petropt/Groundwork Analytics, Mar 2026](https://petropt.com/articles/og-databases-historians-guide/) [consultancy blog; the 85% figure is not traced to a primary source]
- Same guide: Honeywell PHD is the second most common energy historian, strongest in downstream refining and chemicals; upstream use is mainly at gas plants and offshore platforms running Experion PKS. AspenTech IP.21 sits in a similar niche. PHD and IP.21 are said to lack PI's integration breadth. Newer options: Inmation (cloud-native), Canary Labs and dataPARC (gaining with mid-size operators), and InfluxDB/TimescaleDB as open-source time-series stores — [Petropt, Mar 2026](https://petropt.com/articles/og-databases-historians-guide/)
- Ownership changes: Emerson completed its buyout of AspenTech (IP.21 owner) on 12 Mar 2025 at $265/share, and AspenTech is now a wholly owned subsidiary — [Emerson press release, Mar 2025](https://www.emerson.com/en-us/news/2025/emerson-completes-acquisition-of-remaining-outstanding-shares-of-aspentech) [Verified]
- PI licensing is per tag (perpetual or subscription). One unverified blog says a 5,000-tag deployment starts in the "high five figures USD" for archive + AF, with full stacks reaching six figures, and that per-tag pricing penalizes high-I/O projects (20k+ I/O) — [IndustrialMonitorDirect blog](https://industrialmonitordirect.com/de/blogs/knowledgebase/industrial-historian-comparison-pi-aveva-ignition-influxdb) [weak, unverified]. The Petropt guide says PI's main cost is configuration effort, not licensing — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)

**Exports and time handling**
- PI Data Archive stores timestamps in UTC, and clients such as PI DataLink convert to local time. Excel's 1,048,576-row limit applies to large pulls, and guides recommend chunking long exports or using PI Web API / AF SDK for large-scale extraction — [PISharp: Export PI Archive to CSV](https://www.pisharp.com/article/716/export-pi-archive-data-to-csv-tools-methods); [PISharp: PI Vision to Excel/CSV](https://www.pisharp.com/article/264/exporting-pi-vision-data-to-excelcsv-a-comprehensive-guide) [unofficial blog]

**Production databases and accounting/allocation**
- PHDWin (S&P Global) uses a proprietary format, so exports are usually CSV/Excel and its APIs are rarely used. Aries (Halliburton) has a SQL Server back end. SLB OFM connects to PI, SQL Server and flat files; it is being moved into Delfi, but the desktop version is still widely used. Production accounting (Quorum, P2, Enertia) generally runs on SQL Server and is pulled out by replication or ETL. Operators often reconcile PI sensor data against production-accounting numbers that do not match — [Petropt, Mar 2026](https://petropt.com/articles/og-databases-historians-guide/)
- Quorum Energy Components (hydrocarbon accounting and production allocation) was described in Jan 2023 as deployed at 100+ customers in 55 countries, supporting more than 40% of global hydrocarbon production — [Quorum press release, 2023](https://www.quorumsoftware.com/about/press-releases/quorum-software-announces-significant-momentum-for-energy-components-hydrocarbon-management-solution/) [Vendor, Dated]. Modules include ownership, cost and revenue allocation, inventory valuation, royalty/PSA and invoicing — [Quorum EC Upstream](https://www.quorumsoftware.com/solutions/energy-components-upstream/) [Vendor]
- Peloton is described as a production data management system covering volumes, equipment performance and allocation — [Crunchbase](https://www.crunchbase.com/organization/peloton-computer-enterprises). A 2026 roundup groups Peloton, PakEnergy, Enertia and Quorum as enterprise suites that bundle production with accounting, land and sometimes reserves — [Greasebook blog, 2026](https://www.greasebook.com/blog/oil-and-gas-production-software/) [vendor-adjacent listicle]

**Daily production reports (DPRs) and Excel**
- A typical mid-size stack includes a "manual morning report via email" step, with Spotfire and Excel for analysis. Small operators run production data in Excel and possibly Access. The guide recommends automating the morning report first, because it touches SCADA, volumes, artificial lift and field-ops data — [Petropt, Mar 2026](https://petropt.com/articles/og-databases-historians-guide/)
- Cloud SCADA options include Quorum zdSCADA and eLynx (about $10/asset/month). Small operators may still rely on "basic SCADA or manual gauging". Host SCADA, DCS and safety systems stay on-prem or at the edge — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)

**Well tests**
- An automated workflow schedules and validates steady-state well tests across 2,300+ ExxonMobil Permian wells. These tests feed regulatory reporting, volume allocation and well-work identification — [SPE-230051, ADIPEC 2025](https://onepetro.org/SPEADIP/proceedings-abstract/25ADIP/25ADIP/D021S043R005/793018) [Verified]
- A 2026 SPE paper describes digital well-test control in which results flow to a reporting dashboard and to the production validation/allocation system at the same time, "eliminating manual data entry" — which implies manual entry is still the baseline elsewhere — [SPE 2026, OnePetro](https://onepetro.org/SPEOGWA/proceedings-abstract/26OPES/26OPES/D021S022R002/799157)

**Volumes**
- An offshore platform's process equipment is cited at 1–2 TB/day, with per-well potential up to about 10 TB/day. Satellite links of 64 kbps–2 Mbps would take more than 12 days to move one day's data, which drives edge processing — [Cisco energy blog](https://blogs.cisco.com/energy/foggy-weather-is-coming-to-a-place-near-you-with-analytics-at-the-edge); [DHL "Big Energy Meets Big Data"](https://www.dhl.com/content/dam/dhl/global/dhl-supply-chain/documents/pdf/SC_EN%20&%20Chem_Article_Big%20Energy%20Meets%20Big%20Data_EN.pdf) [Dated, ~2015–2019; widely repeated, not a measured 2025 figure]
- An oil rig can have up to 30,000 sensors, and only about 1% of the data is examined — [McKinsey "Why oil and gas companies must act on analytics"](https://www.mckinsey.com.br/~/media/McKinsey/Industries/Oil%20and%20Gas/Our%20Insights/Why%20oil%20and%20gas%20companies%20must%20act%20on%20analytics/Why-oil-and-gas-companies-must-act-on-analytics.pdf); CNBC's version: less than 1% made available to decision-makers — [CNBC, 2015](https://www.cnbc.com/2015/03/05/us-energy-industry-collects-a-lot-of-operational-data-but-doesnt-use-it.html) [Dated 2015; still widely cited]

**Annual IT/digital budgets by operator size** (consultancy estimate): supermajors $100M–$1B+; large independents $20M–$100M; mid-size $5M–$20M; small operators (100–500 wells) $100K–$2M. A small-operator upgrade can run under $50K/yr using free PostgreSQL, Power BI, eLynx and Enverus — [Petropt](https://petropt.com/articles/og-databases-historians-guide/) [Estimate]

### Inferences
- Raw high-frequency historian archives (multi-TB) are rarely handled directly by engineers. What lands on their desktop is CSV/Excel extracts from PI DataLink, PI Web API, SCADA and accounting systems. A year of 1-second data for a few hundred tags, or multi-year, multi-well SCADA exports, easily goes past Excel's row limit and into the 1–10+ GB CSV range. This is the gap a desktop workbench would target.
- Mid-size and small operators (Excel/Access, manual morning reports, budgets of $100K–$20M) look most underserved by enterprise platforms priced in the six to seven figures.
- Allocation and production accounting (SQL Server) and historians (PI) are separate systems of record that "do not match". Reconciling them is a recurring desktop task suited to import → check → join → export tooling.

### Gaps
- No authoritative 2025–2026 figures on typical tag counts per site (refinery, offshore platform, onshore field) or on typical export file sizes. The only tag/price figures come from a weak blog.
- No dataset on CMMS exports (SAP PM, IBM Maximo) in O&G specifically. No sources on Honeywell PHD/IP.21 export formats were found.
- No current market-share data for P2, Peloton, Enertia or Quorum. The 40%-of-global-production claim for Energy Components is a 2023 vendor statement.

---

## 2. Time engineers spend finding, cleaning and formatting data

### Takeaway
The often-quoted "50–80% of time on data wrangling" claims for O&G engineers rest on old or second-hand sources (AAPG range 30–70%; "over half" per a Brule report cited in a 2018 paper). No rigorous 2025–2026 O&G-specific time-use survey was found. Recent surveys instead measure data readiness and pilot failure, which point the same way.

### Cited Findings
- 30%–70% of a geoscience interpreter's time is spent finding, translating and cleaning data. The author also said he wanted to survey companies, implying no formal survey existed — [AAPG Explorer, "Managing Data or Finding Oil?"](https://www.aapg.org/news-and-media/explorer/managing-data-or-finding-oil/) [Dated]
- Petroleum engineers and geoscientists spend "over half" their time searching for and assembling data (Brule report, cited in) — [ScienceDirect, "Big Data analytics in oil and gas industry", 2018](https://www.sciencedirect.com/science/article/pii/S2405656118301421) [Dated, secondary]
- The generic "data scientists spend 80% of time cleaning data" claim is weakly sourced. A 2019 Figure Eight survey found 73.5% of data scientists spend 25% or more of their time managing, cleaning or labeling data — [Leigh Dodds analysis, 2020](https://blog.ldodds.com/2020/01/31/do-data-scientists-spend-80-of-their-time-cleaning-data-turns-out-no/) [useful debunk]
- Data cleaning and preparation can take up to 50% of a data scientist's time — [Ovation Data guide, 2024](https://ovationdata.com/wp-content/uploads/2024/10/ovation-data-ultimate-guide-data-cleaning.pdf) [Vendor: Ovation sells data management services]
- Recent proxy measures:
  - 72% of asset-intensive companies said managing data was a top challenge to scaling data and analytics. Only 2% reported "material and sustainable benefits" — [McKinsey survey via Oil IT Journal, 2020](https://oilit.com/HTML_Articles/2020_6_13.php) [Dated]
  - Nearly two-thirds of O&G leaders cite the inability to execute a sustainable data and technology strategy as the biggest barrier for tax and finance functions. More than 90% rank data, AI and technology as top priorities — [EY 2025 Tax & Finance Ops Survey (O&G)](https://www.ey.com/en_us/insights/oil-gas/ai-data-strategy-for-oil-and-gas-tax-transformation) [Verified; finance functions, not field engineers]
  - Cross-industry: 72% of 500+ US leaders say they lack unified, accessible data, and 70% don't feel they can trust and govern agents — [Deloitte press release](https://www.deloitte.com/us/en/about/press-room/deloitte-survey-examines-ai-readiness-agentic-ai-success.html). Only 7% of companies are "data reinventors" ready to scale advanced AI — [Accenture](https://www.accenture.com/en/insights/ai-data/ai-ready-data) [cross-industry, not O&G]
- An Aug 2026 JPT article by an ADNOC Offshore reservoir engineer says production deployment must handle "incomplete and messy real-world data" from seismic, logs, SCADA, drilling and maintenance records "never built to talk to one another". It does not quantify prep time — [JPT/TWA, Aug 2026](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)
- A vendor case: Aker BP says Cognite Atlas AI agents cut engineers' time on root-cause analysis by more than 70% — [BusinessWire, Sep 2025](https://www.businesswire.com/news/home/20250903134233/en/Aker-BP-Leverages-Cognite-Atlas-AI-to-Pioneer-an-AI-First-Future-in-Exploration-and-Production) [Vendor/customer PR]

### Inferences
- For a market study, "engineers spend roughly 30–70% of analytical time on data finding and preparation" is defensible only as a widely cited industry estimate, with the AAPG and Brule sources and their age stated. It should not be presented as a measured 2025 statistic.
- The repeated finding that data, not models, is the barrier to scaling AI (McKinsey, EY, Deloitte, JPT) supports demand for data-preparation tooling regardless of the exact percentage.

### Gaps
- No 2024–2026 SPE, McKinsey, BCG or EY survey quantifying hours per week that production or facilities engineers spend on data prep was found.
- A claim attributed to Equinor's CIO ("80% of employee time spent looking through unstructured data") appears in vendor material but could not be traced to a primary source.
- No Reddit, Eng-Tips or practitioner-forum threads were retrievable (searches returned no forum results), so first-hand complaints are under-represented.

---

## 3. Data quality problems (gaps, frozen sensors, spikes, units, timestamps, re-keying)

### Takeaway
The main issues are well documented, though mostly in practitioner and vendor literature rather than recent peer-reviewed surveys:
- SCADA/RTU comms loss causing gaps and flatlines
- spikes from sensor or power faults
- historian compression or deadband hiding real events
- calculated or filtered tags mistaken for raw signals
- DST/time-zone shifts in exports
- PI-versus-accounting mismatches
- manual entry of well tests and morning reports

### Cited Findings
- Missing data is common in real-time O&G operations, mostly from lost connections between SCADA and RTUs at harsh well sites. A frozen value or flat line signals lost signal. Spikes (values outside meter tolerance) often come from sensor errors or power interruptions, and can be told apart from real sluggish-well behaviour by their frequency — [Greasebook on Medium](https://medium.com/@marleerosegreasebook/enhancing-data-quality-for-oil-and-gas-monitoring-systems-e795eb246597) [Vendor blog]
- Analysts should check whether a historian tag is raw or a calculated value with filtering, clipping or splicing applied — [arXiv 2211.06440, "Data Quality Over Quantity: Pitfalls and Guidelines for Process Analytics"](https://arxiv.org/pdf/2211.06440) [Verified, academic]
- PI's lossy compression can discard the high-frequency detail ML models need — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)
- DST: a PI DataLink user found 8-hour shift queries shifted by an hour on the 23-hour DST day. Community replies say there is "no easy solution for dealing with DST" and recommend switching DataLink to UTC (available since DataLink 2014 SP1) — [AVEVA PI Square community thread](https://community.aveva.com/pi-square-community/f/pi-system-onboarding-hub/87407/the-dst-change-effected-the-time-range-on-my-data-data-retrieval-on-pi-datalink-is-there-a-work-around-for-this) [Verified user report, older thread]
- Operators reconcile PI sensor data against production-accounting numbers that don't match, and spreadsheet reconciliation is the current state for most operators — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)
- Well-test quality: an SPE paper quantifies well-test uncertainty (Process Capability Index plus Monte Carlo) and carries it into back-allocation factors and reserves — [SPE-103319, 2006](https://onepetro.org/SPEATCE/proceedings-abstract/06ATCE/All-06ATCE/SPE-103319-MS/140230) [Dated]. BPX Alaska used repeatability statistics across 50+ test facilities and filtered outliers caused by operational changes, noting that well-test quality drives allocation, workovers and capital decisions — [SPE 2016 WRM](https://onepetro.org/SPEWRM/proceedings-abstract/16WRM/All-16WRM/188169)
- Poor allocation hurts reservoir simulation, drawdown strategy and infill planning. A reconciliation framework using measurement uncertainty can detect MPFM/VFM errors — [arXiv 2404.06328 "Flow Fusion"](https://arxiv.org/pdf/2404.06328)
- Production data analysis pitfalls and diagnostics (data quality, rate/pressure inconsistencies) are a long-standing SPE topic — [SPE 102048 (Anderson et al.)](https://blasingame.engr.tamu.edu/0_TAB_Public/TAB_Publications/SPE_102048_(Anderson)_Production_Data_Analysis_Challenges_Pitfalls_Diagnostics.pdf) [Dated, foundational]
- Manual re-keying: digital well-test control "eliminat[es] manual data entry, and reduc[es] the risk of human error" — [SPE 2026](https://onepetro.org/SPEOGWA/proceedings-abstract/26OPES/26OPES/D021S022R002/799157). Mid-size operators still have a "manual morning report via email" — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)

### Inferences
- A useful QC rule set for an O&G workbench would cover:
  - flatline/stuck-value detection with configurable duration
  - spike/outlier detection (rate-of-change, tolerance bands)
  - gap detection and comms-loss flags
  - raw-versus-calculated tag awareness
  - DST/UTC normalization
  - unit harmonization (bbl/m³, Mscf/Sm³, psi/bar)
  - cross-source reconciliation (historian vs. allocation vs. DPR)
  These map directly onto the documented failure modes.
- Unit inconsistencies (field vs. SI vs. mixed) are almost certainly common, especially in multinational and JV reporting, but no source quantifying them was found.

### Gaps
- No recent quantitative survey of how often these issues occur (for example, % of tags with frozen values).
- No authoritative source found on unit-inconsistency incidents or on Excel-error-driven misstatements in production reporting.

---

## 4. Commercial tools: deployment, pricing, strengths, gaps

### Takeaway
Enterprise platforms (Cognite, SLB Delfi/Lumi, AVEVA CONNECT, Palantir, OSDU-based stacks, Microsoft Fabric) are cloud-first, quote-priced and aimed at large operators. Industrial analytics tools (Seeq, TrendMiner) are moving to SaaS, and Seeq's GenAI assistant is SaaS-only. Desktop analytics (Excel, Spotfire, Alteryx Designer, KNIME desktop, OFM desktop) remain the daily tools.

The vendor landscape consolidated sharply in 2024–2026:
- Emerson bought out AspenTech (Mar 2025)
- Proemion bought TrendMiner (agreed Apr 2024)
- Schneider/AVEVA agreed to buy Cognite for $3.1B (Jun 2026, pending)

### Cited Findings
**Cognite (Data Fusion + Atlas AI)**
- Schneider Electric agreed on 30 Jun 2026 to buy Cognite from Aker ASA and other investors for $3.1B in cash. Cognite will be integrated into AVEVA, and its contextualization/knowledge graph added to AVEVA CONNECT. The deal is subject to regulatory approval — [Bloomberg](https://www.bloomberg.com/news/articles/2026-06-30/schneider-to-buy-industrial-ai-firm-cognite-for-3-1-billion); [ARC Advisory](https://www.arcweb.com/blog/schneider-electric-acquire-cognite-strengthen-industrial-ai-portfolio); [Automation.com](https://www.automation.com/article/schneider-electric-acquire-cognite-unlocking-strategic-intelligence-industrial-ai); [Drives & Controls](https://drivesncontrols.com/schneider-buys-cognite-for-3-1bn-to-strengthen-its-aveva-business/) [Verified]
- Atlas AI major release (Sep 2025): pre-built agents plus a low-code agent workbench on Data Fusion. Named users include Aker BP, ADNOC Offshore, Celanese, Hess, HMH, Idemitsu and Tokuyama — [BusinessWire, 9 Sep 2025](https://www.businesswire.com/news/home/20250909488860/en/Cognite-Atlas-AI-Drives-Customer-Momentum-with-New-Major-Release-Accelerates-Adoption-of-Agentic-AI-to-Unlock-More-Industrial-Value) [Vendor; full text not fetchable, details from abstract]
- TotalEnergies signed a three-year Data Fusion deployment across its upstream value chain — [DCD](https://www.datacenterdynamics.com/en/news/totalenergies-signs-deal-with-cognite-to-deploy-ai-platform-across-upstream-asset-base/)
- Pricing is custom-quote only (AWS Marketplace placeholder) — [AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-pnszk2onnidau)

**Seeq**
- SaaS is the primary deployment model. A small Windows agent on-prem or in private cloud makes an outbound HTTPS link to Seeq Cloud, so no inbound firewall ports are needed. Seeq says it has migrated "dozens" of customers from on-prem to SaaS — [Seeq support: SaaS primary model](https://support.seeq.com/latest/on-premise/seeq-saas-as-the-primary-deployment-model); [Seeq blog "Seeq is SaaS"](https://www.seeq.com/resources/blog/seeq-is-saas/) [Vendor]
- The Seeq AI Assistant (four cooperating agents; Azure OpenAI/OpenAI as alternative LLM providers) is available only to SaaS customers, so on-prem-only customers cannot use it — [Seeq support KB](https://support.seeq.com/kb/R65/on-premise/seeq-ai-assistant) [Vendor documentation, Verified]
- Marathon Oil cut time to build a new well alert "from months to hours" with Seeq on AWS — [Seeq/AWS page](https://www.seeq.com/connectivity-partners/aws/) [Vendor]
- Price: Capterra lists about $1,200/user/year — [Capterra](https://www.capterra.com/p/171687/Seeq/) [Estimate; no official list price]

**TrendMiner**
- Proemion agreed to buy TrendMiner from Software AG (announced Apr 2024) and kept the brand — [Verdantix](https://www.verdantix.com/insights/blogs/proemion-acquires-trendminer-to-complete-its-full-stack-industrial-data-and-analytics-offering); [BusinessWire](https://businesswire.com/news/home/20240417486875/en/Proemion-Holding-GmbH-Agrees-to-Acquire-TrendMiner-NV-to-Expand-Industrial-Asset-Monitoring-and-Analytics-Platform/)
- Subscription pricing based on users and features — [Gartner Peer Insights](https://www.gartner.com/reviews/product/trendminer); [Capterra](https://www.capterra.com/p/181894/TrendMiner/) [no official prices]

**SLB Delfi / Lumi**
- Lumi data and AI platform launched Sep 2024 (SLB Digital Forum). Delfi is to be enhanced using Lumi's data foundations and ML — [Oilfield Technology](https://www.oilfieldtechnology.com/digital-oilfield/18092024/slb-launches-ai-powered-lumi-platform/)
- The Tela agentic assistant queries data, generates analyses and extracts insights from PDFs, reports, log images and spreadsheets — [SLB Lumi Data Workspace brochure](https://www.slb.com/-/media/files/dig/brochure/lumi-data-workspace-brochure.pdf?la=es); [SLB "AI delivered by Lumi"](https://www.slb.com/products-and-services/delivering-digital-at-scale/software/lumi/ai-delivered-by-the-lumi-platform) [Vendor]
- Built with NVIDIA NIM/NeMo — [NVIDIA blog](https://developer.nvidia.com/blog/spotlight-slb-and-nvidia-collaborate-on-gen-ai-solutions-for-energy/)

**Microsoft Fabric / Power BI**
- Copilot in Fabric Real-Time Intelligence translates natural-language questions into KQL and builds dashboard tiles — [Microsoft Learn](https://learn.microsoft.com/en-us/fabric/fundamentals/copilot-fabric-overview). New Copilot features cover natural-language dashboard creation and Eventhouse admin automation — [CIO.com](https://www.cio.com/article/4228492/microsoft-is-pivoting-toward-a-unified-data-and-ai-platform-with-fabric.html)
- No O&G-specific Fabric case study was found.
- Power BI Pro went from $10 to $14/user/month (+40%) and PPU from $20 to $24 on 1 Apr 2025 — [The Register](https://www.theregister.com/2025/04/02/microsoft_power_bi_hikes/); [Microsoft Fabric community blog](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Important-update-to-Microsoft-Power-BI-pricing/ba-p/5174341) [Verified]

**Spotfire**
- Strong in E&P:
  - Spotfire markets itself as chosen by "top 20 energy companies" — [Spotfire blog](https://www.spotfire.com/blog/2024/03/20/why-the-top-20-energy-companies-choose-spotfire/) [Vendor]
  - Occidental uses Spotfire with Python, R, IronPython and JavaScript alongside Databricks — [Spotfire customer story: Oxy](https://www.spotfire.com/customers/oxy) [Vendor]
  - Diamondback's 2025 plans include a Spotfire 14 upgrade, evaluating Spotfire Copilot and Snowflake integration, and new Python libraries — [Spotfire Energy Forum 2025](https://community.spotfire.com/articles/spotfire/spotfire-energy-forum-2025/)

**Alteryx / KNIME**
- Alteryx Designer Desktop is about $5,195/user/year. Designer Cloud is about $4,950/user/year (3-user minimum); another source says $7,195 — [AutomationAtlas](https://automationatlas.io/answers/alteryx-pricing-explained-2026/); [VendorBenchmark](https://vendorbenchmark.com/vendors/alteryx-pricing) [Estimate, aggregator]
- KNIME Analytics Platform (desktop) is free. Business Hub (self-hosted) reportedly starts around €35,000/year — [CheckThat.ai](https://checkthat.ai/brands/knime/pricing) [Estimate]

**Data platforms used by operators**
- Snowflake (ExxonMobil reference); Databricks (Permian Resources, Devon, Shell); SQL Server for production accounting (Devon, Matador). Some operators find AVEVA licensing and support frustrating. PI is often used as a de facto data warehouse, which slows down as users are added — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)

### Inferences
- The flagship AI copilots (Seeq AI Assistant, Cognite Atlas AI, SLB Tela, Fabric Copilot) all depend on cloud or SaaS. Operators with air-gapped or on-prem mandates are therefore locked out of the newest AI features. That opens a gap for offline tools with local, deterministic automation (and possibly local LLMs).
- Consolidation (AVEVA + Cognite under Schneider, AspenTech under Emerson, TrendMiner under Proemion) may cause price increases or roadmap uncertainty, which is often an opening for independent tools. Inference only.
- There is a pricing gap between free (Excel, KNIME desktop, Python) and $1K–$5K+/user/year (Seeq, Alteryx) or enterprise quotes (Cognite, Palantir, Delfi). An offline workbench priced in the low hundreds to low thousands per seat would sit in that gap.

### Gaps
- No public pricing found for Spotfire, Palantir Foundry/AIP, SLB Delfi/Lumi, AVEVA CONNECT or Halliburton Landmark (DecisionSpace 365). Halliburton's 2025–2026 AI announcements were not covered by the searches.
- No structured user-complaint dataset (G2/Gartner review mining) for these tools was gathered.

---

## 5. Open-source tools for time-series QC, production data and workflow automation

### Takeaway
The open-source engines can handle 10 GB+ data on a laptop. DuckDB handles it best, spilling to disk with low memory use; Polars is fast when data fits in RAM; pandas struggles at this scale. However, they need coding skills. Orchestrators (Airflow, Dagster) are built for data engineers, not petroleum engineers. OSDU is an enterprise cloud standard focused on subsurface data, with the production domain lagging. Python skills among petroleum engineers are growing but uneven, and education is behind.

### Cited Findings
**DataFrame and SQL engines (10 GB scale)**
- pandas rule of thumb: 5–10x the dataset size in RAM, i.e. about 50–100 GB for 10 GB of data — [Ibis project, "Querying 1TB on a laptop"](https://ibis-project.org/posts/1tbc/)
- With a 5.84 GiB memory cap on 50M rows, pandas failed at load, Polars completed 9/10 queries and DuckDB 10/10 — [Uvik benchmark, 2026](https://uvik.net/blog/polars-vs-pandas/) [blog benchmark]
- On a ~140 GB Parquet dataset, Polars memory rose to about 17 GB while DuckDB peaked near 1.3 GB — [Codecentric](https://codecentric.de/en/knowledge-hub/blog/duckdb-vs-polars-performance-and-memory-with-massive-parquet-data)
- Polars handles 10 GB well when the data fits in memory but can "fail hard" on large joins; it uses an experimental streaming engine — [Coiled TPC-H study](https://docs.coiled.io/blog/tpch); see also [Polars benchmarks 2024](https://pola.rs/posts/benchmarks-2024)
- DuckDB loaded about 20 GB of CSV in roughly 10 seconds on a 12-core laptop with 128 GB RAM — [DuckDB blog, Sep 2025](https://www.duckdb.org/2025/09/08/duckdb-on-the-framework-laptop-13) [Vendor/project, high-spec machine]

**Orchestration**
- Airflow pipelines are hard to develop and test outside production. Dagster is asset-centric but has a smaller community. Airflow has 30M+ downloads per month — [DataCamp Dagster vs Airflow](https://www.datacamp.com/ja/blog/dagster-vs-airflow); [Educative](https://www.educative.io/courses/data-engineering-foundations/np/orchestration-tool-dagster)

**OSDU**
- The platform mainly covers seismic and well data, with production data "to follow" — [TCS white paper](https://www.tcs.com/what-we-do/industries/energy-resources-utilities/white-paper/osdu-data-platform-game-changer-oil-and-gas-industry) [~2024–25]
- The Reservoir DDMS reached preview on Azure in early 2025. Some legacy applications may take years to become OSDU-ready, or never will — [Microsoft Tech Community](https://techcommunity.microsoft.com/blog/azurearchitectureblog/from-osdu-to-ontology-why-oil--gas-ai-readiness-lives-at-the-meaning-layer/4538718)
- The Open Group released OSDU Data Platform Standard v1.0 in Jun 2026 — [IT Brief UK](https://itbrief.co.uk/story/open-group-launches-osdu-data-platform-standard-v1-0). The Dec 2025 Houston Summit recap says operators use the platform in day-to-day workflows — [Open Group blog](https://blog.opengroup.org/2025/12/04/osdu-forum-highlights-from-the-open-group-houston-summit-2025)
- The Production domain was planned around Energistics PRODML (2020-era plan) — [Energistics](https://energistics.org/node/405) [Dated]

**Python skills among petroleum engineers**
- SPE runs courses and webinars on Python as an alternative to Excel for production data wrangling — [SPE Energy Stream course](https://streaming.spe.org/course-data-science-and-analytics-applications-in-petroleum-engineering-a-kick-start-in-python)
- A 2025 SPE Nigeria paper found many petroleum engineering educators lack the skills to teach Python — [SPE NAIC 2025, PyPE_CoP](https://onepetro.org/SPENAIC/proceedings-abstract/25NAIC/25NAIC/D031S016R002/787299)
- A 2026 career guide says "Excel is not going away" in O&G — [Petropt 2026 career guide](https://petropt.com/articles/breaking-into-oil-gas-2026-guide/)
- Training providers sell Python + Spotfire courses (pandas, petropy, welly) — [Petroleum Engineers Association](https://www.peassociations.com/coursedetails/python-for-oil-gas)
- KNIME's desktop platform is free (open core); paid Hub for collaboration and automation — [CheckThat.ai](https://checkthat.ai/brands/knime/pricing)

### Inferences
- A desktop workbench could embed DuckDB (or Polars) as its engine and offer a GUI over it. That gives engineers 10 GB+ performance without writing code, which is the gap between "free but needs coding" (DuckDB, Polars, pandas) and "no-code but expensive" (Alteryx at about $5K/seat).
- Airflow and Dagster need servers, DevOps and Python skills, so they are not realistic for individual production engineers or small operators. Scheduled or batch recipes in a desktop tool are a lighter alternative.
- OSDU is not a competitor for production/operations data at the engineer's desk in 2026. It is enterprise, cloud, subsurface-first infrastructure. A workbench that exports OSDU- or PRODML-compatible formats could still be a selling point for larger operators.

### Gaps
- No O&G-specific sources found on Node-RED or n8n adoption (both open-source flow tools used in IIoT and automation), or on their limitations for engineers.
- No survey quantifying the share of petroleum or production engineers who code in Python.

---

## 6. Market size and growth (digital oilfield, O&G data management, industrial analytics, RPA)

### Takeaway
All market figures come from commercial research firms with opaque, inconsistent definitions, so treat them as order-of-magnitude only:
- **Digital oilfield:** about $31–40B (2025), with most estimates at 5.5–6.5% CAGR to 2030
- **O&G data management:** 2025 estimates range from $4B to $33B depending on scope
- **Industrial AI analytics software (Verdantix, the more credible analyst):** about $3.2B in 2025, growing to about $9.3B by 2031 (20% CAGR)
- **RPA in O&G:** about $1.8B (2025) per one low-reliability source

### Cited Findings
**Digital oilfield** (all [Estimate])
- $37.40B (2024) → $39.65B (2025) → $53.41B (2030), 6.11% CAGR — [Research and Markets, Aug 2025](https://www.researchandmarkets.com/report/digital-oilfield)
- 6.3% CAGR 2025–2030, about $43.05B in 2030 — [MarketsandMarkets](https://www.marketsandmarkets.com/Market-Reports/digital-oilfield-market-904.html)
- $30.78B (2025) → $47.85B (2033), 5.6% CAGR. North America held more than 34% share in 2025 — [Grand View Research](https://www.grandviewresearch.com/industry-analysis/digital-oilfield-market)
- $31.96B (2025) → $44.66B (2030), 7.2% CAGR — [Data Bridge via openPR](https://www.openpr.com/news/4481505/digital-oilfield-market-set-to-surge-at-7-2-cagr-reaching-usd) [press-release distribution, low reliability]
- $32.04B (2026) → $40.28B (2030), 5.9% CAGR — [Research and Markets 2026 edition](https://www.researchandmarkets.com/reports/5790679/digital-oilfield-market-report)
- $38.90B by 2030, 4.5% CAGR — [Next Move Strategy Consulting](https://www.nextmsc.com/report/digital-oilfield-market)
- "Digital oilfield solutions" $58.66B by 2030 — [Yahoo Finance / R&M release](https://finance.yahoo.com/news/digital-oilfield-solutions-industry-report-091300822.html)
- Note: "digital oilfield" totals include hardware (sensors, instrumentation), services and IT; software is only a part.

**O&G data management** (all [Estimate]; scope varies)
- Software: $27.3B (2025) → $136.0B (2035), 17.4% CAGR — [Future Market Insights](https://www.futuremarketinsights.com/reports/oil-and-gas-data-management-software-market) [aggressive outlier]
- Software: $18.45B (2024), about $19.38B (2025), about 5.0% CAGR to 2035 — [Market Research Future](https://www.marketresearchfuture.com/reports/oil-and-gas-data-management-software-market-26684)
- Software: $4.2B (2025) → $10.5B (2033), 12.1% CAGR — [HTF MI](https://www.htfmarketinsights.com/report/4367043-oil-and-gas-data-management-software-market)
- Total market: $28.6B (2025) → $58.4B (2034), 8.3%; software is about 61.2% of the total — [Dataintelo](https://dataintelo.com/report/global-oil-and-gas-data-management-market). A second Dataintelo report: $33.5B (2025) → $74.17B (2034), 9.2% — [Dataintelo](https://dataintelo.com/report/global-oil-gas-data-management-market)
- $26.47B (2025) → $48.85B (2030) — [The Business Research Company](https://www.thebusinessresearchcompany.com/report/oil-and-gas-data-management-global-market-report)
- $8.56B (2025) → $15B (2035) — [Wise Guy Reports](https://www.wiseguyreports.com/reports/oil-and-gas-data-management-market)

**Industrial analytics**
- Industrial AI analytics software: $3.2B (2025) → about $9.3B (2031), 20% CAGR. Growth comes from production optimization and worker efficiency; constraints are data and organizational challenges — [Verdantix](https://www.verdantix.com/venture/report/market-size-and-forecast--industrial-ai-analytics-2025-2031-global) [Analyst firm; more credible, but methodology paywalled]
- Broader "industrial analytics" for 2025 ranges from about $20.6B ([The Insight Partners](https://www.theinsightpartners.com/reports/industrial-analytics-market)) to about $34B ([TBRC via GII](https://www.giiresearch.com/report/tbrc1975764-industrial-analytics-global-market-report.html)). US alone is about $5.8B ([MRFR](https://www.marketresearchfuture.com/reports/us-industrial-analytics-market-15520)). Manufacturing analytics is about $17.8B ([IMARC](https://www.imarcgroup.com/manufacturing-analytics-market)) [Estimate]

**RPA / workflow automation in O&G**
- $1.8B (2025) → $6.4B (2034), 15.2% CAGR; North America leads — [Dataintelo](https://dataintelo.com/report/robotic-process-automation-in-oil-and-gas-market) [low reliability; page marked "upcoming"]
- Global RPA estimates vary from about $6.3B (2025, [IMARC](https://www.imarcgroup.com/global-robotic-process-automation-market)) to much higher figures elsewhere [inconsistent]

**Budget anchors (bottom-up)**
- Annual IT/digital budgets: supermajors $100M–$1B+, mid-size $5M–$20M, small operators $100K–$2M — [Petropt](https://petropt.com/articles/og-databases-historians-guide/) [consultancy estimate]

### Inferences
- For a desktop data-workbench study, top-down figures ($20–50B) greatly overstate the addressable market. A bottom-up sizing (number of production, reservoir, facilities and data engineers and analysts × seat price) would be more defensible. Verdantix's $3.2B industrial AI analytics software figure is the most relevant credible ceiling for the analytics-software slice across all process industries, not just O&G.
- Growth rates for the software-heavy segments (industrial AI analytics about 20%, data management software 5–17%) exceed the overall digital oilfield rate (about 6%), so software and data tooling is the faster-growing part of digital O&G spend.

### Gaps
- No ARC Advisory, Rystad or Wood Mackenzie public figures were found for O&G operations software or data management spend.
- No sizing for "hyperautomation", low-code or agentic automation specific to O&G.
- No estimate found of the global number of petroleum, production or facilities engineers (needed for bottom-up sizing). SPE membership counts could be a proxy but were not retrieved in this session.

---

## 7. Workflow automation trends 2025–2026: AI agents, copilots, low-code, adoption vs hype, security

### Takeaway
Spending and pilots on generative and agentic AI in O&G rose sharply in 2025–2026:
- Gartner: 62% of O&G respondents have deployed AI; about half plan agents within 12–24 months
- Named deployments at Aker BP, ADNOC, TotalEnergies and Devon

Measured value is uneven, though. Commonly cited evidence includes McKinsey's 70% of digital pilots never scaling, MIT NANDA's finding that 95% of GenAI pilots show no P&L impact, and S&P/451 reporting mixed returns. Data readiness, trust and OT cybersecurity are the recurring blockers. Low-code is shifting from "citizen developers" to governed, Copilot-generated apps.

### Cited Findings
**Adoption and intent**
- Gartner (as reported by a consultancy):
  - 62% of O&G respondents have deployed AI, with GenAI deployment at the same level
  - nearly half plan AI-agent deployment within 12–24 months
  - predictions: by 2028, O&G firms using AI agents will improve operational efficiency by more than 10%; by 2028, training AI agents will be in the job description of 40% of frontline staff; within two years, 70% will use process mining to shape agentic AI requirements
  - Sample size and dates were not disclosed
  — [Smartbridge, Apr 2026](https://smartbridge.com/2026-gartner-ai-predictions-oil-and-gas/) [secondary report of Gartner; predictions are not measurements]
- S&P Global / 451 Research (Mar 2026): energy and utilities respondents invested faster in autonomous, agentic capabilities and emphasised use cases with little to no human intervention. Results were "mixed", yet investment plans remain ambitious — [S&P Global Market Intelligence](https://www.spglobal.com/market-intelligence/en/news-insights/research/2026/03/energy-and-utilities-firms-investing-aggressively-in-ai-despite-mixed-returns) [abstract only; full text blocked]
- BMI (Jun 2026): adoption is uneven. Majors and some NOCs lead, smaller independents lag. Devon is cited as reporting more than $250M in 2025 efficiency gains from drilling-focused AI agents and models — [Energy Today](https://www.energytodaymag.com.au/oil-and-gas-majors-surge-ahead-in-ai-usage) [secondary]
- ADNOC and Microsoft (Nov 2025) agreed to co-develop and deploy AI agents across ADNOC's value chain — [OGN News](https://ognnews.com/ArticleOGN/461769/energy-firms-accelerate-ai-partnerships-to-transform-industrial-operations-globally) [secondary]
- Vendor agentic launches: Cognite Atlas AI ([BusinessWire](https://www.businesswire.com/news/home/20250909488860/en/Cognite-Atlas-AI-Drives-Customer-Momentum-with-New-Major-Release-Accelerates-Adoption-of-Agentic-AI-to-Unlock-More-Industrial-Value)); SLB Lumi/Tela ([SLB](https://www.slb.com/products-and-services/delivering-digital-at-scale/software/lumi/ai-delivered-by-the-lumi-platform)); Seeq AI Assistant ([Seeq KB](https://support.seeq.com/kb/R65/on-premise/seeq-ai-assistant)); Fabric Copilot for RTI ([Microsoft Learn](https://learn.microsoft.com/en-us/fabric/fundamentals/copilot-fabric-overview)); Spotfire Copilot under evaluation at Diamondback ([Spotfire Energy Forum 2025](https://community.spotfire.com/articles/spotfire/spotfire-energy-forum-2025/)) [Vendor]

**Hype vs reality**
- McKinsey: 70% of O&G digitization projects have not moved beyond pilot, even though many pilots met their technical goals — [McKinsey "Harnessing volatility" PDF](https://www.mckinsey.com/~/media/mckinsey/business%20functions/operations/our%20insights/harnessing%20volatility%20technology%20transformation%20in%20oil%20and%20gas/harnessing-volatility-technology-transformation-in-oil-and-gas.pdf) [undated PDF; Petropt cites it as 2024]
- MIT NANDA (2025): 95% of GenAI pilots show no measurable P&L impact (300+ deployments, 150+ interviews); only about 1 in 20 AI initiatives escape pilot. EPAM 2025: 54% of energy companies say their workforce lacks GenAI skills, and 40% of staff will need upskilling within 18 months. GETI 2026: 48% of the traditional energy workforce is aged 45+ — all cited in [JPT/TWA, Aug 2026](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)
- In the same article, EY says culture is the most underestimated barrier because engineers distrust models they cannot interrogate. ARC says scaling is a governance and operating-model problem and recommends an "Industrial Data Fabric" — [JPT/TWA, Aug 2026](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)
- EY Future of Energy (Mar 2025): about 85% say reskilling is crucial, but only 29% are currently retraining — [EY report](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/campaigns/energy-resources/documents/ey-ogc-future-of-energy-external-report.pdf)
- Cross-industry, 2026: 87% of data leaders claim AI data readiness, yet 43% cite data readiness as their biggest obstacle — [Precisely/Drexel LeBow 2026](https://www.lebow.drexel.edu/sites/default/files/2026-01/lebow-precisely-state-data-integrity-ai-readiness-2026.pdf) [vendor co-sponsored]

**Low-code and citizen development**
- Microsoft is building Copilot into Power Platform so employees can turn natural-language requests into apps and flows — [Microsoft Inside Track](https://www.microsoft.com/insidetrack/blog/empowerment-with-good-governance-how-our-citizen-developers-get-the-most-out-of-the-microsoft-power-platform/) [Vendor]
- Copilot Managed Runtime (public preview) adds governed hosting and model-family limits so IT can control usage, security and cost — [Moor Insights & Strategy](https://moorinsightsstrategy.com/field-notes/microsofts-new-copilot-and-managed-runtime-rethink-citizen-development/)
- Cognite's Atlas AI includes a low-code agent workbench — [BusinessWire](https://www.businesswire.com/news/home/20250909488860/en/Cognite-Atlas-AI-Drives-Customer-Momentum-with-New-Major-Release-Accelerates-Adoption-of-Agentic-AI-to-Unlock-More-Industrial-Value)

**Security and confidentiality**
- DNV Energy Cyber Priority 2025 (375 energy professionals): 65% rank cybersecurity as leadership's top business risk; 71% feel more exposed to OT-specific cyber events; 57% say OT defences lag IT. Every AI system connected to production data creates a new IT/OT attack surface — cited in [JPT/TWA, Aug 2026](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)
- Tosi survey of 100 US upstream/midstream OT decision-makers (Apr 2026): 87% are confident they could detect an OT breach within 24 hours, but only 16% use continuous OT monitoring as their primary method. The IT/OT divide is the biggest barrier — [PR Newswire via Morningstar, May 2026](https://www.morningstar.com/news/pr-newswire/20260505ln49310/oil-and-gas-operators-are-confident-they-can-detect-a-cyberattack-the-tools-they-are-using-cannot-tosi-reports) [Vendor-commissioned]

### Inferences
- What operators actually adopt in 2025–2026:
  - automated morning and daily reports
  - surveillance and alerting (for example Marathon/Seeq)
  - well-test validation workflows (ExxonMobil)
  - RCA and document-search agents at data-mature operators (Aker BP, ADNOC)

  Hype: fully autonomous agentic operations; most organizations are still in the "planning" stage (Gartner: "nearly half plan").
- Agents and copilots are only as good as the data behind them. The repeated "fix your data first" message gives deterministic, auditable data-prep tooling a role that complements AI rather than being replaced by it, for example as the clean-data feeder for copilots.
- Cyber concern (DNV 65–71%) together with SaaS-only AI features (Seeq) suggests demand for AI-assisted features that run locally (on-device models, no data leaving the machine). This is an inference; no survey directly measures demand for local AI in O&G.

### Gaps
- The BCG figures circulating in vendor blogs (72% support GenAI; 47% redesign workflows for agent-led automation) could not be traced to the primary BCG report.
- No hard data on Copilot (M365/Fabric) seat penetration at operators, or on citizen-developer programmes at named operators (Shell, Chevron, ExxonMobil). Searches returned nothing O&G-specific.
- Halliburton and Landmark agentic/GenAI announcements for 2025–2026 were not covered.

---

## 8. Demand for offline / on-prem / air-gapped tools vs cloud (sovereignty, OT security, connectivity)

### Takeaway
There are strong structural reasons for on-prem and offline capability:
- OT networks segmented per the Purdue model and IEC 62443, with DMZs and data diodes
- documented cloud reluctance in upstream (security, regulation, trust)
- Gulf data-localization requirements
- remote and offshore bandwidth limits

At the same time, LEO satellite (Starlink, OneWeb) is improving offshore connectivity, and majors are moving analytics to Snowflake, Databricks and SaaS. The likely 2026 reality is hybrid: cloud for enterprise analytics, with on-prem and desktop for OT-adjacent, confidential or disconnected work.

### Cited Findings
**Cloud reluctance and security**
- A study of 190 IT professionals and decision-makers in upstream O&G found that security, regulatory uncertainty and a "trust deficit" continue to delay cloud adoption, and describes this reluctance as rational — [ScienceDirect, "Security, Trust, and the Reluctant Cloud in Upstream Oil and Gas" (2026)](https://www.sciencedirect.com/org/science/article/pii/S2156183426000112) [full text blocked; abstract-level]
- 60% of O&G respondents placed OT cybersecurity among their top five business risks — [Fortinet O&G report](https://www.fortinet.com/content/dam/fortinet/assets/reports/report-cybersecurity-oil-and-gas.pdf) [Vendor, Dated]
- DNV 2025: 71% feel more exposed to OT cyber events, and 57% say OT defences lag IT — via [JPT, Aug 2026](https://jpt.spe.org/twa/from-pilot-to-production-understanding-the-challenges-of-scaling-ai-in-oil-and-gas)

**Network architecture**
- Host SCADA, DCS and safety systems stay on-prem or at the edge even in cloud-forward stacks — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)
- Hardware data diodes create an optical air gap for one-way replication of AVEVA PI, eDNA and AVEVA Historian data across segmented networks, targeting oil & gas among others — [Owl Cyber Defense datasheet](https://cdn.mediavalet.com/eunl/content/MysY2PQDB0mIYpOYTai4PA/Gm52lYwThkWLG5ErXOddLA/Original/Owl%20Cyber%20Defense%3A%20Securely%20Replicate%20PI%20System%20Data%20Across%20Segmented%20Networks.pdf) [Vendor]
- Seeq designed its SaaS connector around outbound-only HTTPS specifically to avoid opening inbound firewall ports, which reflects OT network constraints — [Seeq support](https://support.seeq.com/latest/on-premise/seeq-saas-as-the-primary-deployment-model) [Vendor]

**Sovereignty (Middle East)**
- Aramco Digital and Google Cloud's JV serves Saudi companies from in-Kingdom data centres. Aramco signed a non-binding industrial-AI MoU with Microsoft in Feb 2026 — [Invest Riyadh profile](https://investriyadh.ai/entities/saudi-aramco-digital/) [secondary]
- O&G is among MENA sectors that prioritise on-prem control, and Aramco Digital announced domestic AI deployment with local data-processing requirements at LEAP 2025 — [Usetech](https://usetech.com/blog/cloud-on-prem-or-sovereign-ai-the-infrastructure-decisions-defining-menas-future/) [vendor blog]
- Gulf governments want critical digital capabilities under local control — [Computer Weekly](https://www.computerweekly.com/news/366638816/Why-sovereign-and-agentic-AI-will-define-next-phase-of-Middle-Easts-digital-transformation)

**Connectivity**
- Legacy satellite links of 64 kbps–2 Mbps would take more than 12 days to move one day of platform data, which drives edge processing — [Cisco blog](https://blogs.cisco.com/energy/foggy-weather-is-coming-to-a-place-near-you-with-analytics-at-the-edge) [Dated]
- LEO counter-trend:
  - Tampnet's five-year deal (Aug 2025) provides Starlink + OneWeb LEO backhaul for the Island Innovator rig — [Via Satellite](https://www.satellitetoday.com/mobility/2025/08/21/tampnet-wins-5-year-deal-to-provide-managed-connectivity-for-island-drilling-rig/)
  - Seadrill is rolling out Starlink fleet-wide (Jun 2025) — [Seadrill brochure](https://www.seadrill.com/wp-content/uploads/2025/06/Seadrill-Starlink-Brochure.pdf)
  - Shelf Drilling added Starlink as a secondary channel "where regional regulations permit" — [Hellenic Shipping News](https://www.hellenicshippingnews.com/?p=1049341)
  - LEO latency is quoted at about 20–60 ms vs 500–700 ms for GEO VSAT — [Samax](https://www.samax.com/blog/starlink-for-bahrains-oil-gas-sector/) [Vendor]

**Cloud migration by large operators**
- Snowflake (ExxonMobil), Databricks (Devon, Shell, Permian Resources) — [Petropt](https://petropt.com/articles/og-databases-historians-guide/)
- Cognite at TotalEnergies across upstream — [DCD](https://www.datacenterdynamics.com/en/news/totalenergies-signs-deal-with-cognite-to-deploy-ai-platform-across-upstream-asset-base/)

### Inferences
- Demand for offline and desktop tools is likely to be strongest in:
  1. OT-adjacent engineering work behind DMZs, where data leaves only via diode or file transfer
  2. NOCs and Gulf, Asian and African operators under data-localization rules
  3. consultants and auditors handling confidential client or JV data who cannot upload it to third-party clouds
  4. remote, frontier and onshore sites without LEO coverage or where regulators restrict it
  5. small and mid-size operators without cloud data teams
- LEO connectivity weakens the "no bandwidth" argument offshore. It does not affect the security, sovereignty and confidentiality arguments, which are getting stronger (DNV, Tosi, MENA sovereignty).
- Vendors are moving toward SaaS-only AI features (Seeq). That widens the gap for capable offline tools.

### Gaps
- No 2025–2026 survey directly quantifying the share of O&G operators that require air-gapped or offline analytics tools, or that prohibit cloud for OT data.
- No primary IEC 62443 text or O&G-specific compliance survey was retrieved. Architecture claims rely on vendor and practitioner sources.
- Regional differences outside the Middle East (for example Norway's NCS cloud adoption, China's data-export rules, Russia/CIS import substitution, Latin American NOCs) were not researched in this session.
