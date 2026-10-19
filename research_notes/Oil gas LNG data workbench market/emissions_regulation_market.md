# Oil & Gas Emissions / Methane MRV: Regulations, Market Size and Software Tools (state as of 19 Oct 2026)

*Research note: compiled 19 October 2026. The shared web-search budget ran out partway through, so later evidence came from fetching known primary or vendor URLs directly and from GitHub repository search. Each fact below has an inline source. Where a fact comes from a secondary or vendor source, it says so. Items that could not be verified are listed under Gaps. Several regulatory items changed in the weeks before this note (EU postponement proposal of 14 Oct 2026; US Subpart W RY2025 deadline of 30 Oct 2026), so re-check them before publication.*

## 1. EU Methane Regulation (Regulation (EU) 2024/1787): timeline, operator and importer obligations, data/format, implementing acts status

### Takeaway
The EU Methane Regulation (EUMR) is the strictest methane MRV regime worldwide, and its operator obligations are already running in 2025–2026: LDAR, source-level reports, and the venting/flaring bans. The importer side is being softened and delayed. On 14 Oct 2026 the Commission proposed moving importer MRV-equivalence from 1 Jan 2027 to 31 May 2029, and shifting the methane-intensity dates by one year. Since July 2026 it has recommended a three-year penalty grace period for importers. Reporting templates exist only as a draft implementing regulation, published 9 Oct 2026. Data formats are therefore still unsettled.

### Cited Findings
**Entry into force and governance**
- The Commission's methane page says the regulation "entered into force" on 4 Aug 2024. The Commission's importer page gives 5 Aug 2024, so the official pages are inconsistent. — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en); [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)
- In 2025 the Commission set up an expert group, the "Network of National Competent Authorities", for implementation. The Methane Transparency Database is still described as being "prepared", with no launch date. — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)

**Operator obligations (oil & gas), from the regulation text (EU-law mirror site)**
- Art. 12(1): source-level methane estimates "using at least generic emission factors for all sources", due by 5 Aug 2025. — [LawPlayer mirror of 32024R1787](https://lawplayer.com/eu/act/32024R1787)
- Art. 12(2): source-level quantification by direct measurement where feasible, otherwise specific emission factors. Due by 5 Feb 2026 for operated assets and 5 Feb 2027 for non-operated assets. — [LawPlayer](https://lawplayer.com/eu/act/32024R1787)
- Art. 12(3): source-level quantification complemented by site-level measurement, with independent verification. Due by 5 Feb 2027 for operated assets and 5 Aug 2028 for non-operated assets, then "by 31 May every year thereafter". — [LawPlayer](https://lawplayer.com/eu/act/32024R1787)
- Art. 12(4) report content: emission source type and location; emissions in tonnes CH4 and CO2e; quantification methodologies. For non-operated assets: ownership share × emissions, plus the list of entities with operational control. The Commission is to set a reporting template by implementing act. — [LawPlayer](https://lawplayer.com/eu/act/32024R1787)
- Art. 12(5): until measurement standards are adopted under Art. 32, operators may use "the latest OGMP 2.0 technical guidance documents approved by 4 August 2024". — [LawPlayer](https://lawplayer.com/eu/act/32024R1787)
- The IEA summarises Art. 12 differently, as reports "within 18 months for operated assets and 30 months for non-operated assets" (a secondary summary). — [IEA policy database](https://www.iea.org/policies/18209-eu-regulation-on-the-reduction-of-methane-emissions-in-the-energy-sector)
- Art. 14 LDAR:
  - LDAR programme due by 5 May 2025 (new sites: within 6 months).
  - First type-2 survey due by 5 Aug 2025.
  - Repair thresholds: type 1 at 7,000 ppm or 17 g/h; type 2 aboveground at 500 ppm or 1 g/h.
  - Repair is immediate. If that is not possible, an attempt is due within 5 days and completion within 30 days. Re-survey within 45 days.
  - Records kept for ≥10 years; annual report.
  - Derogation where <1% of components leak and emissions are <0.08% of gas volume.
  - Source: [LawPlayer](https://lawplayer.com/eu/act/32024R1787)
  - The Commission's own summary page says instead that repairs are due "mostly within 5 or 15 working days". This conflicts with the article text as mirrored above. — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)
- Art. 15: venting is prohibited outside listed circumstances, and routine flaring is prohibited. Existing sites must comply "not later than 5 February 2026"; new sites within 12 months of start-up. — [LawPlayer](https://lawplayer.com/eu/act/32024R1787). A conventuslaw summary agrees on 5 Feb 2026 ([Conventus Law](https://conventuslaw.com/report/the-eu-methane-regulation-how-traders-and-operators-can-prepare/)). Reed Smith gives 5 Aug 2026, which conflicts ([Reed Smith](https://www.reedsmith.com/articles/eu-methane-regulation-application-lng-coal-mine-operators-importers/)).
- Art. 17 flaring: new or replaced flares need ≥99% destruction and removal efficiency by design, plus an auto-igniter or continuous pilot. Existing flares must comply by 5 Feb 2026. Inspections every 15 days; irregularities fixed within 6 hours. — [LawPlayer](https://lawplayer.com/eu/act/32024R1787)
- Penalties are set by Member States (Art. 33) and must be "effective, proportionate and dissuasive". They must not endanger security of supply, and their application can be delayed for that reason (Art. 33(2)). — [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)
- Reed Smith says administrative fines are "capped at 20 per cent of the annual turnover". Other sanctions include confiscation of profits, public warnings and periodic penalty payments. — [Reed Smith](https://www.reedsmith.com/articles/eu-methane-regulation-application-lng-coal-mine-operators-importers/)
- Verification: imported oil and gas counts as MRV-equivalent only with independent third-party verification by verifiers accredited under Regulation (EC) No 765/2008. — [Reed Smith](https://www.reedsmith.com/articles/eu-methane-regulation-application-lng-coal-mine-operators-importers/)

**Importer obligations (original legal timeline)**
- Scope: contracts "concluded or renewed" on or after 4 Aug 2024. Renewal includes changes to duration, price formula or volume, and automatic renewals with a new duration. — [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)
- Art. 27 / Annex IX information goes to the national competent authority each year:
  - Reporting dates: first report by 5 May 2025 (covering 5 Aug–31 Dec 2024); then 31 May 2026 (covering 2025) and 31 May 2027 (covering 2026).
  - Content: exporter and producer names and addresses; producer MRV measures; production location at subdivision level (NUTS-1 equivalent).
  - "No common reporting template is foreseen" for Art. 27. The information is published free of charge.
  - Source: [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)
- Art. 28 MRV equivalence, from 1 Jan 2027:
  - Producer-level equivalence is shown through OGMP 2.0 Level 5, or through monitoring and reporting equivalent to Art. 12.
  - Country-level equivalence needs a Commission implementing act on the procedure.
  - Pre-existing contracts carry a "reasonable efforts" duty.
  - Source: [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)
- Art. 29 methane intensity: a delegated act setting the methodology is due by 5 Aug 2027. Reporting applies from 5 Aug 2028, with no derogation. Maximum methane-intensity values apply to contracts concluded or renewed after 5 Aug 2030. — [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en); [Reed Smith](https://www.reedsmith.com/articles/eu-methane-regulation-application-lng-coal-mine-operators-importers/)

**2026 implementation developments**
- March 2026: the Commission published an importer "guidance tool", last updated 22 Sep 2026. — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)
- 20 Jul 2026: two Commission Recommendations. EU/2026/1834 gives optional model contract clauses and compliance solutions; using these does not exempt importers from Annex IX reporting. EU/2026/1835 covers penalties and asks Member States to refrain temporarily from penalising certain importer infringements. — [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en)
- The penalty grace period covers obligations taking effect in 2027–2029, except in cases of fraud (HSF Kramer summary as quoted in search results; the page itself returned 403). — [HSF Kramer, Aug 2026](https://www.hsfkramer.com/insights/2026-08/eu-methan-regulation-eu-commission-clarifies-compliance-options-and-recommends-three-year-penalty-grace-period)
- 9 Oct 2026: the Commission published a draft implementing regulation "adopting reporting templates", with a four-week feedback period. The related-links section dates the call to 12 Oct 2026. — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)
- 14 Oct 2026: the Commission proposed to "postpone by 1 year the implementation of reporting-related provisions", citing energy security amid Middle East market pressures. — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)
- Postponement detail (proposal only):
  - Importer MRV equivalence: 1 Jan 2027 → 31 May 2029.
  - Methane-intensity reporting for producers and importers: 5 Aug 2028 → 5 Aug 2029.
  - Maximum methane-intensity compliance: 5 Aug 2030 → 5 Aug 2031.
  - Stated reasons: high winter prices; strain from the Middle East conflict; importers' inability to secure compliant supply from 1 Jan 2027; time for Member States to finish penalty regimes, for accreditation of verifiers, and for assessment of compliance-solution providers.
  - The proposal goes through the ordinary legislative procedure (Parliament and Council).
  - Source: [Linklaters, Oct 2026](https://sustainablefutures.linklaters.com/post/102o5fh/european-commission-proposes-delaying-key-eu-methane-regulation-import-and-report)
- Conflicting reports on the postponement:
  - MLex describes the reporting delay as "12 months to January 2028". — [MLex](https://www.mlex.com/mlex/articles/2537643)
  - Industry bodies had asked for a three-year postponement, and a network of 50+ NGOs opposes any delay (per search-result snippets). — [Carbon Pulse](https://carbon-pulse.com/560457/); [S&P Global](https://www.spglobal.com/energy/en/news-research/latest-news/natural-gas/101426-ec-releases-proposal-to-delay-methane-import-requirements-by-one-year)
- The proposal amends Arts. 28 and 29. — [Lovguiden (EC press corner mirror)](https://www.lovguiden.dk/en/det-offentlige/eur-lex-kommissionsforslag/2026-10-14-kommissionen-foreslaar-et-aars-udskydelse-af-metankrav-til-importoerer)
- Consultancy view: suppliers in the US, Qatar, Norway and Algeria must reach EU-equivalent measurement to keep access. Suppliers relying on generic emission factors are at a commercial disadvantage. Contract tools include equivalence warranties, audit rights, data-delivery covenants and price-adjustment triggers. — [Landmark Global Partners OGEMEX brief, Jul 2026](https://www.landmarkglobalpartners.uk/ogemex-004-methane-import-mrv.html)

### Inferences
- The operator data model is already defined by Art. 12(4): source type, location, t CH4, t CO2e, methodology, ownership share, and the operator of non-operated assets. That makes it a concrete schema target for an import/QC/export tool, even before the final template is adopted.
- The Oct 2026 draft templates are the key format artefact to track. Once adopted, every EU operator (and later importers) will need data mapped into them. A "regulator-ready export" feature should be built around those templates and the OGMP Excel templates (see Q2).
- Art. 27 has no common template and the information becomes public. Importers must collect heterogeneous producer data from many suppliers, which suits a desktop data-wrangling and QC tool.
- Penalties are softened and dates are moving (as proposed). Demand for importer tools may slip by about 1–2 years. Operator-side obligations (Arts. 12, 14, 15, 17) are not in the proposal per the Linklaters summary, so operator demand continues.

### Gaps
- Not checked against EUR-Lex/Official Journal: EUR-Lex returned empty pages, so article dates come from a mirror site (LawPlayer) and law-firm summaries.
- The exact wording of the Art. 33 turnover cap. Reed Smith says "capped at 20%"; some summaries describe 20% as a minimum ceiling. Not verified.
- The content and format of the 9 Oct 2026 draft reporting-template implementing regulation (file type, fields) is not yet reviewed.
- Status of the implementing act on minimum detection limits and LDAR techniques (due 5 Aug 2025 per Reed Smith) and of the Art. 32 measurement standards: not confirmed.
- Whether the operator-side Art. 12(3) date (5 Feb 2027) is affected by the 14 Oct 2026 proposal is not confirmed. Linklaters lists only importer MRV and intensity items; the EC page speaks generally of "reporting-related provisions".

## 2. OGMP 2.0 (UNEP IMEO): Levels 1–5, membership, reporting cycle, data requirements, Level 5 reconciliation

### Takeaway
OGMP 2.0 is the de facto global methane-reporting framework. It had 153 member companies covering 42% of global oil and gas production (Dec 2025). Members report annually by 31 May using Excel templates, and must reach Level 4/5 for material operated assets within 3 years and non-operated assets within 5 years. The EU MR names OGMP 2.0 Level 5 as a route to importer MRV equivalence. Level 5 means reconciling Level 4 source-level inventories with independent site-level measurements, as an iterative annual process. The technology for this is covered by another researcher.

### Cited Findings
- Level definitions (OGMP 2.0 Starters Guide, April 2025):
  - L1: single consolidated emissions number per venture or asset.
  - L2: emissions by IOGP/Marcogaz emission categories, using generic emission factors.
  - L3: emissions by detailed source type, using generic emission factors.
  - L4: detailed source type using specific emission and activity factors (company-specific methods, direct measurement).
  - L5: L4 plus site-level measurement reconciliation, "integrating bottom-up source-level reporting (L4) with independent site-level measurements" on a representative sample of facilities, considering the uncertainty of both approaches.
  - Source: [OGMP 2.0 Starters Guide (PDF)](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf)
- Generic factor sets such as US EPA Subpart W, AP-42, NGSI, GERG and Carbon Limits MIST "are generally level 3 (though some sources may be level 4)". — [OGMP Starters Guide](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf)
- Reporting cycle: the annual report and optional revised implementation plan are due 31 May, covering the previous year. A joining year may be reported as "Year 0". — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions); [Starters Guide](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf)
- Data and format: reporting uses Excel (.xlsx) templates, with separate upstream and mid/downstream versions plus guidance documents. Data is split operated / non-operated, including JVs. Technical guidance documents cover source categories (leaks, pneumatics, compressors, flares, tanks, glycol dehydrators), with separate uncertainty and reconciliation guidance. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- Scope and materiality:
  - Assets making up 95% of total emissions (ranked using at least L3 estimates) are "material" and must reach L4/5. Assets below that are still reported.
  - Non-operated JVs with <5% equity are excluded (listed in an "excluded" tab).
  - Refineries, petrochemicals, end users and biogas plants are excluded.
  - Source: [Starters Guide](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf)
- Gold Standard: L4/5 for material operated assets within 3 years and non-operated within 5 years. "Gold Standard Pathway" status is possible earlier through an L1+ report, a per-asset implementation plan and a methane target. Status is lost if a report is missed, the target is missing, the plan path isn't met, or progress toward L5 stalls. — [Starters Guide](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf); [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- UNEP's role: UNEP reviews reports and plans and aggregates data into the annual OGMP 2.0 report, which is part of IMEO's annual report. Asset-level data stays confidential unless waived. IMEO cross-checks reports against satellites, studies and national inventories. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- Reconciliation:
  - Reconciliation is "an iterative annual process of investigation and should not be considered a one-off comparison between two independent values" (OGMP framework, via search snippet). — [OGMP 2.0 Reporting Framework](https://www.ogmpartnership.org/sites/default/files/documents/2025-04/OGMP_20_Reporting_Framework.pdf)
  - Satellites alone are insufficient for L5. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- Membership and progress (EDF analysis of OGMP disclosures, 2 Dec 2025):
  - 153 member companies covering 42% of global operated and non-operated production.
  - 31 operators report L5 for at least half of their reported emissions, up from 7 in 2023.
  - Non-operated-asset reporting is "underdeveloped".
  - Source: [EDF+Business, Leveling Up 2025](https://business.edf.org/insights/leveling-up-2025-lessons-from-ogmp-2-0-company-disclosures/)
- The average reporting level was unchanged at 3.6 in 2024 because new members joined at low levels. Long-standing members rose from 3.1 to 4.4. Methane intensity follows a "u-curve": it falls from L2 to L4 and rises at L5 as new sources are found. — [EDF Leveling Up 2025 PDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)
- EU link: OGMP 2.0 L5 is an accepted producer-level route to MRV equivalence under EUMR Art. 28. — [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en). The European Commission sits on the OGMP Steering Group. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- The guide lists free third-party tools, including "Mist by Carbon Limits – methane inventory tool". — [Starters Guide](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf)

### Inferences
- OGMP's official exchange format is an Excel template, and members include many NOCs and mid-size companies. A desktop tool that validates and fills OGMP .xlsx templates (L1–L4 calculations, materiality ranking, operated vs non-operated equity splits, and L5 reconciliation inputs) maps directly onto an existing annual workflow.
- The 31 May deadline is shared by OGMP and EUMR Art. 12(3) annual reports. This annual seasonal peak would benefit from a single data pipeline that exports to both.

### Gaps
- The official 2026 IMEO/OGMP annual report figures (latest member count, Gold Standard count) could not be fetched: the UNEP site returned 403 and the search budget ran out. A search snippet confirms an IMEO 2026 OGMP 2.0 report exists. — [Wikipedia: IMEO](https://en.wikipedia.org/wiki/International_Methane_Emissions_Observatory)
- The exact template tab and field structure was not reviewed.

## 3. United States (federal and states) and Canada: what changed in 2025–2026

### Takeaway
US federal methane policy was rolled back or deferred in 2025–2026:
- The Waste Emissions Charge rule was nullified (CRA, March 2025) and the charge deferred to 2034 emissions.
- OOOOb/c compliance dates were pushed to 22 Jan 2027.
- EPA proposed suspending Subpart W reporting until RY2034. As of mid/late Sept 2026 that was not final, so RY2025 Subpart W reports (under the expanded 2024 rule) are due 30 Oct 2026.

State rules (Colorado, New Mexico) and buyer/EU demands continue regardless. Canada finalised stricter federal methane regulations in Dec 2025 (main obligations 2028/2030), alongside provincial equivalency (Alberta order Nov 2025).

### Cited Findings
**Waste Emissions Charge (WEC)**
- The President signed the CRA joint resolution disapproving the WEC rule on 14 Mar 2025. The rule "no longer has any force of law". WEC filings due 2 Sep 2025 are not required. On 12 May 2025 EPA removed the WEC regulations from the CFR. — [EPA WEC page](https://www.epa.gov/inflation-reduction-act/waste-emissions-charge)
- The statutory charge remains, but Congress delayed it through Clean Air Act revisions: fees would first be assessed on 2034 reported emissions, payable March 2035 (secondary source). — [Onterris, 2026](https://www.onterris.com/our-thinking/federal-methane-rules-in-2026-what-oil-and-gas-operators-need-to-do-now)

**NSPS OOOOb / EG OOOOc**
- A July 2025 interim final rule extended many OOOOb dates to 22 Jan 2027, except the net heating value (NHV) monitoring requirements. The OOOOc state-plan deadline also moved to 22 Jan 2027. — [ALL4](https://www.all4inc.com/4-the-record-articles/u-s-epa-extends-compliance-deadlines-for-oil-and-natural-gas-sector/); [Cimarron](https://cimarron.com/blog/epa-extends-nsps-oooob-c-compliance-deadlines-what-operators-need-to-know/)
- A final rule (reported as Nov 2025) kept the extensions. A final rule published 9 Apr 2026 made "discrete technical changes" to temporary associated-gas flaring and vent-gas NHV monitoring (per search snippets). — [ALL4 final](https://www.all4inc.com/4-the-record-articles/u-s-epa-finalizes-oil-and-gas-compliance-deadline-extension/); [Harvard EELP tracker](https://eelp.law.harvard.edu/tracker/epa-voc-and-methane-standards-for-oil-and-gas-facilities-2/)
- Key dates per one secondary summary:
  - 1 Jun 2026: NHV continuous monitoring.
  - 30 Nov 2026: initial annual report.
  - 22 Jan 2027: TOC testing; no-identifiable-emissions inspections; zero-emission controllers; storage vessel determinations; super-emitter program; OOOOc state plans.
  - Source: [Onterris](https://www.onterris.com/our-thinking/federal-methane-rules-in-2026-what-oil-and-gas-operators-need-to-do-now)
- In Feb 2026 EPA finalised repeal of the 2009 GHG endangerment findings. Stationary-source GHG rules stay in effect until separately changed (secondary source). — [Onterris](https://www.onterris.com/our-thinking/federal-methane-rules-in-2026-what-oil-and-gas-operators-need-to-do-now)

**GHGRP Subpart W**
- The 2024 Subpart W revisions apply to calendar-year 2025 data. They add source categories, new emission factors, and use of measurement-based data where available. — [Onterris](https://www.onterris.com/our-thinking/federal-methane-rules-in-2026-what-oil-and-gas-operators-need-to-do-now)
- The RY2025 deadline was extended from 31 Mar to 30 Oct 2026 (final rule, 91 FR 9712, Feb 2026). — [Federal Register](https://www.federalregister.gov/documents/2026/02/27/2026-03995/extending-the-reporting-deadline-under-the-greenhouse-gas-reporting-rule-for-2025); [TetraSoft, updated 22 Sep 2026](https://tetrasoftco.com/blog/ghgrp-subpart-w-still-required-2026/)
- Sept 2025 proposal (90 FR 44591):
  - Reconsiders 46 of 47 GHGRP source categories (reporting would end after RY2024).
  - Suspends Subpart W for 9 segments "until 2034" and ends natural gas distribution after RY2024.
  - As of 15 Sep 2026, not finalised and no further deadline extension.
  - Source: [Gable Gotwals alert, 15 Sep 2026](https://www.gablelaw.com/news-articles-blogs/client-alerts/environmental-alert-epas-greenhouse-gas-reporting-program-remains-in-effect-despite-proposed-rollback/); [EPA proposal fact sheet](https://www.epa.gov/system/files/documents/2025-09/reconsideration-of-ghgrp-proposal-fact-sheet.pdf)
- EPA received more than 53,000 comments on the proposal. — [Onterris](https://www.onterris.com/our-thinking/federal-methane-rules-in-2026-what-oil-and-gas-operators-need-to-do-now)
- Threshold is 25,000 t CO2e/yr; Subpart W covers 10 segments. Submission goes through e-GGRT. EPA provides reporting instructions, an Applicability Tool and an Oil and Gas dashboard. — [EPA Subpart W page (updated 7 May 2026)](https://www.epa.gov/ghgreporting/subpart-w-petroleum-and-natural-gas-systems)
- Records must be kept ≥3 years: GHG Monitoring Plan, measurement data, calibration, calculation inputs and outputs, missing-data substitutions. Revisions are due within 45 days of finding a substantive error. — [TetraSoft](https://tetrasoftco.com/blog/ghgrp-subpart-w-still-required-2026/)

**States**
- Colorado (ONGAEIR): annual facility-level inventory due to CDPHE by 30 June, regardless of GHGRP. Regs 3 and 7 were revised (adopted 22 May 2026, effective 15 Jul 2026), and the annual submission is now an "Emissions Reporting Notice". From 1 Jan 2027 it also satisfies certain APEN revisions. Site-specific pneumatic factors must be re-verified every five years. — [TetraSoft, 17 Sep 2026](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)
- New Mexico:
  - OCD rule 19.15.27 NMAC requires 98% gas capture by 31 Dec 2026.
  - NMED ozone precursor rule 20.2.50 NMAC applies.
  - Proposed methane abatement rule 20.2.51 NMAC: petition filed 13 Aug 2026; hearing from 1 Dec 2026; would add a super-emitter program and zero-methane process controllers from 1 Jan 2031.
  - Source: [TetraSoft](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)
- European buyers are requesting methane-intensity documentation from US LNG suppliers. — [TetraSoft](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)
- Example of technology approvals: EPA approved Kuva's camera as an Alternative Test Method for OOOOa/b periodic screening, with Colorado AIMM and New Mexico ALARM approvals (vendor claim). — [Kuva Systems](https://www.kuvasystems.com/)

**Canada**
- SOR/2025-280 was registered 12 Dec 2025 and published in Canada Gazette II on 31 Dec 2025. It amends the upstream methane/VOC regulations:
  - Coverage extends to onshore upstream facilities generally, not just those handling >60,000 m³/yr.
  - Part 1 is a prescriptive pathway; Part 2 is an optional performance-based pathway using an emission monitoring system.
  - Source: [Canada Gazette II, SOR/2025-280](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)
- Dates:
  - Most Part 1 fugitive requirements, Part 2 and registration apply from 1 Jan 2028. Registration is due within 120 days.
  - Venting and destruction requirements for existing facilities apply from 1 Jan 2030.
  - A supplementary registration notice is due by 30 Apr 2028.
  - Source: [SOR/2025-280](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)
- Part 1 requirements:
  - Comprehensive inspections: quarterly for Type 1 facilities, annually for Type 2.
  - Monthly screening (detects ≥10 kg/h).
  - Annual independent-auditor inspection (≥90% probability of detecting ≥10 kg/h).
  - Repairs: within 24 h for ≥100 kg/h, 7 days for 10–100 kg/h, up to 90 days for <1 kg/h.
  - Venting is prohibited except for listed cases; the legacy oil-site cap is 12,000 m³/yr.
  - Combustion needs ≥98% efficiency.
  - Source: [SOR/2025-280](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)
- Part 2 requirements:
  - Intensity must be below the reference: 0.2% of gas produced, 0.05% processed, 0.11% transported.
  - Sensor readings every 15 minutes (Type 1) or every 12 hours.
  - Annual report to the Minister by 30 June.
  - Source: [SOR/2025-280](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)
- The regulation imposes no specific reduction target. The government commitment is "at least a 75% reduction in oil and gas sector methane emissions by 2030, relative to 2012". Offshore facilities are removed from the regulation because of the CNL/CNS offshore frameworks. Estimated 2028–2040 figures: costs C$14.6B, benefits C$38.6B, 304 Mt CO2e reduced; about 22,000 oil-producing sites in 2030. — [SOR/2025-280](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)
- Alberta: a new equivalency agreement was negotiated. The final Order standing down the federal rules in Alberta was published 5 Nov 2025 (SOR/2025-213). New equivalency agreements were signed with Alberta, Saskatchewan and British Columbia in late 2024–2025. — [Canada Gazette II SOR/2025-213](https://gazette.gc.ca/rp-pr/p2/2025/2025-11-05/html/sor-dors213-eng.html); [SOR/2025-280](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)
- One law firm notes the amendments require equivalency reassessment. Without new agreements, provincial facilities would likely face the federal rules in 2028 (via search snippet; page returned 403). — [Lawson Lundell](https://www.lawsonlundell.com/publication/federal-government-finalizes-major-amendments-to-methane-regulations-for-upstream-oil-and-gas-facilities)

### Inferences
- US demand for compliance tooling is moving from federal reporting (paused or uncertain) to state inventories, buyer/LNG export certification and EU equivalence. Tools must handle several overlapping methodologies at once (Subpart W vs Colorado vs New Mexico), with crosswalks.
- Canada's 2028 start, monitoring-system data (15-minute readings) and annual reports to ECCC will create new data volumes and QC needs for Canadian operators from 2027–2028.
- Regulatory churn (deadlines moved several times in 2025–2026) is itself a buying criterion: rule-packs must be easy to update or version.

### Gaps
- California: CARB oil and gas methane regulation status and the SB 253/261 climate disclosure laws were not researched; no sources fetched.
- Pennsylvania and other states not covered.
- Whether the WEC 2034 deferral came from the July 2025 reconciliation act (OBBBA) is not confirmed from a primary source; only Onterris was seen.
- The e-GGRT file format (XML schema vs web forms) is not confirmed from EPA pages.
- Whether EPA finalised the Subpart W suspension between 22 Sep and 19 Oct 2026 is not checked.

## 4. Other regions: UK, Norway, Middle East/GCC, Africa (Nigeria), Asia-Pacific; global initiatives (World Bank ZRF, Global Methane Pledge)

### Takeaway
Global flaring rose to 167 bcm in 2025 (World Bank, June 2026). Nine countries (Russia, Iran, Iraq, Venezuela, Mexico, Libya, Algeria, Nigeria, US) account for 83% of it. The Global Methane Pledge has about 159 countries plus the EC. Industry coalitions (OGCI: 0.12% upstream intensity in 2024) target near-zero methane and zero routine flaring by 2030. Supplier countries for EU imports (US, Qatar, Norway, Algeria) face EU-equivalent MRV pressure. Verified 2025–2026 national-rule detail for the UK, Norway, the GCC, Nigerian penalties and Japan/Korea buyer requirements could not be obtained in this session (see Gaps).

### Cited Findings
**Global**
- In 2025, "167 billion cubic meters (bcm) of associated gas was flared" at upstream facilities and LNG plants (GFMR Global Gas Flaring Tracker, June 2026). Estimates use NOAA VIIRS satellite data with the Payne Institute, calibrated with Cedigaz country data. A flaring-intensity dataset by economy (2012–2025) and an "Imported Flare Gas Index" are published. — [World Bank Global Flaring Data](https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data)
- The top flaring countries in 2024 were Russia, Iran, Iraq, Venezuela, Mexico, Libya, Algeria, Nigeria and the US: together 83% of gas flared but less than half of global oil output. — [World Bank Global Flaring Data](https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data)
- Global Methane Pledge: "159 participating countries and the European Commission" (the participant list says 160). Target is at least 30% below 2020 levels by 2030, globally. At COP30 (25 Nov 2025), US$278M of new methane abatement funding was announced. — [Global Methane Pledge](https://www.globalmethanepledge.org/)
- The EU and Canada, as GMP co-convenors, welcomed the UN Secretary-General's Call to Action on methane on 23 Jun 2026. — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)
- OGCI (12 large oil and gas companies):
  - Ambition of "well below 0.20%" upstream methane intensity; 2024 result 0.12%.
  - 0.73 Mt upstream operated methane in 2024; −63% since 2017; routine flaring −72% since 2018.
  - Aims for near-zero methane and zero routine flaring by 2030.
  - Satellite Methane Detection Response Playbook launched 19 Nov 2025; collaboration with Carbon Mapper announced 3 Mar 2026.
  - Source: [OGCI methane hub](https://www.ogci.com/methane-emissions)
- The IEA's Global Methane Tracker 2026 exists (listed on the GMP site). Its contents were not accessible (IEA returned 403). — [Global Methane Pledge](https://www.globalmethanepledge.org/)

**Europe (non-EU) / EU supplier countries**
- The US, Qatar, Norway and Algeria are named as non-EU suppliers that must reach EU-equivalent methane measurement (consultancy view). — [Landmark Global Partners, Jul 2026](https://www.landmarkglobalpartners.uk/ogemex-004-methane-import-mrv.html)

**Middle East / Caspian**
- Baker Hughes signed an agreement with Halfaya Gas Company (Iraq) on 16 Sep 2025 to advance a flare-reduction project. Its emissions-abatement solution was chosen for SOCAR's Baku refinery to cut routine flaring (vendor page). — [Baker Hughes Emissions Abatement](https://www.bakerhughes.com/emissions-abatement)
- Iran, Iraq and Libya are among the top-9 flaring countries. — [World Bank](https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data)

**Africa**
- Nigeria: the Nigerian Gas Flare Commercialisation Programme (NGFCP) was relaunched to drive "zero routine flaring within this decade". It offers flare sites to third-party investors by competitive bid. NUPRC announced successful bidders on 4 Oct 2023. The federal government committed to a national flare-out target by 2025 and to the GGFR principles for flare-out by 2030. — [NGFCP portal (NUPRC)](https://ngfcp.nuprc.gov.ng/)
- Nigeria, Algeria and Libya are among the top-9 flaring countries. — [World Bank](https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data)

**Asia-Pacific**
- Australia Safeguard Mechanism (page updated 4 Sep 2026):
  - Covers facilities emitting >100,000 t CO2e Scope 1, including oil and gas production.
  - Data comes from NGER reporting.
  - Facilities below baseline earn Safeguard Mechanism Credit Units; the compliance deadline is 1 April.
  - The policy settings will be reviewed in 2026–27.
  - Source: [Clean Energy Regulator](https://cer.gov.au/schemes/safeguard-mechanism)
- SLB launched its first continuous methane-monitoring project in Asia (Thailand) per its 2025 sustainability report. — [SLB 2025 Sustainability Report update](https://www.slb.com/newsroom/updates/2026/update-2026-0312-sustainability-report)
- Envana lists PETRONAS and PTTEP among its references (vendor claims). — [Envana OGMP](https://www.envana.com/ogmp/)

### Inferences
- The Middle East, Africa and Asia hold most global flaring and many NOCs. The market here is driven more by OGMP membership, EU/Asian buyer requirements and flaring programmes (ZRF, NGFCP) than by detailed national MRV law. NOCs are often cautious about putting operational data in foreign clouds, which fits an offline/on-prem workbench. This is an untested hypothesis.
- The flaring-intensity dataset and Imported Flare Gas Index show buyers can increasingly benchmark suppliers with public satellite data. Producers need defensible metered flare data to answer such benchmarks.

### Gaps (not verified this session; search budget exhausted and several official sites returned 403/404)
- UK: NSTA flaring and venting consent and reporting rules, the zero-routine-flaring-and-venting 2030 expectation, and the 2025/2026 Emissions Monitoring Report figures. The NSTA URL returned 404.
- Norway: flaring permit regime, CO2 and NOx taxes, methane reporting (Norwegian Offshore Directorate / Norwegian Environment Agency). Not researched.
- Saudi Arabia, UAE (ADNOC near-zero methane target), Qatar (QatarEnergy methane intensity target), Oman: national targets and reporting systems not verified.
- Nigeria: the Flare Gas (Prevention of Waste and Pollution) Regulations 2018 penalty rates, the 2023 NUPRC methane guidelines, and 2024–2026 NGFCP award status are not verified.
- Japan/Korea: buyer requirements (e.g., the JERA/KOGAS/JOGMEC-linked CLEAN initiative) are not verified.
- Australia: 2025 NGER method changes for fugitive methane are not verified.
- World Bank ZRF endorser count and the 2024→2025 change. The 2024 figure of 151 bcm comes from the WebFetch model's own context, not the fetched page, so treat it as unverified.
- Oil & Gas Decarbonization Charter signatory count is not verified.

## 5. Market size and growth: emissions management / carbon accounting software and methane monitoring

### Takeaway
Market-size estimates are highly inconsistent and mostly come from low-transparency syndicated publishers. "Emissions management software" estimates range from about US$1.5B to $21.8B for 2025. The most credible analyst figure (Verdantix) puts the narrower carbon management software market at $744M in 2025, growing at 15% CAGR to about $1.8B by 2031, with regulatory softening as a headwind. Methane-monitoring estimates (hardware plus services plus software) cluster at about $2.5–4.8B in 2025, with oil and gas the largest end-use (~45%). Software is about 31.5% of that and is the fastest-growing segment (all publisher estimates, flagged).

### Cited Findings
- **Verdantix, carbon management software (higher credibility; independent analyst):**
  - $744M in 2025, 15% CAGR to almost $1.8B in 2031.
  - "Softening of regulatory requirements will create headwinds", partly offset by supply-chain demand in Asia and Europe.
  - The earlier 2023–2029 forecast put 2023 at more than $557M with 19% CAGR; a March 2025 webinar projected $1.6B by 2029.
  - Source: [Verdantix 2025–2031 forecast](https://www.verdantix.com/insights/report/market-size-and-forecast--carbon-management-software-2025-2031-global); [Verdantix 2023–2029](https://www.verdantix.com/report/market-size-and-forecast-carbon-management-software-2023-2029); [Verdantix webinar](https://www.verdantix.com/insights/webinar/carbon-management-software-navigating-an-evolving-market)
- **Precedence Research, "emission management software" (low credibility):**
  - $21.79B in 2025 → $78.72B by 2034, 15.38% CAGR; North America largest in 2024; Asia-Pacific fastest-growing.
  - The page is internally inconsistent: $25.21B is labelled both 2025 and 2026, and the base year is given as both 2024 and 2025.
  - Its company list (e.g., Symantec, Carbonetworks) suggests outdated or boilerplate content. No oil and gas share or cloud/on-prem split is given.
  - Source: [Precedence Research](https://www.precedenceresearch.com/emission-management-software-market)
- **Other syndicated emissions-management-software estimates** (unclear which publisher gave which figure; search summary only):
  - About $1.5B (2025, 16.5% CAGR to 2034); $11.46B (2025, 18.3% CAGR to 2035); $19B (2025, 16% CAGR to 2035).
  - Source: [Market Research Future](https://www.marketresearchfuture.com/reports/emission-management-software-market-41142); [Research Nester](https://www.researchnester.com/reports/emissions-management-software-market/3226); [Dataintelo](https://dataintelo.com/report/global-emission-monitoring-software-market); [Verified Market Reports](https://www.verifiedmarketreports.com/product/emission-management-software-market/)
- **Methane monitoring/emissions monitoring (publisher estimates; attribution inferred from report titles in search results):**
  - $4.8B in 2025 → $11.6B by 2034 (10.3% CAGR), likely Dataintelo. — [Dataintelo methane monitoring](https://dataintelo.com/report/methane-emissions-monitoring-market)
  - $4.18B in 2025 → $8.90B by 2035 (7.9% CAGR), likely CMI. — [Custom Market Insights](https://www.custommarketinsights.com/report/methane-monitoring-market/)
  - Methane monitors about $2.5B in 2026 (6.2% CAGR to 2035). — [IndexBox](https://www.indexbox.io/blog/methane-monitors-market-forecast-to-2035-growth-driven-by-oil-and-gas-emissions-compliance/)
  - Oil and gas is the largest application at 45.6% share in 2025. Software was about 31.5% of methane-monitoring revenue in 2025, growing at 13.7% CAGR to 2034. Exact publisher unclear; it appears in the Dataintelo/CMI results.
- Broader oil and gas software: $38.6B in 2025, 7.5% CAGR 2026–2034 (publisher estimate). — [Dataintelo oil & gas software](https://dataintelo.com/report/global-oil-gas-software-market)
- Proxy for compliance spend: Canada estimates C$14.6B in compliance costs for its methane rules over 2028–2040. — [SOR/2025-280](https://gazette.gc.ca/rp-pr/p2/2025/2025-12-31/html/sor-dors280-eng.html)

### Inferences
- For a market study, Verdantix's ~$0.74B (2025) carbon-management-software figure is the most defensible anchor for the software category. The oil-and-gas methane/flaring MRV software niche is a subset, plausibly in the low hundreds of millions of dollars. This is an inference, not a sourced number.
- The $10–20B+ "emission management software" figures likely bundle CEMS hardware, services and broad EHS. They should not be used as an addressable market for a desktop data workbench.
- Growth drivers are uneven by region. The EU and Canada are tightening (with delays). The US federal side is softening while state and buyer demand continues. Verdantix explicitly flags regulatory softening.

### Gaps
- No credible, methodology-transparent sizing specific to oil and gas methane/flaring MRV software was found. Rystad, Wood Mackenzie, IDC and Verdantix oil-and-gas-specific reports were not accessed.
- No regional splits from a credible source.
- No cloud vs on-prem deployment share from a credible source.

## 6. Commercial tools: capabilities, pricing/deployment, gaps

### Takeaway
The commercial landscape splits into three groups:
- **Methane-specialist platforms** (Highwood EIP, Envana OGMP module, Validere, Project Canary, Bridger Command) that ingest multi-sensor measurement data and produce OGMP 2.0 / EUMR / Veritas / MiQ / Subpart W / Colorado outputs.
- **Monitoring-hardware vendors with dashboards** (Kuva, now part of Sensirion; Nevada Nano; SLB; Baker Hughes Panametrics).
- **Broad EHS/ESG/carbon-accounting suites** (Sphera, Enablon, Cority, Persefoni) that are generally not oil-and-gas-methane specific.

Every vendor page reviewed points to hosted web portals ("login", "deploy in weeks"). None advertises offline or desktop deployment. Pricing is almost never published; the exception is Persefoni's free single-user tier.

### Cited Findings
- **Highwood Emissions Management (EIP):**
  - Methane-focused platform for oil and gas.
  - Ingests LDAR, CEMS, OGI, satellite, aerial, drone and custom formats.
  - Automates top-down/bottom-up reconciliation and uncertainty.
  - Reports for OGMP 2.0, EUMR, Veritas, MiQ and CDPHE Reg 7; Subpart W is not mentioned on the page.
  - "Most clients deploy in weeks"; web sign-in; no pricing; "trusted by super-majors"; partnership with Bridger Photonics.
  - Source: [Highwood platform](https://www.highwoodemissions.com/platform/)
- **Envana:**
  - OGMP module to "calculate and track OGMP 2.0 Sources from Level 3 to Level 5".
  - Automated sensor-data ingestion, source vs site comparison with root-cause analysis, verification-ready outputs.
  - Catalyst module covers Scope 1–3.
  - Cited users: PETRONAS, PTTEP, Aker BP, Coastal Bend LNG. Headlines reference a Halliburton / Siguler Guff JV.
  - Deployment and pricing not stated.
  - Source: [Envana OGMP](https://www.envana.com/ogmp/)
- **Validere:**
  - "One foundation for emissions reporting": regulatory air/GHG and voluntary reporting, emissions assurance/verification, volumetric measurement and accounting.
  - AI anomaly detection with human approval.
  - Integrations: GHGSat, Snowflake, Databricks, SAP, Oracle, IBM Maximo, Power BI, Tableau, ProdView Go.
  - SOC 2 Type II and ISO 27001.
  - Claims one client cut reporting spend by >$460K and 2,300+ hours were saved.
  - Offices in Houston, Calgary, Toronto. No pricing.
  - Source: [Validere](https://www.validere.com/)
- **Project Canary:**
  - Recon (vehicle-mounted mid-IR mobile leak detection), Pico (handheld methane/ethane), Sense (workflow), Carbon Portal (emissions reporting).
  - Platform ingests sensors, satellites, flights, SCADA and field data.
  - "Defensible emissions reporting for OGMP 2.0 and Subpart W".
  - Footer links Aeris Technologies (relationship unexplained). No pricing.
  - Source: [Project Canary](https://www.projectcanary.com/)
- **Kuva Systems:**
  - Continuous OGI camera plus dashboard; EPA Alternative Test Method approval (OOOOa/b).
  - Supports OGMP L4/L5 (L5 tied to Veritas Pathway 3).
  - Now part of Sensirion Connected Solutions; claims payback under 6 months.
  - Business model not stated.
  - Source: [Kuva Systems](https://www.kuvasystems.com/)
- **Bridger Photonics:** "Bridger Command" emissions management platform plus aerial LiDAR measurement packages for OGMP L4/L5. — [Bridger OGMP page](https://www.bridgerphotonics.com/solutions/ogmp-2.0-methane-compliance)
- **Nevada Nano (MethaneTrack):** continuous monitoring hardware and analytics for OGMP L4/L5 data. — [Nevada Nano](https://nevadanano.com/achieving-ogmp-2-0-gold-standard-with-methanetrack/)
- **SLB:**
  - In 2025, folding methane detection technologies into one continuous-monitoring portfolio.
  - Mobile methane LiDAR used on produced-water tanks in the US; first Asian continuous project in Thailand.
  - Its IoT methane point instrument dates from 2023.
  - Source: [SLB 2025 Sustainability Report](https://www.slb.com/newsroom/updates/2026/update-2026-0312-sustainability-report); [Offshore Energy](https://www.offshore-energy.biz/slb-unveils-plug-and-play-methane-monitoring-tool-for-oil-gas-ops/)
- **Baker Hughes:**
  - Panametrics flare management (ultrasonic flare flow meters, flare.IQ), System 1 with PEMS, Cordant digital platform, no-bleed valves.
  - 2025 bp flare-emissions monitoring milestone; Halfaya (Iraq) flare reduction (16 Sep 2025); signatory to Methane Guiding Principles.
  - Source: [Baker Hughes](https://www.bakerhughes.com/emissions-abatement)
- **Persefoni:**
  - "Persefoni Pro is completely free": one user, Scope 1–3, report builder for CSRD/ISSB/CDP.
  - Advanced tier by demo (unlimited users, ledger, audit trail, APIs, SOC 1/2, ISO 27001).
  - No methane, OGMP or Subpart W features mentioned.
  - Source: [Persefoni pricing](https://www.persefoni.com/pricing)
- **Sphera:** Air/GHG Emissions Management Software under "Environmental Accounting", plus Control of Work and PSM tools. Its oil and gas page does not mention methane, OGMP, Subpart W or LDAR. — [Sphera Oil & Gas](https://sphera.com/industries/oil-and-gas/)
- **Bureau Veritas / other service-led options:** AIRMO offers site-assessment services bridging L4→L5 (not software). — [AIRMO](https://www.airmo.io/ogmp-2-0-gold-standard)
- **TetraSoft:** a US Subpart W/state compliance vendor publishing guidance blogs. Note its articles are vendor content. — [TetraSoft](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)

### Inferences
- No reviewed vendor positions itself as an offline/desktop or air-gapped tool. That is a possible whitespace for NOCs, offshore or remote sites, consultants and verifiers. It still needs validation through customer interviews.
- Specialist platforms emphasise measurement ingestion and reconciliation (L4/L5). Fewer emphasise the import → QC → transform → export-to-regulator-template workflow across many regimes (EUMR template, OGMP xlsx, e-GGRT, Colorado ERN, Canada registration and annual report), which a workbench could own.
- Pricing opacity (demo-only) suggests enterprise SaaS contracts. A transparent, perpetual or desktop licence could differentiate for smaller operators and consultants.

### Gaps
- No direct evidence gathered on Enablon (403), Cority, Honeywell, Emerson or AVEVA emissions products and pricing.
- No independent user reviews or complaints (G2/Capterra/forums) were collected; search budget exhausted.
- SaaS pricing levels for any methane platform were not found.
- Ownership and status details (Envana–Halliburton JV terms; Project Canary–Aeris relationship) not verified.

## 7. Open-source tools, datasets and factor libraries; limitations

### Takeaway
Free or open resources exist but are fragmented:
- Calculators and models: OPGEE (Excel v3.0b; Python v4 on GitHub), LDAR-Sim (Python, open-source LDAR simulator), Carbon Limits MIST.
- Templates: the OGMP Excel templates and technical guidance documents.
- Public datasets: Climate TRACE (asset-level, satellite/AI), World Bank/VIIRS flaring data, EPA GHGRP data and tools.

None of these is a regulator-ready reporting workbench. Generic factor libraries (Subpart W, AP-42, etc.) only reach OGMP Level 3.

### Cited Findings
- **OPGEE (Stanford):**
  - Engineering-based LCA of crude oil GHG intensity from exploration to refinery gate.
  - Stable public release v3.0b (Excel, 14 May 2022). Development versions are "not for citation or distribution". No licence stated on the page.
  - Source: [Stanford EAO OPGEE](https://eao.stanford.edu/research-project/opgee-oil-production-greenhouse-gas-emissions-estimator)
  - A Python OPGEE v4 repository exists on GitHub (licence "Other"; last push 17 Jun 2026). An older MATLAB repo also exists. — [GitHub msmasnadi/OPGEEv4](https://github.com/msmasnadi/OPGEEv4); [GitHub arbrandt/OPGEE](https://github.com/arbrandt/OPGEE)
- **LDAR-Sim:** an open-source Python simulator for LDAR programmes, actively maintained (updated Oct 2026). A third-party repo used it to model EPA's proposed methane rules. — [GitHub LDAR-Sim/LDAR_Sim](https://github.com/LDAR-Sim/LDAR_Sim); [GitHub c-vollrath/EPA_Modeling_Parameters](https://github.com/c-vollrath/EPA_Modeling_Parameters)
- **Carbon Limits MIST:** a free methane inventory tool listed by OGMP. Generic sets (Subpart W, AP-42, NGSI, GERG, MIST) are "generally level 3". — [OGMP Starters Guide](https://www.ogmpartnership.org/sites/default/files/resources/2025-04/OGMP%202.0%20Starters%20Guide.pdf)
- **OGMP templates and guidance:** Excel templates (upstream and mid/downstream), technical guidance documents per source, and uncertainty/reconciliation guidance, free to members. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- **Climate TRACE:**
  - Not-for-profit coalition using satellites, remote sensing and AI.
  - About 745 million emitting assets; 10 sectors and 67 sub-sectors; data 2015–2025, monthly since 2021.
  - Release 5.11.0 added monthly data through July 2026. Free "Open Data".
  - The homepage gives no licence, uncertainty or accuracy metrics.
  - Source: [Climate TRACE](https://climatetrace.org/)
- **World Bank GFMR flaring data:** VIIRS satellite flare volumes, flaring intensity by economy (2012–2025), Imported Flare Gas Index. Counts only heat sources above 1,100°C, and flare misidentification can occur. — [World Bank](https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data)
- **EPA:** e-GGRT reporting system; Subpart W reporting instructions; Applicability Tool; Oil and Gas dashboard and published facility data. — [EPA Subpart W](https://www.epa.gov/ghgreporting/subpart-w-petroleum-and-natural-gas-systems)
- **Industry guidance:** OGCI Satellite Methane Detection Response Playbook (19 Nov 2025). — [OGCI](https://www.ogci.com/methane-emissions)

### Inferences
- The open ecosystem offers models and datasets, but not an operator-grade workflow: import from SCADA/LDAR/lab spreadsheets, QC rules, audit trail, export to regulator templates. An offline workbench could embed open factor libraries and reference datasets (GHGRP, Climate TRACE, flaring intensity) for benchmarking and plausibility checks.
- Licensing of OPGEE v4 ("Other") and Climate TRACE needs legal review before embedding.

### Gaps
- API Compendium (2021 edition), IPCC EFDB, the Marcogaz/IOGP factor documents and their licence terms were not verified.
- IMEO open data products (e.g., Eye on Methane data portal, MARS alerts) not fetched (403).
- Carbon Mapper / GHGSat public data portals and the status of EDF's MethaneSAT not verified.

## 8. Practitioner pain points in data collection, QC and reporting

### Takeaway
The documented pain points come from consultancy/vendor sources and EDF analysis, not forums (forum research was not possible this session):
- conflicting methodologies across regimes (Subpart W vs Colorado vs New Mexico; OGMP vs EUMR) requiring crosswalks
- heavy record-keeping and audit-trail requirements
- non-operated/JV data access
- changing rules and dates
- measurement data raising inventories (the u-curve)
- importers collecting heterogeneous producer data without a common template

### Cited Findings
- Colorado, New Mexico and Subpart W calculate overlapping sources (e.g., pneumatic controllers) differently, so operators need a methodology crosswalk. Other risks:
  - Data gaps if collection pauses during the federal suspension.
  - "Reconstruction risk" if Subpart W returns.
  - Missed state deadlines while waiting for federal clarity.
  - Five-year re-verification of site-specific factors in Colorado.
  - Teams that used Subpart W-format pipelines for state reporting may stop maintaining them.
  - Source: [TetraSoft, 17 Sep 2026](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)
- State submissions still require equipment counts, throughput, gas composition and operating hours. Methodology choices and assumptions must be documented "in a retrievable format". — [TetraSoft](https://tetrasoftco.com/blog/subpart-w-suspension-state-rules-still-apply/)
- Subpart W record set: monitoring plan, measurement data, calibration reports, calculation inputs and outputs, missing-data substitutions, kept ≥3 years. Substantive errors must be corrected within 45 days. — [TetraSoft](https://tetrasoftco.com/blog/ghgrp-subpart-w-still-required-2026/)
- EUMR LDAR records must be kept ≥10 years, with annual reports. — [LawPlayer](https://lawplayer.com/eu/act/32024R1787)
- OGMP: non-operated (JV) reporting is "underdeveloped". Companies need clearer explanation of methodologies, boundary changes and mitigation outcomes. Aerial, drone and mobile surveys "regularly detect emissions that LDAR missed", raising reported totals. — [EDF+Business](https://business.edf.org/insights/leveling-up-2025-lessons-from-ogmp-2-0-company-disclosures/)
- EU importers face retroactive reach (contracts signed from 4 Aug 2024), suppliers lacking L5/equivalent MRV, and "moving targets" as delegated and implementing acts are still being written. — [Landmark Global Partners](https://www.landmarkglobalpartners.uk/ogemex-004-methane-import-mrv.html)
- No common Art. 27 template exists; all information is defined only in Annex IX. — [EC importer page](https://energy.ec.europa.eu/methane-regulation-import-requirements_en). The Commission's Oct 2026 draft templates aim "to simplify and streamline the reporting process" (EC page, via search snippet). — [EC Methane emissions page](https://energy.ec.europa.eu/topics/carbon-management-and-fossil-fuels/methane-emissions_en)
- Vendor framing of the status quo:
  - Validere markets reduced "manual environmental workflows" (2,300+ hours saved). A Secure Energy quote cites fewer manual-entry errors.
  - Highwood markets automated reconciliation and uncertainty.
  - These are vendor claims that imply heavy reliance on spreadsheets and manual processes.
  - Source: [Validere](https://www.validere.com/); [Highwood](https://www.highwoodemissions.com/platform/)
- The Commission's rationale for the 2026 postponement includes time needed for Member States' penalty regimes, accreditation of verifiers, and assessment of compliance-solution providers. The verification ecosystem itself is immature. — [Linklaters](https://sustainablefutures.linklaters.com/post/102o5fh/european-commission-proposes-delaying-key-eu-methane-regulation-import-and-report)

### Inferences
- The strongest product hooks for an offline workbench:
  1. Multi-regime methodology crosswalk (one dataset → Subpart W / CO / NM / OGMP / EUMR / Canada outputs).
  2. Versioned rule-packs to absorb frequent rule and date changes.
  3. Immutable audit trail and evidence packs aligned with record-retention rules (3 years US, 10 years EU LDAR).
  4. JV/non-operated data intake and equity allocation.
  5. Supplier-data intake and QC for EU importers (Annex IX).
- Measurement-driven inventory increases (the u-curve) create a need for explainable variance and change logs between reporting years.

### Gaps
- No first-hand practitioner evidence from Reddit (r/oilandgasworkers, r/environmental), LinkedIn or survey data was collected; the search budget was exhausted.
- No independent user reviews of specific vendors (G2/Capterra) were collected.
- No quantified data on time and cost spent on emissions reporting by typical operators, apart from vendor claims.
