# Oil & Gas / LNG Workforce: Data, Digital, Emissions, HSE, GIS and Drone Roles (2025–2026), Employee Pain Points, and the Aviation-to-Energy Transition

Research date: 19 Oct 2026. Evidence tags used on each finding:
- **[V]** = verified by fetching the source page (primary or near-primary).
- **[S]** = taken from a search-engine result snippet or summary; the page itself was not fetched or was blocked (403). Treat as lower confidence.
- **[E]** = estimate, projection or vendor/marketing claim.
- **[A]** = anecdote, single example or opinion.
Older material (pre-2025) is dated inline. The web-search budget ran out partway through, so some sub-questions (Reddit threads, Hays/Brunel guides, McKinsey, Gastech/CERAWeek, Software Underground, Canada, Singapore, Angola, LNG commercial roles) could not be researched. They are listed under Gaps.

---

## 1. In-demand roles for 2025–2026: skills, tools, certifications and salaries

### Takeaway
Real postings for oil and gas data roles focus on **advanced SQL plus Spotfire and/or Power BI**. Python, R and Databricks are usually "preferred", and **years of domain experience (drilling and completions, pipeline, upstream) are the main gate**. GIS roles ask for **ArcGIS Pro plus pipeline data models (PODS/APDM)**. Emissions roles centre on **OGMP 2.0, EPA Subpart W and the EU Methane Regulation**. Drone roles need **licensing (e.g., CASA RePL/ReOC, FAA Part 107), BVLOS approvals and integrity-ready data deliverables**. HSE roles still rely on **NEBOSH/IOSH/OSHA plus offshore survival tickets**. The only reliable cross-regional salary dataset found (Airswift GETI 2026) covers engineering and HSE roles, not data or digital roles.

### Cited Findings

**Data analyst / production / drilling data roles (job-posting samples)**
- [V] Experis "Data Analyst III" (upstream oil and gas client, Spring TX, posted 01/01/2026, W2 contract, **US$60–70/hour**). Required: advanced SQL, Power BI *or* Spotfire ("both is a strong plus"), data cleansing and validation, dashboards on **drilling and completions data**. Preferred: Python, Databricks and data-engineering concepts. Analytics/BI certifications are "a plus". PI System and Aries are not mentioned. — [Experis posting](https://www.experis.com/en/job/407294/data-analyst-iii)
- [V] Continental Resources (Oklahoma City, onshore E&P; senior data analyst, closed ~mid-2026). Required: **advanced Spotfire and SQL**, and **at least 8 years in oil and gas** as a data analyst, engineering tech, business, systems or IT analyst. Minimum education is a high-school diploma; a bachelor's degree (MIS, data analytics, finance) is preferred. Preferred: UiPath, Grooper or Alteryx (to "automate manual workflows"), and advanced R or Python. Duties include maintaining Spotfire *and* Power BI tools and building tables and views in **Databricks**. — [Jobright listing of Continental Resources role](https://jobright.ai/jobs/info/69e91657e0cd471b2f13a330)
- [S] Other US postings ("Reservoir Engineering Data Analyst", "Production Operations Data Analyst") reportedly list Spotfire as a core requirement, Python/R as preferred or for "automation", Databricks as preferred, and economics tools such as **Aries**. These pages returned 403 when fetched. — [6AM City job 230948](https://jobs.6amcity.com/job/230948/reservoir-engineering-data-analyst/); [6AM City job 441443](https://jobs.6amcity.com/job/441443/production-operations-data-analyst/)

**GIS analyst (pipeline/upstream)**
- [S] Pipeline and midstream GIS postings (Hilcorp, Flint Hills Resources, Valero-type refiners, Whitewater Midstream, Gulf Companies) emphasise:
  - ArcGIS Pro and the **Pipeline Referencing toolset**
  - Maintaining the **PODS** data model ("data integrity and regulatory compliance"), with PODS and/or **APDM** preferred
  - Esri APR, alignment sheets, ArcGIS Enterprise administration and SQL Server geodatabases
  - Python/ArcPy
  - At senior level, "five years minimum" of C# with the ArcGIS Pro SDK for .NET
  
  One refining posting wants a minimum of 7 years of oil and gas experience. Certification is only "preferred: certification in GIS technologies". GISP and Esri Utility Network did not appear in the sampled postings. — [Energyhire Hilcorp Sr GIS Analyst](https://app.energyhire.com/job-board/sr-gis-analyst-houston-tx-b6916ba1-0c24-4816-b786-8c5e4ce9d4e1); [Energyhire Flint Hills GIS Analyst](https://app.energyhire.com/job-board/gis-analyst-wichita-ks-3df8a14f-cb67-4f45-b5f6-77cd3fc6ae9b); [Builtin Sr GIS Analyst/Developer](https://builtin.com/job/25-529-b1-sr-gis-analyst-developer/7271998); [Whitewater Midstream (Greenhouse)](https://job-boards.greenhouse.io/whitewatermidstream/jobs/4640526007); [Swooped – GIS Specialist Logistics, Torrance Refining](https://swooped.co/job-postings/gis-specialist-logistics-the-woodlands-torrance-refining-company-llc-038f1)

**Emissions / methane / MRV**
- [V] OGMP 2.0 (the UNEP-led measurement-based methane reporting framework) has **163 member companies in 90 countries covering 43% of global oil and gas production**. The 2026 OGMP 2.0 report (event dated 15 Oct 2026) says **69% of reported emissions are now based on measurement-based data**. — [OGMP 2.0 homepage](https://www.ogmpartnership.org/)
- [S] OGMP 2.0 reporting runs from Level 1 (consolidated asset or country reporting) to Level 5. Level 5 means reconciling independent site-level measurements with a source-level Level 4 inventory, which is data-reconciliation work. — [OGMP 2.0 Starters Guide (Apr 2025)](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf); [Validere OGMP guide](https://blog.validere.com/ogmp-2-0)
- [S] US EPA GHGRP Subpart W requires facilities emitting more than 25,000 tCO2e/yr to report annually. Most emissions are activity data multiplied by emission factors, with some direct measurement. The rule's status is politically contested in 2026: industry is pushing for more company-derived factors. — [Validere OGMP guide](https://blog.validere.com/ogmp-2-0); [GWU National Security Archive, Aug 2026](https://nsarchive.gwu.edu/briefing-book/climate-change-transparency-project/2026-08-18/inside-struggle-dismantle-americas)
- [S] Sample postings:
  - US "Senior Air Compliance Engineer" whose duties include leading OGMP 2.0 implementation and reporting
  - An LNG company "international affairs manager" requiring familiarity with the **EU Methane Regulation** (its implications for LNG importers and exporters) and methane MRV
  - Recurring UNEP consultancy roles ("Methane technology expert", "OGMP 2.0 Industry Engagement Consultant", Paris, posted 29 Sep 2026)
  
  — [ZipRecruiter oil-gas-methane jobs](https://www.ziprecruiter.com/Jobs/Oil-Gas-Methane); [UN Careers OGMP 2.0 role](https://careers.un.org/jobSearchDescription/284798); [Impactpool OGMP methane technologies expert](https://www.impactpool.org/jobs/927447)
- [S] Under the EU Methane Regulation, energy exporters must disclose upstream methane information from 2025, with phased requirements leading to methane-intensity reporting. This drives demand for MRV skills in LNG and upstream supply chains. — [SGA Natural Gas Association event page](https://sganaturalgas.org/event/introduction-to-the-eu-methane-regulation-mrv-preparing-for-a-global-regulatory-environment-2709/)

**Drone / UAV inspection**
- [V] Australian requirements for oil and gas drone inspection (Ace Aviation Aerospace Academy, 29 Aug 2026):
  - **Licences:** a **RePL** licences the pilot and a **ReOC** certifies the organisation. Commercial work typically needs both. BVLOS or long-corridor work needs additional CASA approval (Part 102 / SORA-aligned controls).
  - **What employers want:**
    - A nominated ReOC holder
    - Endorsed RePL pilots
    - A documented SMS (hazards, occurrence reporting, emergency response, contractor interfaces)
    - Payload calibration and data-quality governance
    - A training matrix
    - Site induction
  - **Sensors:** RGB, thermal, LiDAR, optical gas imaging (OGI) and laser methane.
  - **Deliverables:**
    - Findings tagged with asset, location, observation, evidence type, confidence, severity and recommended action
    - PPK corrections and change detection against earlier surveys
    - Export to **SAP PM, Asset Health or AVEVA** integrity systems
    - Full audit trail of flights and processing
  - **Benchmark:** CASA approved Xplorate for day and night BVLOS over Cooper Basin oilfields, valid to 31 Mar 2029.
  
  — [AAA blog, Drone Inspection Oil and Gas 2026 (Australia)](https://blog.aaa.edu.au/drone-inspection-oil-and-gas/)
- [S][A] A drone-careers source says oil and gas employers want manual flight skills, thermal imaging experience and "inspection reports engineers can act on". It says prior energy experience is not required, and that operators both run in-house drone programmes and contract specialist firms. It mentions FAA Part 107 for the US. — [Rocket Drones](https://rocketdrones.com/drones-in-oil-and-gas/)
- [S][E] Vendor claims: drones can inspect a live flare in one short flight with no shutdown. A laser methane payload (Pergam Falcon on DJI M300) detects plumes down to ~5 ppm-m. — [LeakSonic blog](https://www.leaksonic.com/blog/how-drones-transform-oil-gas-operations); [Percepto use cases](https://percepto.co/top-5-use-cases-for-oil-and-gas-drone-inspection/)
- [V] A freelance "RPAS (Drone) Safety Auditor" role (AEROTHRIVE GmbH, worldwide) requires:
  - A UAS operational background (pilot, manager, inspector or integrator)
  - BVLOS or industrial UAS experience
  - RPAS-specific SMS and risk-control knowledge
  - Familiarity with **BARS RPAS, ASTM RPAS, UIS and CAA** requirements
  
  Pay is "market rates". — [AEROTHRIVE vacancy](https://aerothrive.com/oil-and-gas-rpas-auditors-vacancy/)

**HSE / process safety**
- [V] Rigzone's HSE-officer entry checklist (updated 17 Sep 2025):
  - **Core:** NEBOSH IGC, *or* OSHA 30 plus IOSH Managing Safely
  - **Offshore access:** BOSIET with HUET and CA-EBS (FOET refresher), plus H2S/SCBA
  - **Onshore access:** RigPass, SafeGulf or SafeLand
  - **Management systems:** ISO 45001 (and 14001) internal auditor
  - **Investigation:** ICAM or TapRooT incident investigation, HAZID/HAZOP participation, bow-tie basics
  
  Entry is via HSE technician or trainee-officer roles with service, drilling or EPC contractors. Newcomers should allow 2–3 months of asset familiarisation. Rigzone puts the total transition at about 3–6 months. — [Rigzone career advice](https://www.rigzone.com/insights/career-advice-4/how-to-transition-into-an-hse-officer-role-in-oil-and-gas-613)
- [S][E] Low-confidence salary blogs: US HSE manager median ~$118k (total compensation $130–165k) and US process safety engineer median ~$105,400. Experienced HSE engineers: UAE AED 12,000–20,000/month, Australia AUD 90–140k, US $90–130k. One blog claims NEBOSH/IOSH/OSHA credentials lift pay by 20–40%. These look like SEO content and are unverified. — [Stealth Agents 2026](https://stealthagents.com/research/oil-and-gas-industry-staffing-costs-2026); [HSE Study Guide 2025](https://www.hsestudyguide.com/hse-engineer-salary-in-2025/); [The HSE Coach 2026](https://thehsecoach.com/hse-engineer-salary-in-2026/)

**Salaries: Airswift GETI 2026 (the most reliable cross-regional data found; no data or digital roles included)**
- [V] **HSE Manager (oil and gas), permanent salary in USD/yr:**

  | Region | Salary |
  |---|---|
  | Africa | 82,578 |
  | Asia | 75,697 |
  | Australasia | 189,736 |
  | Europe | 89,299 |
  | Latin America | 60,093 |
  | Middle East | 99,508 |
  | North America | 101,021 |

  **HSE Manager contractor day rates (USD):** Africa 992, Asia 518, Australasia 1,215, Europe 800, Latin America 365, Middle East 677, North America 800.

  **Oil and gas permanent average across the roles sampled (USD/yr):** Africa 88,079, Asia 80,623, Australasia 159,913, Europe 88,668, Latin America 52,765, Middle East 85,080, North America 100,757.

  Source: Airswift blog, published 13 Jul 2026, updated 3 Sep 2026, drawing on the 2026 GETI. The page has labelling inconsistencies: one permanent table is labelled "Day Rate", and the regional averages differ from the table averages. — [Airswift: What do energy jobs pay in 2026](https://www.airswift.com/blog/what-energy-jobs-pay)
- [V] Same source, all-sector regional permanent averages (USD/yr):
  - Australasia $135k (+3%)
  - North America $106k (+6%)
  - Europe $81k
  - Middle East $77k
  - Africa $75k
  - Asia $71k
  
  Commissioning Manager salaries rose 19% and Operations Manager salaries 12%. — [Airswift](https://www.airswift.com/blog/what-energy-jobs-pay)
- [S][E] A 2026 career guide puts E&P data engineers and data scientists at $90–120k entry level and $125–175k mid-career in the US. This is unverified. — [PetroPT guide](https://petropt.com/articles/breaking-into-oil-gas-2026-guide/)

**Skill-supply signal (EY survey, 508 oil and gas and chemicals respondents, fielded Nov–Dec 2024)**
- [V] Share of executives rating each skill "inadequate" in their current workforce:
  - Engineering 12%
  - Cloud 15%
  - Data visualisation 16%
  - Data analytics/data science 18%
  - Programming (Python, Java, etc.) 20%
  - AI 22%
  - Digital engineering 24%
  - **Geospatial analytics 26%**
  - Prompt engineering 27%
  - Physical robotics 28%
  - VR/AR 29%
  
  Availability of digital skills has risen sharply since 2020 (AI +51 percentage points). — [EY Future of Energy survey PDF (2025)](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/campaigns/energy-resources/documents/ey-ogc-future-of-energy-external-report.pdf)

### Inferences
- For a data tool to look credible to hiring managers, it should **interoperate with Spotfire/Power BI, SQL and Databricks-style warehouses** rather than replace them. Postings show these as the incumbent stack, with Python as an add-on.
- Experience gates (Continental: 8 years in oil and gas; GIS: up to 7 years in oil and gas; Repsol aviation advisor: 5 years in oil and gas) mean a portfolio tool is more likely to help **as proof of domain fluency** (drilling and completions, PODS, OGMP levels, Subpart W) than as a substitute for experience.
- Several of the product owner's skill areas overlap in the work itself:
  - **Drone + GIS + emissions:** OGMP Level 4/5 reconciliation, OGI and laser methane payloads, and integrity data handover to SAP PM/AVEVA.
  - **Aviation SMS + UAV:** RPAS safety auditing against BARS RPAS.
  
  Few candidates cover more than one of these areas.
- Geospatial analytics is among the skills EY respondents most often rate "inadequate" (26%), which supports a GIS-centred positioning.

### Gaps
- **Salaries for data, digital, emissions, GIS and drone roles by region:** no reliable source found. GETI 2026 covers only engineering and HSE roles, and Hays/Brunel salary guides could not be retrieved (search budget exhausted).
- **Specific evidence of PI System (AVEVA PI), OSDU, cloud certifications, PMP, API certifications or GHG Protocol courses in job postings:** none found in sampled postings.
- **LNG operations or commercial analyst requirements:** not researched (budget).
- **Process safety engineer requirements:** only low-confidence salary blogs found.
- **LDAR/OGI technician certifications (e.g., OGI thermography):** not sourced.
- **Drone licence equivalents in the UK (CAA), UAE (GCAA) and Saudi Arabia (GACA):** not sourced.

---

## 2. Regional hiring patterns

### Takeaway
- **GCC:** the main growth and destination market (tied with Europe as the most preferred relocation destination), but nationalisation rules are tightening, especially Saudi engineering quotas.
- **UK North Sea:** contracting fast. **Norway** is stable to slightly growing but with skills shortages.
- **North America and Malaysia:** large corporate layoffs in 2025 driven by low prices and M&A.
- **Australasia:** the highest pay.
- **Africa:** growth is project- and local-content-driven (Mozambique LNG, Namibia), with timelines extending to about 2030.

### Cited Findings

**GCC / Middle East**
- [S] Saudi Arabia: the HR Ministry set a **30% Saudisation rate for 46 engineering occupations**, with a **SAR 8,000 minimum salary**. Engineers must be accredited by the Saudi Council of Engineers, and the rule covers establishments with 5+ workers in those professions. A separate rule set **70% for 12 procurement roles**, effective 30 Nov 2025 (3+ workers). An earlier decision (effective 27 Jul 2025) set 30% for technical engineering roles with a SAR 5,000 floor.
  - The engineering effective date conflicts: Gulf Business says **31 Dec 2025**, while another summary says **30 Jun 2026**.
  
  — [Gulf News](https://gulfnews.com/world/gulf/saudi/saudi-arabia-raises-saudisation-targets-in-engineering-and-procurement-professions-1.500398145); [Gulf Business](https://gulfbusiness.com/saudisation-rates-raised-in-these-2-professions/); [Al Riyadh Daily](https://alriyadhdaily.com/article/0986f89cc14c47629adadaf9f5177d88); [People Matters ME](https://me.peoplemattersglobal.com/amp-employment-landscape-ksa-hr-ministry-increases-saudization-rates-for-key-sectors-46430); [Skills Provision (30 Jun 2026 date)](https://www.skills-provision.com/blog/saudi-arabia-oil-gas-process-engineering-workforce)
- [S] Aramco's iktva programme reached its 70% local-content target, with 75% targeted by 2030. This is procurement localisation, not a headcount quota. — [Oil & Gas Middle East](https://www.oilandgasmiddleeast.com/news/aramco-iktva-70-localisation-2030); [Mondaq](https://www.mondaq.com/oil-gas-electricity/819062/workforce-nationalisation-and-localisation-programs-key-considerations)
- [S] UAE:
  - ADNOC Gas reported a **63.8% Emiratisation rate at end-2025**, with annual KPIs for Emiratisation in *critical roles*. — [Aletihad](https://en.aletihad.ae/news/business/4656852/adnoc-gas-achieves-emiratisation-rate-of-63-8)
  - A claimed ADNOC target of 75% by 2030, and fines of AED 108,000 per unfilled position (2025) rising to AED 120,000 (2026) for private firms with 50+ staff, come from recruiter blogs and are **unverified**. — [RFS & Sons](https://rfsonshr.com/industry-recruitment-uae/oil-and-gas-recruitment-agencies/)
  - From May 2025, MoHRE gives a two-month grace period to replace a resigned Emirati employee. — [DLA Piper](https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2025/Recent-clarifications-on-Emiratisation-compliance-and-quota-calculations)
- [V] GETI 2026: the **Middle East and Europe are tied as the most preferred relocation destinations** for oil and gas professionals. — [World Oil on GETI 2026 (4 Feb 2026)](https://worldoil.com/news/2026/2/4/oil-and-gas-hiring-challenges-deepen-as-workforce-ages-and-mobility-falls-geti-reports/)
- [S] Qatar: a permanent, on-site "Aviation Safety Advisor" role for an oil and gas client was advertised on Petroplan (page returned HTTP 500 when fetched). — [Petroplan](https://www.petroplan.com/jobs/details/qatar/oil-gas/aviation-safety-advisor/9590)

**Europe**
- [V] UK, from the North Sea Transition Taskforce "One Year On" report (22 Sep 2026):
  - About **115,000 jobs** supported directly and through the supply chain.
  - An estimated **25,000 jobs lost since the last general election**.
  - About 1 in 4 workers in NE Scotland work in or support offshore energy.
  - Chair Philip Rycroft: "the traditional energy economy is declining faster than the new one is being built."
  - The report recommends ending the Energy Profits Levy and bringing in the Oil and Gas Revenue Levy from 2027-28.
  
  — [World Oil](https://www.worldoil.com/news/2026/9/22/north-sea-oil-and-gas-decline-threatens-115-000-job-workforce-report-says/)
- [S] UK, other figures:
  - An OEUK survey (late 2025) found **55% of 97 member firms cut headcount** in the previous 12 months. OEUK cites losses of "up to 1,000 jobs a month"; ONS figures are lower because they exclude contractors.
  - [E] Robert Gordon University projects 115,000 jobs falling to **57,000–71,000 by the early 2030s**.
  - UK production is ~75% below its 1999 peak, declining 7–11% a year.
  
  — [Energy Voice](https://www.energyvoice.com/oilandgas/north-sea/583103/more-than-half-of-north-sea-firms-cutting-jobs-as-industry-urges-budget-rethink-on-windfall-tax/); [RGU](https://www.rgu.ac.uk/news/news-2025/8232-uk-offshore-energy-industry-faces-grangemouth-scale-redundancies-every-fortnight-without-intervention-warns-new-rgu-report); [GB News](https://www.gbnews.com/news/north-sea-oil-jobs-lost-one-year-report)
- [V] Norway:
  - About **210,000 people directly or indirectly employed** in petroleum in 2023 (~10% of private employment; Menon Economics 2025).
  - Direct employment is an estimated **69,000 in 2025** and has risen since 2018.
  - The 2023 split: ~26,000 at operators, ~95,000 in supplier industries, 90,000+ elsewhere in the value chain.
  - Clusters: Stavanger (main base), Oslo (engineering), Bergen (subsea and maintenance), Trondheim (R&D).
  
  — [Norsk Petroleum – Employment](https://www.norskpetroleum.no/en/economy/employment/)
- [S] Norway, other figures:
  - **74% of Offshore Norge member companies struggle to hire the engineering expertise they need** (NHO competence barometer; undated).
  - NAV's 2025–2035 outlook expects growing shortages of skilled industrial workers.
  - Shelf investment hit a record (~NOK 215bn) in 2025, with a decline expected in 2026.
  
  — [Equinor/Konkraft news](https://www.equinor.com/news/archive/recruiting-skilled-workers-all-fields); [Skills Provision (May 2025)](https://development.skills-provision.com/blog/norway-when-wealth-still-needs-workers)
- [V] GETI 2026: Europe was the only region where average contractor day rates fell ($667 to $663). — [Airswift](https://www.airswift.com/blog/what-energy-jobs-pay)

**Africa**
- [S] Mozambique LNG (TotalEnergies), per its project fact sheet:
  - About 5,000 local jobs at construction peak and 1,500–1,700 operations jobs.
  - Training for 2,500 young people by 2027.
  - Cumulative local procurement rising from $2.5bn to $4.5bn (Jul 2025).
  - The project was listed under force majeure.
  - [E] Advocacy sources claim 17,000+ construction jobs.
  - Local Content Law No. 9/2026 (approved June 2026) creates a Local Content Authority.
  
  — [Mozambique LNG local-content fact sheet (Jul 2025)](https://www.mozambiquelng.co.mz/wp-content/uploads/2025/09/MzLNG-Project-Local-Content_FACT-SHEET_ENG.pdf); [African Energy Chamber](https://energychamber.org/mozambique-raises-the-bar-on-local-content-to-drive-jobs-skills-and-industry-growth/)
- [S] Namibia: the Upstream Petroleum Local Content Policy received in-principle approval in April 2026. FIDs (TotalEnergies Venus, BW Kudu, Rhino) are pending, and first oil is expected around 2030. Technical training is planned for Lüderitz and Walvis Bay. — [African Energy Chamber](https://energychamber.org/from-orange-basin-to-opportunity-namibia-pushes-local-content-to-the-center-of-oil-strategy/); [News Ghana](https://www.newsghana.com.gh/namibia-oil-conference-targets-local-jobs-as-key-decision-nears/)
- [S] Nigeria has "one of Africa's most established local-content systems" (NCDMB) and is shifting towards domestic manufacturing and technical services. No 2025–26 job figures were found. — [African Mining Market (AEW 2026 preview)](https://africanminingmarket.com/aew-2026-to-explore-africas-shift-from-local-content-participation-to-industrialization/26669/)
- [V] GETI 2026: Africa has the **highest oil and gas contractor day-rate average ($916)**, contractor rates rose 4% year-on-year, and HSE Manager contractor rates average $992/day. — [Airswift](https://www.airswift.com/blog/what-energy-jobs-pay)

**North America**
- [S] 2025 corporate cuts:
  - **Chevron:** ~20% of global workforce (announced Feb 2025)
  - **ConocoPhillips:** 20–25% (Sep 2025)
  - **ExxonMobil:** ~2,000 jobs (3–4%), consolidating into regional hubs
  - **BP:** ~5%, mainly office staff (Jan 2025)
  
  Drivers cited: weak crude prices and M&A consolidation, not AI. The Greater Houston Partnership warned of ~3,200 oil and gas job losses in Houston in 2026. — [Reuters factbox via Stockopedia](https://www.stockopedia.com/share-prices/imperial-oil-TSE:IMO/news/factbox-global-energy-layoffs-deepen-in-2025-as-crude-prices-weaken-m-amp-a-deals-surge-019e69e9-16df-7261-8a96-b499d174237c/); [Bloomberg Law](https://news.bloombergtax.com/daily-labor-report/exxon-to-cut-2-000-workers-as-oil-sector-job-losses-mount); [UPI](https://www.upi.com/Top_News/US/2025/09/04/conocophillips-lay-offs/3821757006954/); [Houston Chronicle](https://preview-prod.w.houstonchronicle.com/business/energy/article/houston-energy-biggest-layoffs-2025-exxon-chevron-21118071.php)
- [V] GETI 2026: North America has the highest all-sector contractor day-rate average ($755) and average permanent pay of $106k (+6%). — [Airswift](https://www.airswift.com/blog/what-energy-jobs-pay)

**Asia-Pacific**
- [S] Petronas announced on 5 Jun 2025 that it would cut ~10% of its workforce (~5,000 roles) under "Petronas 2.0", focused on support and administrative roles. The PM said most are contract positions; net income fell 32% in 2024. A hiring freeze and staged notifications into 2026 were also reported. — [World Oil](https://www.worldoil.com/news/2025/6/5/petronas-to-cut-10-of-workforce-as-low-oil-prices-hit-profits/); [HR Online](https://www.humanresourcesonline.net/petronas-to-reduce-workforce-by-10-as-part-of-transformation-drive); [NST](https://www.nst.com.my/amp/business/corporate/2025/06/1227117/petronas-job-cuts-reflect-broader-industry-shift-say-economists)
- [V] Australasia pays the most in GETI 2026: oil and gas permanent average $159,913 and HSE manager $189,736. — [Airswift](https://www.airswift.com/blog/what-energy-jobs-pay)
- [V] GETI 2025 noted a slowdown in Australian utility-scale energy-transition investment commitments. — [JPT (23 Apr 2025)](https://jpt.spe.org/report-finds-upstream-salaries-on-the-rise-along-with-renewed-workforce-pressures)
- [V] Australia's drone inspection market is active, for example CASA BVLOS approvals over the Cooper Basin and QGC's 7,000 km² Surat Basin operation. — [AAA blog](https://blog.aaa.edu.au/drone-inspection-oil-and-gas/)

### Inferences
- For an expat aviation-safety, GIS and data professional, the **GCC is the largest market but structurally constrained**. Saudi engineering quotas and ADNOC "critical role" Emiratisation KPIs favour nationals for permanent posts. Expat demand is likely to concentrate in specialist, contractor and advisory roles (aviation advisor, auditing, niche digital) and in training or knowledge-transfer roles.
- The UK North Sea is a poor primary target for new entrants. Norway and the GCC are better for hiring, and Australasia for pay.
- The 2025 layoffs in North America and Malaysia hit office and support functions, so entry-level data and analyst roles there face more competition from displaced experienced staff.

### Gaps
- **QatarEnergy** (North Field expansion) workforce data and **Qatarisation** rules: not found.
- **Canada**, **Singapore**, **Angola** and **Nigeria** 2025–26 hiring data: not researched (search budget exhausted).
- **US LNG** construction and operations labour data: not researched.
- **Australian LNG workforce shortage** data: a query returned nothing.
- **Official Saudi MHRSD text:** not retrieved, so the effective-date conflict is unresolved.

---

## 3. Industry workforce surveys (GETI, EY, Deloitte and others)

### Takeaway
Three surveys tell a consistent story:
- The **workforce is ageing**: 48% are aged 45+ and only 19% are 25–34.
- **Mobility is falling**: willingness to relocate has dropped from 89% to 75%.
- **AI use is rising but lags other industries** (~45%).
- Companies say **reskilling is strategic but under-invest in it**: EY found under a third actively retraining, and 82% of executives think reskilling costs outweigh benefits.
- **Engineering and technical operations roles are hardest to fill.**

### Cited Findings
- [V] **GETI 2025** (Airswift/Energy Jobline, released 27 Feb 2025, ~11,000 professionals of 150 nationalities):
  - Fewer under-35s in every sector, and employers are rehiring retirees for complex projects.
  - 71% of traditional-energy professionals think their employer is resilient.
  
  — [Airswift GETI 2025 launch](https://www.airswift.com/news/geti-report-live)
- [V] GETI 2025 detail:
  - **Pay:** 50% got a raise and 26% got more than 5%; 71% expect a raise.
  - **Mobility and careers:** 80% would relocate (89% in 2021); 86% would consider a role move.
  - **Renewables:** interest in switching rose from 56% (2023) to 71% (2025).
  - **Technology is the most attractive non-energy sector (28%)**, and career progression is the top relocation driver (50%).
  
  — [Think Global People](https://thinkglobalpeople.com/geti-2025-71-of-oil-and-gas-and-petrochemical-industry-professionals-consider-renewables-as-career-priorities-shift-in-2025/)
- [V] GETI 2025, via JPT:
  - Under-35s fell to 24% (27% in 2021) and 35–44s rose from 28% to 32%.
  - Professionals want more training and a focus on cost management.
  - **Support for employers adopting automation and digital tools fell 4 points to 21%.**
  - Two-thirds say their organisations have cut operational emissions.
  
  — [JPT (23 Apr 2025)](https://jpt.spe.org/report-finds-upstream-salaries-on-the-rise-along-with-renewed-workforce-pressures)
- [V] **GETI 2026** (reported 4 Feb 2026; sample size not stated in the article):
  - **Age:** 45+ are **48%** of the traditional-energy workforce and 25–34s are **19%**. Only ~**one-third of hiring managers actively recruit graduates**.
  - **Mobility:** **75%** willing to relocate, down from 80% (2025) and 89% (2022).
  - **Pay:** 50% of professionals and 60% of hiring managers reported 2025 pay rises; 67% expect rises in 2026 (down from 71%).
  - **AI:** ~**45% use AI** at work, sharply up from 2024 but behind other industries.
  - **Hardest to fill:** engineering and technical operations roles.
  - **Employer responses:** companies are investing in training, revising role requirements and using digital tools.
  
  — [World Oil](https://worldoil.com/news/2026/2/4/oil-and-gas-hiring-challenges-deepen-as-workforce-ages-and-mobility-falls-geti-reports/)
- [V] **EY Future of Energy survey (2025)**: 508 oil and gas and chemicals employees (Americas 285, EMEA 115 incl. Saudi Arabia 17, APAC 108), fielded 4 Nov–3 Dec 2024 by FleishmanHillard TRUE Global Intelligence.
  - **Reskilling vs. actual retraining:** 87% say reskilling ability is a competitive advantage (+12 percentage points since 2020), but **fewer than one-third are actively retraining existing employees**, and 25% expect staff to learn on the job.
  - **Scaling and hiring:** 85% struggle to move from single use cases to organisation-wide scale, and 83% say hiring and retaining workers proficient in new technologies is a major challenge.
  - **How executives see training:** nearly 3 in 4 executives view training as a cost centre, and **82% believe reskilling costs often outweigh benefits**.
  - **Value realisation:** only 27% of executives say cloud *or* AI has lived up to expectations.
  - **Current technology use:** OT/remote sensors 79%, cloud 76%, advanced analytics 72%, AI/GenAI/ML 71%, digital twins 50%.
  - **Skills confidence:** fewer than half of current users feel they have the skills to get full value; about one-third of planned users are confident.
  
  — [EY report PDF](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/campaigns/energy-resources/documents/ey-ogc-future-of-energy-external-report.pdf)
- [V] **Deloitte** (Greg Vert, Human Capital Applied AI Leader, at an Energy Workforce & Technology Council roundtable, 1 Oct 2025):
  - **39% of workers' core skills are expected to change by 2030.**
  - Skilled trades are likely to grow because AI has limited impact on them, while **knowledge work faces high disruption, especially at entry level**.
  - Agentic and multi-agent AI are emerging.
  
  — [EWTC](https://energyworkforce.org/people-culture-committee-addresses-ai-workforce-impacts/)
- [S] Deloitte's 2026 Oil & Gas Industry Outlook themes include new LNG opportunities, supply-chain strategy and the growing role of AI across operations. — [Deloitte Dbriefs](https://www.deloitte.com/us/en/dbriefs-webcasts/2026-oil-gas-industry-outlook.html)
- [S][E] EPAM (vendor) research: 98% of energy companies planned to hire AI-specific roles by 2025, and 54% said their workforce lacks the skills to deploy GenAI. — [EPAM](https://www.epam.com/insights/blogs/empowering-the-energy-workforce-bridging-ai-skill-gaps-to-drive-transformation)
- [S][E] Secondary blogs (ABLEMKR, Taggd) repeat statistics such as "48% of US workers 45+" and "187% rise in AI adoption" without traceable primary sources. Treat as unverified. — [ABLEMKR](https://ablemkr.com/regional-oil-and-gas-workforce-trends-2026-analysis/); [Taggd](https://taggd.in/blogs/skilled-workforce-shortage-in-oil-and-gas/)

### Inferences
- The "great crew change" is real in the data: 48% of the workforce is 45+ and only a third of hiring managers recruit graduates. This favours **experienced mid-career switchers** (like a 17-year aviation professional) over graduates, *if* they bring transferable safety and operations maturity.
- Executives see training as a cost and staff learn on the job. This creates room for **tools that embed know-how** (templates, guided workflows) and for people who can **teach and translate** between domains.
- Deloitte's view that entry-level knowledge work faces the most disruption suggests junior "dashboard builder" roles are at risk. Domain-plus-data hybrid roles (HSE data, emissions MRV, aviation and drone data) look more durable.

### Gaps
- **McKinsey** oil and gas talent-gap reports, the **Hays Oil & Gas salary guide**, **Brunel** reports, and the **WEF Future of Jobs 2025** oil and gas figures: not retrieved (search budget exhausted, or figures not extractable).
- **GETI 2026** sample size and full digital-skills chapter: not found in the coverage.
- **SPE, IOGP and Energy Institute** workforce reports for 2025–26: not found.

---

## 4. What employees need and struggle with in data work

### Takeaway
The most consistent pain point is **time lost finding, cleaning and validating data**. Vendor estimates range from about a quarter to 70–80% of technical staff time, and the most neutral recent survey found 24% spend more than 30% of their time on it. Other findings:
- Oil and gas has the **weakest data-management frameworks** of the sectors surveyed (14%).
- Employees **lack structured training**.
- Job security and wellbeing pressures (layoffs, rotation, mental-health stigma) sit on top of this.

Specific evidence on licence access and "too many systems" was not found.

### Cited Findings
- [V] **Seequent 2023 Geoscience Data Management Survey** (~700 respondents across energy, mining, civil and environmental; vendor-run):
  - **Time and access:** **24% spend more than 30% of their time on data management** (down from more than a third in 2020). About **a quarter lack access to the data they need** for robust decisions.
  - **Oil and gas has the lowest share with an established data-management framework (14%)**, versus mining 39% and environmental 35%. 32% of oil and gas firms plan one within 2–3 years.
  - **Common challenges:** **57% cite unmanaged historical data**, and a "single source of truth" is the top expected outcome (29%).
  
  — [Seequent](https://seequent.com/how-well-does-the-energy-industry-manage-its-data-we-have-the-facts-figures-and-opinions-from-around-the-world)
- [S][E] Vendor claims on time lost to data:
  - INT: "30–90%" of geoscientists' time goes on validating data
  - Aptara: "up to 80%" searching and formatting
  - Cegal/Geo365: "more than half" retrieving and preparing data
  - An AWS executive on OSDU's origin: petrotechnical staff spent "up to 70%" of their time wrestling with data
  - An IPTC 2008 paper (older): up to 30% searching, plus as much again on access, moving data between applications and quality issues
  
  These are mostly vendor figures and not independently measured. — [INT](https://www.int.com/blog/how-osdu-can-help-data-management/); [Aptara](https://www.aptaracorp.com/?p=1588); [Geo365](https://geo365.no/?p=58106); [Hart Energy](https://hartenergy.com/exclusives/ep-tech-trends-how-osdu-aws-changing-data-management-204579); [EarthDoc IPTC 12035](https://www.earthdoc.org/content/papers/10.3997/2214-4609-pdb.148.iptc12035)
- [V] Job descriptions show manual data work as a core part of the job:
  - Experis: "import, cleanse, validate" and "keep data accurate and consistent across reporting platforms"
  - Continental: maintain **both** Spotfire and Power BI and "automate manual workflows" with UiPath, Grooper or Alteryx
  
  Running two BI tools side by side suggests tool sprawl. — [Experis](https://www.experis.com/en/job/407294/data-analyst-iii); [Jobright/Continental](https://jobright.ai/jobs/info/69e91657e0cd471b2f13a330)
- [V] EY: **fewer than half** of current technology users feel they have the skills to maximise value, under one-third of firms actively retrain, and 25% rely on on-the-job learning. — [EY](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/campaigns/energy-resources/documents/ey-ogc-future-of-energy-external-report.pdf)
- [V] GETI 2025: professionals want **more training**. Support for employers adopting automation and digital tools fell to 21%, which suggests scepticism or change fatigue rather than demand for more tools. — [JPT](https://jpt.spe.org/report-finds-upstream-salaries-on-the-rise-along-with-renewed-workforce-pressures)
- [S] Wellbeing:
  - The 2025 **North Sea Wellbeing Report** (Step Change in Safety, Mental Health in Energy, Marine Safety Forum) found workers aged 35–64 more likely to believe accessing mental-health support will hurt their careers.
  - An IADC report found **40% of remote rotational shift workers experienced suicidal thoughts some or all of the time on duty**. The date is uncertain, and a follow-up survey with Step Change and RGU was planned.
  
  — [Energy Voice Outloud podcast (Mar 2025)](https://energyvoiceoutloud.podbean.com/e/scis-wellbeing/); [Energy Voice](https://energyvoice.com/?p=550456)
- [S] Academic studies:
  - A 2025 Malaysian study (364 offshore workers) found job insecurity, rigid hierarchy and mental-health stigma limit wellbeing.
  - A 2019 Middle East study (1,747 offshore workers) found ~15% had anxiety or depression symptoms, with **rotation length** a significant predictor.
  - A systematic review (2007–2025 studies) concludes burnout depends on work design and organisational policy, not just individual coping.
  
  — [EBPJ (Malaysia 2025)](https://ebpj.e-iph.co.uk/index.php/EBProceedings/article/download/7649/4703/39268); [BVS/Medline (2019)](https://busqueda.bvsalud.org/portal/resource/es/mdl-30657988); [JIMKES review](https://jurnal.ibik.ac.id/index.php/jimkes/article/view/5355)
- [V] Job insecurity is real: 55% of UK North Sea firms cut staff, and Chevron, ConocoPhillips, ExxonMobil, BP and Petronas all made large 2025 cuts (see Section 2). — [World Oil](https://www.worldoil.com/news/2026/9/22/north-sea-oil-and-gas-decline-threatens-115-000-job-workforce-report-says/); [World Oil Petronas](https://www.worldoil.com/news/2025/6/5/petronas-to-cut-10-of-workforce-as-low-oil-prices-hit-profits/)

### Inferences
- The pain points a data workbench could target are:
  - Data discovery and validation (unmanaged historical data, no single source of truth)
  - Reconciliation across systems (Spotfire *and* Power BI, SQL, Databricks, SAP PM/AVEVA)
  - Repeatable reporting (OGMP and Subpart W, HSE KPIs, drone inspection findings)
- Because support for "more digital tools" is falling (21%), positioning should stress **less manual work and fewer handoffs**, not "another platform".
- Lean teams after layoffs plus weak training mean low-friction, open and documented tools that run without licence approvals are likely to appeal to individual practitioners. This is an inference; no direct evidence on licence access was found.

### Gaps
- **Practitioner discussions** (Reddit r/oilandgasworkers, r/petroleumengineering, LinkedIn): not retrieved. The one search returned only a generic data-career thread.
- **Licence access** (e.g., Spotfire/Petrel seat limits), **"too many systems"** and **desire for automation**: no survey quantifying these was found.
- **Burnout among office-based data and digital staff**, as distinct from offshore crews: no data found.

---

## 5. Moving from aviation (especially aviation safety) into oil and gas

### Takeaway
Oil and gas has formal aviation-risk structures that hire aviation safety specialists directly:
- **IOGP OGARP** (Reports 690/691, replacing Report 590), **Flight Safety Foundation BARS** (including BARS for offshore helicopter operations and BARS RPAS), and **HeliOffshore**.
- Operator "Aviation Advisor" roles, and aviation and RPAS auditors at contractors.
- Aviation CRM was formally adopted for well operations (IOGP 501/502).

Typical job specs want **5+ years of aviation safety/SMS, a pilot or engineer background (often helicopter), accident investigation and human-factors training, and 5+ years of oil and gas exposure**. Fixed-wing or airline people without helicopter or offshore background will likely need offshore survival tickets plus an oil and gas safety qualification (NEBOSH/IOSH) and asset familiarisation.

### Cited Findings
- [V] **IOGP Oil and Gas Aviation Recommended Practices (OGARP)** were developed by oil and gas companies, aviation associations and operators as a framework for managing aviation risk.
  - **Report 690:** *Offshore Helicopter Recommended Practices*.
  - **Report 691:** *Fixed-wing commercial air transport recommended practices*, published 28 Nov 2023, with modules on SMS, aircraft operations, support operations, engineering, and aircraft and equipment.
  - OGARP is "the next iteration" of **IOGP Report 590** (Aviation Management Guidelines).
  
  — [IOGP news](https://www.iogp.org/blog/news/latest-addition-to-iogps-oil-and-gas-aviation-recommended-practices-ogarp-series-published/)
- [S] **IOGP Report 590** (v2, May 2017; older):
  - It supplements National Aviation Authority rules.
  - "Aviation Advisors" support people managing aviation who are not aviation specialists.
  - Only aircraft operators and types approved by an Aviation Advisor should be used for non-scheduled flights.
  - Modules: 590-A (key elements), 590-C (personnel qualifications), 590-D (aircraft operations).
  
  — [IOGP Report 590 PDF](https://www.iogp.org/bookstore/wp-content/uploads/sites/2/woocommerce_uploads/2017/05/590.pdf); [IOGP AMG bookstore](https://www.iogp.org/bookstore/product/aircraft-management-guidelines-2/)
- [S] **Flight Safety Foundation BARS** (older history, recent status):
  - BARS for Offshore Helicopter Operations (OHO) launched in May 2015. It covers loss of control, controlled flight into water, weather, wrong-deck landings, helideck obstacles, survivability and SAR.
  - Operators are audited annually to become Registered BARS Aircraft Operators.
  - FSF and HeliOffshore produced an offshore helicopter standard in 2016 using bow-ties.
  - SKYbrary (Jul 2025) says BARS now also supports government, humanitarian, offshore, corporate and insurance sectors.
  
  — [SKYbrary BARS](https://skybrary.aero/articles/basic-aviation-risk-standard-bars); [Aviation Week](https://aviationweek.com/business-aviation/flight-safety-foundation-expands-basic-aviation-risk-standard-offshore-helicopter); [Aerossurance](https://aerossurance.com/?p=2781)
- [V] **Operator Aviation Advisor job spec** (Repsol via Altea Energy, Spain, start 1 Jan 2025):
  - **Duties:**
    - Classify aviation contracts by risk and set technical and HSE requirements
    - Track contractor safety KPIs and run aviation safety audits
    - Support incident investigation and Management of Change
    - Evaluate helipads and airstrips, offshore helideck certification and external-load operations
  - **Requirements:**
    - **5+ years as a commercial helicopter pilot or mechanic**
    - **5+ years in aviation safety (SMS/QA)**
    - **5+ years in oil and gas** (offshore, desert, jungle)
    - Training in **accident investigation and human-factors analysis**
    - A helicopter pilot licence and a university degree
    - English, with Spanish an advantage
  - **Standards cited:** OGP/IOGP, HAC, HSAC.
  
  — [Altea Energy posting](https://altea-energy.com/jobs/aviation-advisor/)
- [S] A Shell Aberdeen "Aviation Advisor" role (posting ~2023; older) included helideck inspections and acting as Contract Holder or member of the Contract Management Team for aviation contracts. — [HiJobs Shell Aviation Advisor](https://hijobs.net/job/277571/aviation-advisor)
- [V] **AEROTHRIVE freelance "Oil & Gas Aviation Auditor"** (worldwide):
  - **Duties:** audit fixed-wing and rotary-wing operators serving energy, covering SMS maturity, helideck operations, training, and flight and technical records.
  - **Requirements:** substantial aviation safety, operations or airworthiness experience; offshore helicopter, charter or energy-aviation background; SMS and risk-based auditing; audit credentials (ISO, BARS, SARPcheck, IOGP).
  - **Standards:** IOGP 690/590, BARS, SARPcheck, CAP 437.
  
  — [AEROTHRIVE](https://aerothrive.com/oil-and-gas-rpas-auditors-vacancy/)
- [S] An Anchorage "Aviation Safety Manager" posting (June 2026) asks for oil and gas aviation experience including offshore helicopter operations, an FAA Commercial/ATP or A&P certificate, **CSP, ARM or equivalent** safety certification, and IS-BAO experience. A Feb 2026 posting asked for "8+ years experience helicopter pilot/operations". — [ZipRecruiter offshore aviation](https://www.ziprecruiter.com/Jobs/Offshore-Aviation); [Glassdoor aviation advisor jobs](https://www.glassdoor.com/Job/aviation-advisor-jobs-SRCH_KO0,16.htm); [Rigzone aviation jobs](https://www.rigzone.com/a-aviation-jobs/)
- [S][A] **Examples of people who moved:**
  - A former US Marine helicopter pilot and squadron safety officer (with an aviation accident investigation and safety programme certificate) became an airfield safety manager, then **Shell's aviation contract manager overseeing offshore helicopter operations in Alaska**. Source: NTSB docket witness biographies, 2017.
  - At Gulf Helicopters (Qatar), a safety officer moved into operations management in Sep 2024.
  - HeliOffshore's team includes former airline and military aviators now leading safety work.
  
  — [NTSB docket biographies](https://data.ntsb.gov/Docket/Document/docBLOB?ID=40455431&FileExtension=.PDF&FileName=Exhibit+1H-+Witness+Biographies-Master.PDF); [Gulf Helicopters management](https://www.gulfhelicopters.com/en/contents/view/management-team); [HeliOffshore team](https://www.helioffshore.org/team)
- [V] **CRM transfer from aviation:**
  - CRM was recognised after the NTSB's 1979 recommendation for airline crews.
  - IOGP **Report 501** (*CRM for Well Operations teams*) and **Report 502** (*Guidelines for implementing Well Operations CRM training*, Feb 2015; older) aim to make CRM standard practice to prevent major well incidents. They also build on Energy Institute CRM and non-technical-skills guidance.
  - Competencies: situation awareness, decision-making, communication, teamwork, leadership and human-performance factors.
  - [S] The drilling industry examined CRM after Macondo.
  
  — [IOGP blog](https://www.iogp.org/blog/oil-and-gas-safety/crew-resource-management-can-be-standard-industry-practice/); [IOGP 502 (HPOG)](https://hpog.org/resource-centre/iogp-papers/iogp-502/); [Human Factors 101](https://humanfactors101.com/topics/non-technical-skills-crm/)
- [V] **General HSE entry route for career changers:** NEBOSH IGC or OSHA 30 plus IOSH; BOSIET/HUET/CA-EBS; ISO 45001 auditor; ICAM or TapRooT; HAZID/HAZOP; bow-tie. Rigzone estimates a 3–6 month transition with 2–3 months of asset familiarisation. — [Rigzone](https://www.rigzone.com/insights/career-advice-4/how-to-transition-into-an-hse-officer-role-in-oil-and-gas-613)
- [V] RPAS safety auditing (BARS RPAS, ASTM, CAA) is a distinct contract niche that combines aviation SMS with UAS operations. — [AEROTHRIVE](https://aerothrive.com/oil-and-gas-rpas-auditors-vacancy/)

### Inferences
- **Transferable skills that map directly:** SMS (an SMS module leads IOGP 691); bow-tie risk analysis (used by BARS OHO and oil and gas HSE); human factors and CRM (IOGP 501/502); accident investigation (ICAM/TapRooT); audit and compliance; contractor oversight (aviation contract holder roles); helicopter offshore operations; UAV/RPAS operations.
- **Gaps an aviation-safety professional should expect to fill:**
  - Oil and gas-specific HSE credentials (NEBOSH/IOSH)
  - Offshore survival (BOSIET/HUET)
  - **Process safety** vocabulary (HAZOP, barriers, MoC)
  - Asset familiarisation
  - Often a demonstrable record of "years in oil and gas"
- **Quickest bridges:** contractor-side roles (helicopter operators, BARS/IOGP aviation auditors, RPAS auditors, drone inspection firms) rather than operator staff roles, which list multi-year oil and gas experience requirements.
- **Possible tool angle:** a data tool covering aviation and drone operations analytics for oil and gas (helicopter flight data, contractor KPI tracking per OGARP/BARS, RPAS inspection data, HSE leading indicators) would sit squarely on the aviation-to-energy bridge. Few data people have this domain knowledge.

### Gaps
- **Personnel qualification criteria for Aviation Advisors:** the IOGP 590-C / OGARP text was not retrieved.
- **Pay for aviation advisor or auditor roles:** no published data found.
- **Documented case studies of fixed-wing or airline safety managers moving into oil and gas HSE or data roles:** none found. The examples found involve helicopter or military pilots.
- **HeliOffshore 2025–26 programmes** (e.g., HeliOffshore's safety performance data initiatives): not researched in depth.

---

## 6. How engineers and data people build visibility and credibility

### Takeaway
There are visible channels for credibility, but **no evidence was found that GitHub or open-source portfolios lead to oil and gas hiring**:
- Very large conferences (ADIPEC 2025: ~240k attendees)
- SPE technical disciplines and courses (e.g., Data Science & Engineering Analytics, "Python for Petroleum Data Analytics")
- An active ecosystem of public petroleum-Python repositories

Postings still gate on years of domain experience. Portfolios are best understood as **supporting evidence of domain fluency**, combined with professional-body membership and conference presence.

### Cited Findings
- [S][E] **ADIPEC 2025** (Abu Dhabi):
  - A record **239,709 attendees** (+17%) from 172 countries
  - US$46bn in deals reported by the organisers
  - A daily record of 70,000+ visitors on day 2
  - Next edition: 2–5 Nov 2026
  
  Attendance figures come from organiser-sponsored releases. — [WAM](https://www.wam.ae/en/article/bmkc68q-adipec-2025-sets-record-with-over-70000-visitors); [OE Digital (sponsored)](https://www.oedigital.com/news/532172-sponsored-record-deals-and-record-attendance-underscore-adipec-s-global-impact); [Gulf IF](https://gulfif.org/timeline/adipec-2025-delivers-46bn-in-deals-sets-bold-agenda-for-future-energy/)
- [S] SPE offers a two-day "Python for Petroleum Data Analytics" course under its **Data Science and Engineering Analytics** discipline, built on free, open-source tools and aimed at petroleum engineers building predictive models. — [SPE course page](https://www.spe.org/en/training/courses/python-for-petroleum-data-analytics/); [SPE syllabus PDF](https://higherlogicdownload.s3.amazonaws.com/SPE/6603b0af-0810-4911-b852-5c0639eacdd7/UploadedImages/PythonPDA_SPE_Short_Course_Syllabus_Final.pdf)
- [S] A 2023 SPE Nigeria paper describes teaching Python to petroleum undergraduates with all materials on an open-access GitHub repository. — [OnePetro SPE NAIC 2023](https://onepetro.org/SPENAIC/proceedings-abstract/23NAIC/23NAIC/525925)
- [S] Examples of public oil and gas Python repositories:
  - petrolpy (scripts and notebooks)
  - "Petroleum From Scratch" data analytics and ML notebooks
  - The GitHub topics oil-and-gas, petroleum-engineering and petroleum-economics
  
  One engineer's profile describes a portfolio integrating reservoir engineering with Python, SQL, ML and decision-support systems. — [petrolpy](https://github.com/mwentzWW/petrolpy); [Petroleum From Scratch repo](https://github.com/jaiyesh/Petroleum-Data-Analytics-and-Machine-Learning); [GitHub topic oil-and-gas](https://github.com/topics/oil-and-gas?l=python/1000&o=desc&s=forks); [GitHub drK89](https://github.com/drK89/drK89)
- [V] GETI 2026: only ~one-third of hiring managers actively recruit graduates, and engineering and technical operations roles are hardest to fill. — [World Oil](https://worldoil.com/news/2026/2/4/oil-and-gas-hiring-challenges-deepen-as-workforce-ages-and-mobility-falls-geti-reports/)
- [V] Postings gate on domain experience (Continental: 8+ years in oil and gas; Repsol aviation advisor: 5+ years in oil and gas), and certifications are only "a plus" (Experis). — [Jobright/Continental](https://jobright.ai/jobs/info/69e91657e0cd471b2f13a330); [Altea Energy](https://altea-energy.com/jobs/aviation-advisor/); [Experis](https://www.experis.com/en/job/407294/data-analyst-iii)
- [V] Rigzone recommends that HSE switchers join local HSE societies and oil and gas associations, and network through agencies staffing turnarounds and drilling campaigns. — [Rigzone](https://www.rigzone.com/insights/career-advice-4/how-to-transition-into-an-hse-officer-role-in-oil-and-gas-613)
- [V] HeliOffshore and Flight Safety Foundation (BARS) are the professional forums where offshore aviation safety specialists gather. — [HeliOffshore team](https://www.helioffshore.org/team); [SKYbrary BARS](https://skybrary.aero/articles/basic-aviation-risk-standard-bars)

### Inferences
- A public, domain-specific open-source tool is most likely to build credibility if it:
  - (a) speaks the industry's standards (OGMP 2.0 levels, Subpart W, PODS, IOGP OGARP/BARS KPIs, SAP PM/AVEVA integrity handover)
  - (b) works alongside Spotfire, Power BI and SQL
  - (c) is shown in SPE, IOGP, Energy Institute and HeliOffshore channels, for example an SPE paper or technical-section talk, or an ADIPEC or Gastech session or poster
- Given the experience gates, the tool should be framed as **"17 years of safety-critical aviation data and SMS applied to oil and gas problems"** rather than as a generic data-science portfolio.
- The career levers that are available without years in oil and gas are networking at very large events (ADIPEC) and contractor and auditor routes.

### Gaps
- **Whether open-source contributions or GitHub portfolios helped people get hired in oil and gas:** no survey or documented case found.
- **Software Underground** (open-source geoscience community), **SPE DSEA technical-section membership** numbers, **Gastech 2025** and **CERAWeek 2026** attendance, and **Energy Institute** or **IOGP** membership benefits for individuals: not researched (search budget exhausted).
- **LinkedIn-based credibility strategies:** no practitioner data retrieved.
