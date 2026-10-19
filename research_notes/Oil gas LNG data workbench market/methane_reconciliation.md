# Methane Measurement-vs-Inventory Reconciliation in Oil & Gas: Technologies, Data Workflows, Tools and Unmet Needs (state as of Oct 2026)

Research date: 2026-10-19. Research note: the shared web-search budget ran out partway through, so a few sub-topics (drone vendor specs, regional MARS breakdowns, AWS/Microsoft partner tools) were only partly covered. They are listed under Gaps. Vendor claims are marked as such.

---

## 1. What "reconciliation" means (OGMP 2.0 Level 5, EU Methane Regulation), the guidance documents, and how big the measured-vs-inventory gap is

### Takeaway
Reconciliation means comparing the sum of Level-4 source-level estimates with independent site-level measurements on the same spatial and time basis, with uncertainty for both. Where they disagree, the operator investigates, adjusts the asset-level (L5) number up or down, and feeds the lessons into next year's measurement plan. Both OGMP and the guidance call it an iterative, year-over-year process, not a one-off average of two numbers. Measured emissions are typically 1.6x to 4x inventory values at basin and national scale. Companies that reach Level 5 often see reported emissions rise 3–5x (Devon +309%, Cheniere +379%).

### Cited Findings

**OGMP 2.0 definitions and the official guidance**
- The official guidance document is "Guidance document: Reconciliation and Uncertainty (U&R) in methane emissions estimates for OGMP2.0". It is labelled "Final Draft for Steering Committee 2022-03-28" and "SG Approved", is 17 pages long, and was re-hosted on ogmpartnership.org in April 2025 — [OGMP U&R Guidance PDF](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf). The older URL is [ogmpartnership.com 2023/02 upload](https://ogmpartnership.com/wp-content/uploads/2023/02/OGMP-2.0-UR-Guidance-document-SG-approved.pdf).
- Definition (verbatim): "Reconciliation is the process of comparing source-level (Level 4) inventories with independent site-level measurements to produce Level 5 asset emissions estimates. Site-level measurements complement - rather than replace - source-level estimates… Reconciliation is an iterative process of investigation, year over year, and should not be thought of as a one-off comparison of two independent values." — [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- The guidance is explicitly "not prescriptive". Operators must use "judgment and justification", and "Transparency of method and reporting of complete results is critical." — [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- The 5-step annual cycle is: (1) build an L4 inventory with uncertainty estimates; (2) define an independent sampling strategy for a site or population of sites, "considering the potential for missed sources"; (3) measure; (4) compare the sum of source estimates with the measurements; (5) produce the L5 report. The cycle repeats each year. — [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- There are two allowed reconciliation approaches. (a) Unique or small numbers of facilities: used where the operator has detailed temporal L4 data (e.g. from monitoring) and can corroborate it with site measurements at one or more points in time. (b) Population of sites: enough site measurements to extrapolate to an annual average, where "Monte Carlo analysis (or other appropriate statistical methods) can be used to compare short duration measurements to source-level emissions estimates on different time scales." — [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- Data requirements stated in the guidance:
  - Reconciliation must be done "between emissions data which have been determined on the same basis, particularly in terms of the spatial coverage and the time frame".
  - Uncertainty is stated as a value plus a confidence interval (e.g. 2σ or 95%), propagated per GUM (JCGM 100:2008) and JCGM 101 (Monte Carlo).
  - Operators must report all individual measurements, whether or not the two estimates converge.
  - Operators must document the steps to derive mass emissions, including ancillary data (e.g. an example calculation).
  - Site- and source-level methods must be independent: "a single measurement campaign cannot satisfy both". ISO 17025-accredited providers are recommended.
  - Source: [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- Sampling: emission distributions are skewed and fat-tailed, so "estimates based on a limited sample of measurements can bias low". The guidance gives a sampling matrix (percent of population to sample, split by simple vs complex sites and high vs low materiality). Site-level measurement frequency must be risk-based and reviewed "no less frequently than on an annual basis". If a statistically representative sample of a similar population is measured, "all relevant assets may claim reporting at Level 5". — [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- Materiality rules: L4 must cover at least 70% of each asset's emissions, with a justification if it is below 90%. Assets making up 95% of portfolio emissions are material. Reference-year reassessment is triggered by a change of about 20% within 3 years. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- On Level 5 coverage, the FAQ recommends attempting site-level measurement "with possible reconciliation for a nominal one-third of assets," with year-on-year progress. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- Gold Standard requires L4/L5 within 3 years for operated assets and within 5 years for non-operated assets. Reports are due 31 May each year. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- Satellites "cannot be used as site-level technology" for L5 "unless the emissions from a site are constantly above the detection threshold". It is "not appropriate to assume emissions for that facility are zero" when a satellite detects nothing. — [OGMP FAQ](https://www.ogmpartnership.org/frequently-asked-questions)
- A newer OGMP technical guidance document for transmission systems (approved January 2026) frames the aim of reconciliation as confirming that all potential sources were detected and attributed — [OGMP Transmission TGD, Jan 2026](https://www.ogmpartnership.org/sites/default/files/resources/2026-04/OGMP_Transmission%20systems_FINAL_Approved_Formatted.pdf) (summarised via search snippet, not read in full).

**EU Methane Regulation (EU) 2024/1787**
- The regulation text says site-level quantification "allows assessment, verification and reconciliation of source-level estimates" — [EUR-Lex 2024/1787](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32024R1787)
- Phased reporting (Art. 12), as summarised by law firms:
  - by 5 Aug 2025: source-level emissions estimated with at least generic emission factors;
  - by 5 Feb 2026 (operated) and 5 Feb 2027 (non-operated): source-level quantification;
  - "the following year and annually thereafter": site-level measurements compared with source-level quantification.
  - Sources: [Gleiss Lutz](https://www.gleisslutz.com/en/know-how/first-eu-wide-methane-regulation-eu-20241787); [Lexology](https://www.lexology.com/library/detail.aspx?g=44cd3084-697f-4e1c-89e1-03c6a53c87de). Secondary summaries differ on exact dates, so check the article text.
- The OIES (Apr 2025) notes that the EU Regulation drew on OGMP Levels 4/5, but its "Level 5" includes independent verification by accredited verifiers, which OGMP does not require — [OIES ET46](https://www.oxfordenergy.org/wpcms/wp-content/uploads/2025/04/ET46-Measurement-Reporting-and-Verification-of-Methane-Emissions.pdf) (via search summary).
- Feb 2026: the Commission proposed a simplified import-compliance pathway allowing "trace and claim" or certificates that specify the methane intensity of imported gas — [Highwood Bulletin 083, 17 Feb 2026](https://www.highwoodemissions.com/bulletin/the-highwood-bulletin-083/)
- 14 Oct 2026: the Commission proposed a one-year delay. Import MRV-equivalence would move from 1 Jan 2027 to 2028, with first demonstrations by 31 May 2029, and methane-intensity reporting would move to 5 Aug 2029. The proposal still needs Parliament and Council approval. The Commission says the change "does not affect the ambition, integrity and scope" — [Linklaters](https://sustainablefutures.linklaters.com/post/102o5fh/european-commission-proposes-delaying-key-eu-methane-regulation-import-and-report); [edie](https://www.edie.net/eu-proposes-one-year-delay-to-methane-rules-for-fossil-fuel-imports/); [MLex](https://www.mlex.com/mlex/energy/articles/2537738)
- December 2025 Council documents refer to Omnibus "targeted adjustments" before full rollout — [Council ST-16479-2025](https://data.consilium.europa.eu/doc/document/ST-16479-2025-REV-1/en)

**Other guidance and verification frameworks**
- UT-Austin EEMDL released an interim-final Verification Protocol covering data quality, quantification methods, uncertainty and third-party review. NGSI Protocol v3.0 was announced. Both are reported in [Highwood Bulletin 083, Feb 2026](https://www.highwoodemissions.com/bulletin/the-highwood-bulletin-083/)
- Highwood's EIP markets support for "OGMP 2.0, EU import requirements, MiQ, and Veritas" (Veritas is GTI's protocol) — [PR Newswire, 15 Jan 2025](https://www.prnewswire.com/news-releases/highwood-launches-the-emissions-intelligence-platform-eip-for-oil-and-gas-companies-the-worlds-first-software-for-ogmp-2-0-methane-reporting-and-measurement-informed-inventories-302351128.html)
- Highwood/Astra "Mind the Methane Gap" (18 Sep 2026) proposes a six-step diagnostic review: (1) verify scope (same sites and sources); (2) align timing using operator logs and process data; (3) verify activity data; (4) establish operating modes during measurement (tank filling, VRU status, flare status); (5) characterise uncertainty (detection limits, met, quantification error); (6) only then revise emission rates. It explicitly discourages "adjusting emission factors to force agreement" — [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)

**Size of the gap (studies)**
- Alvarez et al. 2018 (*Science*): US natural gas supply chain emissions were about 60% above the EPA inventory — cited in [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/) (DOI 10.1126/science.aar7204).
- Sherwin et al. 2024 (*Nature* 627, published 13 Mar 2024) — [Stanford EAO](https://eao.stanford.edu/publications/journal-articles/us-oil-and-gas-system-emissions-nearly-one-million-aerial-site); [NPR/KPCW](https://www.kpcw.org/npr-news/2024-03-13/oil-and-gas-companies-emit-more-climate-warming-methane-than-epa-reports):
  - 986,238 aerial site measurements from 15 campaigns, in 6 US regions covering 52% of onshore oil and 29% of gas production;
  - weighted loss rate 2.95% (95% CI 2.79–3.14%) of gas production, about 3x the government inventory (EPA's figure is about 1.01%);
  - regional range 0.75% to 9.63%.
- Permian aerial LiDAR inventory (ES&T 2025/26, Bridger Gas Mapping LiDAR) — [ACS ES&T](https://pubs.acs.org/esthag/article/60/19/13968/5069689/Aerial-LiDAR-Based-Source-Resolved-Methane); [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC13192305/):
  - 51,770 sites scanned over 4 quarters;
  - 5,133 kt CH4/yr (95% CI 4,070–6,337), a 3.13% loss rate;
  - the authors disclose a Bridger financial interest.
- MethaneSAT Permian data (May 2024–Jun 2025) put Permian emissions at about 4x what companies report to EPA. This comes from a Senate EPW minority (political) release dated 18 Mar 2026, which sent letters to EOG, ConocoPhillips, Oxy, ExxonMobil, Diamondback, Devon, Chevron and Mewbourne — [Senate EPW](https://www.epw.senate.gov/public/index.cfm/2026/3/whitehouse-investigates-alarming-mismatch-between-reported-methane-emissions-and-actual-methane-emissions-in-permian-basin)
- MethaneSAT's first system-wide global assessment found that measured emissions often exceed what operators report — [Highwood Bulletin 083](https://www.highwoodemissions.com/bulletin/the-highwood-bulletin-083/)
- IEA Global Methane Tracker 2025:
  - energy methane is above 120 Mt/yr, and the IEA estimate is about 80% higher than what countries report to the UNFCCC, with the gap "narrowest in Europe";
  - super-emitter events seen by Sentinel-5P hit a record in 2024 despite reduced coverage.
  - Source: [IEA GMT 2025 key findings](https://www.iea.org/reports/global-methane-tracker-2025/key-findings)
- S&P Global (aerial-data based): Permian methane intensity fell 23% in 2025 to 0.34% of production; Texas 0.39% vs New Mexico 0.25% — [S&P Global, Jun 2026](https://www.spglobal.com/energy/en/news-research/blog/crude-oil/060426-maintaining-momentum-permian-methane-emissions-intensity-contracts-23-in-2025)
- Barnett Shale (Schissel & Allen 2022): about 1% of sites produced almost half of emissions; high emitters averaged 39 kg/h vs a regional mean of 1.76 kg/h — [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)

**Company-level gaps revealed by OGMP Level 5 (EDF "Leveling Up 2025", Dec 2025)** — all from [EDF Leveling Up 2025 PDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)
- OGMP 2.0 has 153 members (Nov 2025); 135 reported 2024 data.
- Reporting members' operated production is 26% of the global total; operated plus non-operated is 42%.
- 31 members report Level 5 for at least half of operated production, up from 7 in 2023. The average level is unchanged at 3.6.
- The "methane u-curve": reported intensity falls from L2 to L4, then rises at L5 as site-level surveys find missed sources.
- Devon reached L5 using recurring Bridger aerial LiDAR across its whole operated portfolio. Reported operated emissions rose 309%, from "sources previously missed by OGI-based surveys or engineering estimates".
- Cheniere reached L5 across its LNG assets after a 16-month QMRV program. Reported emissions rose 379%. Aerial surveys showed up to 58% of emissions were "inaccessible to crews using optical gas imaging", and intensity varied 6-fold across surveys. EEMDL independently reproduced the model outputs. ERM's ISAE limited assurance was "a procedural check… not a validation of the emissions magnitudes".
- Eni reached L5 in 2024 and reported −60%. Most of that came from a reporting-boundary change; it would have been −5% without it.
- Petrobras ran L5 pilots with 8 campaigns (6 drone, 2 airborne) using SeekOps, Aeromon, Insight M and TotalEnergies' AUSEA. It reports "significant challenges in reconciling short-duration measurements with annualized inventories" and constraints on drones offshore.
- A vendor-reported figure (secondary, unverified against IMEO) says about 10% of emissions reported into OGMP 2.0 fall in the most stringent data category — [Validere blog, Aug 2026](https://blog.validere.com/ogmp-2-0)

### Inferences
- The OGMP U&R guidance is a 2022 draft and deliberately non-prescriptive: no standard statistical test, no data schema, no file format. Each operator and vendor builds its own method. That lack of standardisation is the core opening for tooling that documents method choices transparently.
- The guidance requires every individual measurement, all ancillary data, an example calculation, uncertainty per GUM/Monte Carlo, and documented "learnings". This amounts to a data-lineage and audit-trail requirement, and it maps naturally onto a workbench design built around reproducible, versioned analysis.
- The EU Regulation's added layer of accredited third-party verification, together with the 2026 delays, means verifiers and compliance providers also need tools to re-run reconciliations independently. That makes them a second customer segment besides operators.
- The U-curve and the Devon/Cheniere jumps mean a reconciliation can carry large reputational and financial consequences (e.g. EU import intensity, MiQ grades). Defensible, explainable comparisons are worth paying for.

### Gaps
- The OGMP U&R guidance text read here is the 2022 "Final Draft". I could not confirm whether a revised 2025/2026 version exists.
- I could not read the exact Art. 12 text of Reg. 2024/1787 to pin down the site-level measurement deadline and the reconciliation wording. Law-firm summaries differ.
- I did not find the full implementing acts or CEN standards for EU MR measurement (e.g. detection limits or minimum site-level technology specs).
- I did not retrieve the GTI Veritas protocol text or the UNEP IMEO recommended-practice text directly.
- No reliable aggregate statistic was found on the typical per-site ratio of measured to inventory emissions across OGMP members.

---

## 2. Measurement technologies, data outputs, detection thresholds, uncertainty and delivery formats

### Takeaway
Measurement layers differ by roughly 2–3 orders of magnitude in detection limit:
- point and path continuous monitors: about 0.2–1.5 kg/h;
- aerial LiDAR: about 1–3 kg/h;
- drones: sub-kg/h, but with large mass-balance error;
- airborne imaging: about 10 kg/h class;
- high-resolution satellites: about 66–150 kg/h;
- Sentinel-5P: tonnes per hour.

Outputs come as rasters (GeoTIFF/COG), vector plume outlines (GeoJSON), tabular emission rates with uncertainty (CSV), and portal or API access. Units, time support and uncertainty conventions all differ, and that heterogeneity is the integration problem.

### Cited Findings

**Aerial LiDAR (Bridger Photonics Gas Mapping LiDAR)**
- In a single-blind METEC/Stanford test, the wind-normalised 90% detection limit was 0.25 (kg/h)/(m/s) at 500 ft and 0.41 (kg/h)/(m/s) at 675 ft AGL. Bridger converts this to about 1.0 and 1.64 kg/h at a 4 m/s wind — [eScholarship paper](https://escholarship.org/uc/item/5bw1m4g2); [Bridger blog](https://www.bridgerphotonics.com/blog/key-takeaways-metec-and-stanfords-single-blind-determination-methane-detection-limits-and)
- Bridger's stated commercial sensitivity for first-generation sensors is 3 kg/h at 90% POD. For 95% of releases above that level, individual rate errors ranged from −64.1% to +87.0% using HRRR model wind — [eScholarship](https://escholarship.org/uc/item/5bw1m4g2)
- GML 2.0 is vendor-claimed at an average 1.27 kg/h (90% POD) across 12 North American basins. No independent study was found — [Bridger blog](https://www.bridgerphotonics.com/blog/bridger-photonics-releases-second-generation-methane-detection-sensor-gas-mapping-lidar-20)

**Drones/UAV**
- An AMT 2025 paper (Mohammadloo et al.; Shell, SeekOps and Scientific Aviation) gives a systematic error analysis of drone mass-balance. It cites controlled-release errors of over 100% for two drone systems (Liu et al. 2024), against about 16% RMSE when constrained to steady winds (Corbett & Smith 2022) — [AMT 18, 1301, 2025](https://amt.copernicus.org/articles/18/1301/2025/)
- In 2025–26 work, an NPL (UK) drone study used releases from 0.02 to 40 kg/h, and the arc flight pattern gave the lowest relative error in tracer-based drone tests — [EGU-sphere 2026-1665 review supplement](https://egusphere.copernicus.org/preprints/2026/egusphere-2026-1665/egusphere-2026-1665-RC1-supplement.pdf); [MDPI Methane 4(3):18](https://www.mdpi.com/2674-0389/4/3/18)
- Petrobras used six drone campaigns with SeekOps, Aeromon, Insight M and AUSEA offshore, and flagged operational limits on drones in offshore conditions — [EDF Leveling Up 2025](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)
- McManemin et al. 2026 (TADI controlled releases): several teams underestimated releases because wind sensors malfunctioned or sat in still air — [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/) (DOI 10.5194/amt-19-923-2026)

**Satellites**
- GHGSat:
  - 50% POD is about 102 kg/h at 3 m/s wind; a 2026 preprint gives 99.0 ± 5.3 kg/h at 27 m resolution from 2021–2026 controlled releases; offshore limits are 160–600 kg/h — [EGU-sphere 2026-3662](https://egusphere.copernicus.org/preprints/2026/egusphere-2026-3662/); [GHGSat CEOS 2024](https://ceos.org/document_management/Virtual_Constellations/AC-VC/Meetings/AC-VC-20/4.12%20GHGSat_CEOS_AV-VC_2024_McKeever_v1%20-%20Jason%20McKeever.pdf)
  - Products are 16-bit GeoTIFF concentration rasters plus a CSV emission-rate product with uncertainty and dispersion parameters (the CSV is delivered only if an emission is detected). Data comes via the SPECTRA platform, which replaced "Pulse" — [ESA GHGSat archive & tasking](https://dragon3.esa.int/eogateway/catalog/ghgsat-archive-and-tasking); [SpaceQ](https://spaceq.ca/ghgsat-launches-spectra-to-replace-pulse/)
  - The product spec found is dated Oct 2021 — [ESA spec PDF](https://earth.esa.int/eogateway/documents/d/earth-online/ghgsat-data-sat-product-specifications-pdf)
  - GHGSat's aerial DATA.AIR product is 13.4 kg/h at 90% POD under EPA alternative test method MATM-007 (Feb 2025) — [EPA MATM-007](https://www.epa.gov/system/files/documents/2025-02/ghgsat-aerial-monitoring-alternative-test-method-matm-007_2-19-2025-508.pdf)
- Carbon Mapper / Tanager-1 (Planet):
  - predicted MDL is 66–144 kg/h (25% albedo, 45° SZA, 3 m/s wind) and depends on imaging mode;
  - plume rasters, tabular emissions and L2 strip images are available via API and bulk download 30 days after observation;
  - Carbon Mapper processes Planet Level-1 data.
  - Source: [Carbon Mapper emissions monitoring system preprint (EGUsphere 2025-2275)](https://egusphere.copernicus.org/preprints/2025/egusphere-2025-2275/egusphere-2025-2275.pdf); [Tanager-1 one year](https://carbonmapper.org/articles/tanager-1-one-year-in-space)
- NASA EMIT (ISS):
  - the L2B CH4PLM product gives a 60 m Cloud-Optimized GeoTIFF (ppm·m, with uncertainty) plus GeoJSON (plume outline, source scenes, max-enhancement coordinates, uncertainty);
  - V002 adds an emission-rate estimate in the GeoJSON (set to "N/A" if it fails ATBD criteria);
  - no data was collected between 13 Sep 2022 and 6 Jan 2023;
  - also available in Google Earth Engine.
  - Source: [NASA data catalog V002](https://data.nasa.gov/dataset/emit-l2b-estimated-methane-plume-complexes-60-m-v002); [Earthdata catalog](https://earthdata.nasa.gov/data/catalog/lpcloud-emitl2bch4plm-001); [GEE catalog](https://developers.google.com/earth-engine/datasets/catalog/NASA_EMIT_L2B_CH4PLM?hl=de)
- MethaneSAT (EDF): contact was lost on 20 Jun 2025, the satellite lost power, and it is "likely not recoverable". Collected data remains public — [EDF](https://www.edf.org/media/methanesat-loses-contact-satellite); [Via Satellite](https://www.satellitetoday.com/imagery-and-sensing/2025/07/01/methanesat-loses-contact-with-satellite/)
- Sentinel-2 / Landsat via UNEP's MARS-S2L: combined mean revisit is 2.3 days; the model detects 78% of plumes at an 8% false-positive rate on 697 unseen sites; all plumes are manually validated by at least two analysts — [arXiv 2408.04745](https://arxiv.org/html/2408.04745v1); [PyPI marss2l](https://pypi.org/project/marss2l/)
- The IEA counts more than 25 satellites in orbit that are relevant to methane — [IEA GMT 2025](https://www.iea.org/reports/global-methane-tracker-2025/key-findings)

**Continuous monitoring systems (CMS)**
- METEC ADED single-blind test (ES&T 2023): 90% POD ranged from 3 to 30 kg/h across solutions, and 6 of 11 achieved below 6 kg/h. For 0.1–1 kg/h releases, mean relative errors ranged from −44% to +586% — [ES&T 10.1021/acs.est.2c09235](https://pubs.acs.org/doi/10.1021/acs.est.2c09235)
- A more recent top performer reportedly reached 90% POD at 0.5 kg/h, localisation 98.7% and mean quantification error −0.064 kg/h. This is secondhand via a framework paper that also models "blind time" across more than 100 operational facilities — [ACS ES&T Air framework paper](https://pubs.acs.org/aeacd5/article/2/8/1439/3693888/A-Framework-for-Optimizing-Continuous-Methane)
- Path-integrated (GreenLITE): minimum detected 0.22 kg/h, 100% detection at 0.65 kg/h or more with wind below 5 m/s, rate bias −6.1% — [Elementa 2024](https://online.ucpress.edu/elementa/article/12/1/00022/202933/Single-blind-detection-localization-and)
- Qube (vendor claim): 90% POD at about 1.5 kg/h, with sub-threshold emissions added through POD modelling. It exports annual CH4 summaries and gives error bars from min/max outputs. Its L5 case study covered 35% of a basin's sites — [Qube blog](https://www.qubeiot.com/expert-insights/ogmp2-with-continuous-monitoring)
- LongPath (laser-based, wide-area) has a validation paper at operational facilities — [Atmosphere 16(12):1409](https://doi.org/10.3390/atmos16121409). Its numbers were not retrieved.

**OGI / imaging**
- Kuva's EPA alternative test method was approved 2 Oct 2025 for periodic screening with leak resolution under 15 kg/h. Project Canary's alternative test method was approved 16 Apr 2025 — [EPA Oil & Gas Alternative Test Methods](https://www.epa.gov/emc/oil-and-gas-alternative-test-methods)
- Cheniere found up to 58% of emissions inaccessible to OGI crews. Petrobras uses qOGI cameras from several suppliers — [EDF Leveling Up 2025](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)

### Inferences
- Detection limits range from 0.2 kg/h to more than 100 kg/h, and non-detects are "not zero" (OGMP FAQ). Any integration tool therefore has to carry POD curves and censoring (detect, non-detect, below-MDL) as first-class data, not just a list of detections.
- Formats are converging on GeoTIFF/COG for rasters, GeoJSON or KML for plume vectors, and CSV/API for rates. This suits a GIS-literate desktop tool built on GDAL/QGIS-class libraries that can ingest all of them offline.
- Satellite products are freely downloadable (EMIT, Carbon Mapper after 30 days, MARS plumes), so an offline workbench can pre-cache public data for an operator's area of interest. This matters for remote and offshore sites.

### Gaps
- Search budget ran out before I could get vendor detection specs and deliverable formats for SeekOps, ABB HoverGuard, Pergam, Aeromon and Insight M. Also missing: typical file sizes (e.g. raw drone logs, LiDAR swaths, OGI video), per-km² data volumes, and the exact Carbon Mapper API/STAC schema.
- Not verified in this session (background knowledge only): Sentinel-5P/TROPOMI pixel size (about 5.5×7 km) and its detection threshold in tonnes per hour; Kairos Aerospace's rebrand to Insight M; LongPath's quoted detection range and radius.
- No independent (non-vendor) data was found on Qube's or Kuva's quantification accuracy for annualised totals.

---

## 3. UNEP IMEO Methane Alert and Response System (MARS): how alerts reach operators and how they respond

### Takeaway
MARS detects plumes, mainly with Sentinel-2/Landsat (MARS-S2L) and other satellites. Analysts validate them and attribute them to assets, and a regional case manager notifies the government and the company contact. Responses remain low: about 1% initially, about 12–13% in 2025. More than 5,000 actionable events have been notified across 34 countries, and 25 documented mitigation cases have resulted.

### Cited Findings
- Pipeline:
  - new Sentinel-2/Landsat images over monitored sites are ingested daily at 06:30 GMT;
  - the ML model produces a plume mask and scene probability, shown in "PlumeViewer" (filterable by probability, flux, satellite, country);
  - analysts validate the plume, quantify flux with an error estimate, and cross-check infrastructure and proprietary databases.
  - Source: [arXiv 2408.04745](https://arxiv.org/html/2408.04745v1)
- Notification: once the source and owner are identified, information is shared through the MARS regional case manager with the government and the company contact. Notifications can only go out where IMEO has a point of contact. All detected plumes are published on methanedata.unep.org every two weeks — [arXiv 2408.04745](https://arxiv.org/html/2408.04745v1)
- Pilot statistics (Jan–Jun 2024): 457 detections at 110 sites in 22 countries; 62 notified at 41 sites in 15 countries — [arXiv 2408.04745](https://arxiv.org/html/2408.04745v1). The operational MARS-S2L total is 1,015 notifications in 20 countries — [PyPI marss2l](https://pypi.org/project/marss2l/)
- Cumulative (IEA with IMEO): more than 10,000 plumes detected and more than 5,000 actionable events notified in 34 countries. About 12% of notifications received a response in 2025, and 25 mitigation cases have been documented in 10 countries since the 2022 launch — [IEA report page](https://www.iea.org/reports/responding-to-satellite-notifications-from-the-methane-alert-and-response-system) (snippet; page returned 403)
- UNEP press release: more than 3,500 alerts across 33 countries; the response rate rose about tenfold, from about 1% to 12%; nearly 90% remain unanswered — [UNEP press release](https://www.unep.org/en/news-and-stories/press-release/better-data-driving-action-methane-emissions-more-work-needed); [Down To Earth](https://www.downtoearth.org.in/climate-change/only-1-per-cent-methane-emissions-alerts-to-governments-and-companies-have-received-responses-unep)
- Bloomberg Philanthropies puts the current response rate at 13%, where "response" means the alert was investigated and information sent back to UNEP — [Bloomberg](https://www.bloomberg.org/press/unep-partners-ramp-up-efforts-to-address-major-methane-leaks-as-un-chief-urges-rapid-cuts/)
- The monthly country response rate is the share of notified sources for which IMEO received feedback — [MARS response-rates data dictionary](https://methanedata.unep.org/dict-mars-response-rates)
- *An Eye on Methane 2025* (5th edition) was published 22 Oct 2025 — [UNEP](https://www.unep.org/resources/eye-methane-2025-measurement-momentum)
- The US EPA "super-emitter" (≥100 kg/h) third-party notifier program was delayed to 22 Jan 2027 by the July 2025 interim final rule — [Trinity Consultants](https://trinityconsultants.com/resources/2025-oooobc-interim-final-rule/); [EPA fact sheet](https://www.epa.gov/system/files/documents/2025-07/oil-and-gas-interim-final-rule-2025_-fact-sheet_0.pdf)

### Inferences
- Operators receiving MARS or super-emitter alerts face a recurring triage task: match plume coordinates to assets, check SCADA and maintenance logs for the overpass time, record a cause, and respond. The low response rate suggests a capacity or tooling gap, though politics and contact gaps also play a part. A desktop "alert-to-asset" matcher is a concrete, near-term feature.
- An overpass-time snapshot of a large event has to be reconciled against inventory duration assumptions. This is the same intermittency problem as in Q5.

### Gaps
- The IEA and UNEP MARS pages returned 403, so I could not read the exact notification template (fields, attachments, file formats) or response-time statistics.
- Search budget was exhausted before a regional breakdown was obtained (e.g. Turkmenistan, Algeria, Libya, US, Middle East response rates).

---

## 4. Software tools for reconciliation and measurement-data integration: deployment, cost, gaps

### Takeaway
A small set of mostly cloud/SaaS vendors now markets "measurement-informed inventory" and OGMP L5 reconciliation: Highwood EIP (launched Jan 2025), Validere, SLB's methane digital platform, and sensor vendors' own portals (Qube, Kuva, Project Canary). None publishes pricing. Deployment models are rarely stated, and independent validation of their reconciliation logic is scarce. Consolidation is under way: Zeitview acquired Insight M (reported Feb 2026).

### Cited Findings
- Highwood Emissions Intelligence Platform (EIP):
  - launched 15 Jan 2025 in Houston and marketed as "the world's first software for OGMP 2.0 methane reporting and measurement-informed inventories";
  - co-designed by a steering committee of 4 unnamed O&G companies;
  - claims "auditable" workflows and support for OGMP 2.0, EU import rules, MiQ and Veritas;
  - pricing and deployment model are not stated.
  - Source: [PR Newswire](https://www.prnewswire.com/news-releases/highwood-launches-the-emissions-intelligence-platform-eip-for-oil-and-gas-companies-the-worlds-first-software-for-ogmp-2-0-methane-reporting-and-measurement-informed-inventories-302351128.html)
  - Highwood's platform page (via search snippet) lists ingestion of LDAR, CEMS, OGI, satellite, aerial and drone data, automated top-down/bottom-up quantification, and uncertainty calculation — [Highwood platform](https://www.highwoodemissions.com/platform/)
- Validere (vendor guide, 4 Aug 2026) lists the capabilities it says L5 needs:
  - a governed asset master (operated/non-operated, equity);
  - a source inventory linked to sites;
  - activity-data integration;
  - multi-technology measurement ingestion with metadata (method, detection limit, timestamp, operating state);
  - versioned calculation methods that separate a method change from a real reduction;
  - uncertainty support and a reconciliation workspace;
  - approvals and audit trail;
  - reuse of the same data across OGMP, EPA Subpart W, EU MRV and ESG.
  - Deployment is not stated. Source: [Validere blog](https://blog.validere.com/ogmp-2-0)
- SLB:
  - its "methane digital platform" aggregates data from several measurement systems into one inventory with live statistics and leak alerts — [SLB product sheet](https://www.slb.com/-/media/images/home-page-2022/methane-emissions-management/sees-end-to-end-emissions-solutions-family/methane-digital-platform-ps.pdf);
  - Eni selected SLB for global OGMP-aligned source-level measurement and reporting plans — [Energy Industry Review](https://energyindustryreview.com/oil-gas/slb-to-deliver-global-methane-emissions-reporting-project-for-eni/) (year not given);
  - SLB launched an IoT continuous methane point instrument at ADIPEC on 3 Oct 2023 — [Drilling Contractor](https://drillingcontractor.org/?p=66474)
- Sensor-vendor portals:
  - Qube exports annual CH4 summaries for OGMP — [Qube](https://www.qubeiot.com/expert-insights/ogmp2-with-continuous-monitoring);
  - Kuva markets an annual emissions report with confidence intervals for OGMP L4/L5 — [Kuva](https://www.kuvasystems.com/solutions);
  - Project Canary covers Subpart W, OGMP 2.0 and PHMSA — [Wikipedia](https://en.wikipedia.org/wiki/Project_Canary)
- Zeitview has acquired Insight M (aerial methane detection and quantification), reported in [Highwood Bulletin 083, 17 Feb 2026](https://www.highwoodemissions.com/bulletin/the-highwood-bulletin-083/)
- Independent review exists only for one-off cases. UT-Austin EEMDL reproduced Cheniere's measurement-informed inventory model outputs, while ERM's assurance was procedural only — [EDF Leveling Up 2025](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)

### Inferences
- Published deployment details suggest the market is dominated by cloud SaaS tied to a vendor's measurement service (sensor plus portal) or to enterprise ESG platforms. That leaves room for:
  - a vendor-neutral, offline-capable desktop workbench for NOCs and Middle East/Africa operators with data-sovereignty or connectivity constraints;
  - offshore and remote use;
  - third-party verifiers and consultants who must re-perform calculations independently;
  - small and mid-size operators priced out of enterprise SaaS.
  - This is an inference; no source quantified the demand.
- Validere's capability list (asset hierarchy, method versioning, censoring and metadata, reconciliation workspace, lineage) is a usable requirements checklist for a competing product.

### Gaps
- No pricing found for any vendor (EIP, Validere, SLB, Kuva, Qube, Project Canary, Insight M).
- Not researched because the search budget ran out: Baker Hughes (e.g. Flare.IQ/Lumen), Honeywell, Microsoft (Sustainability Manager / Emissions Impact) and AWS partner offerings, Context Labs, Sensia, Kayrros.
- No evidence was found of any explicitly offline or on-prem desktop reconciliation tool on the market. This is unconfirmed either way.

---

## 5. Practitioner pain points: mixing sources, units, time windows, uncertainty, spatial matching, intermittency, audit trail, data volume

### Takeaway
The hardest problems are not arithmetic. They are boundary alignment, time alignment, operating-state context, non-detect handling and annualising intermittent events. Recurring pain points:
- asset, site and source hierarchies that conflict across departments;
- snapshot measurements that cannot represent annual totals;
- skewed, fat-tailed distributions that bias small samples low;
- plume drift and attribution to neighbouring sites;
- detection limits and missing operating-state metadata;
- wind and meteorology error;
- weak lineage from sensor reading to reported number.

### Cited Findings
- Causes of gaps (Highwood/Astra, Sep 2026):
  - scope mismatch (different site lists, plume drift from neighbours, gathering vs production misallocation);
  - intermittency and snapshot extrapolation;
  - missing activity data (e.g. unlogged blowdowns);
  - abnormal operating modes (e.g. a stuck dump valve);
  - emission factors that blur normal and failed states;
  - measurement error (e.g. wind sensors).
  - Source: [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)
- "Reporting criteria have not generally required the frequency and duration of failure modes." Many large releases are process emissions that recur across surveys, not leaks — [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)
- Zimmerle et al. (2019) found nearly 900 more gathering compressor stations than EPA's count, an activity-data completeness problem. NASEM (2018) noted factors still drawn from a 1996 study — [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)
- Validere's list of pain points — [Validere](https://blog.validere.com/ogmp-2-0):
  - hierarchies that differ across operations, HSE and sustainability turn reconciliation "into arguments about boundaries";
  - immature L3 maps;
  - annualisation;
  - "a non-detection is not a zero";
  - attribution to changeable equipment;
  - matching spatial and temporal bases;
  - undocumented alternate factors and missing operating-state metadata;
  - "no lineage from sensor reading to reported cell".
- OGMP guidance says small samples from skewed or fat-tailed distributions bias low. Operators should know the time-variability state (transient, variable, intermittent, steady) during measurement, and capture intermittent events through more-than-annual frequency or equipment monitoring — [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- Petrobras cites "significant challenges in reconciling short-duration measurements with annualized inventories". Cheniere saw 6-fold intensity variation across surveys — [EDF Leveling Up 2025](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)
- Quantification uncertainty is wide:
  - aerial LiDAR −64% to +87% per individual estimate — [eScholarship](https://escholarship.org/uc/item/5bw1m4g2);
  - CMS −44% to +586% at 0.1–1 kg/h — [ES&T 2023](https://pubs.acs.org/doi/10.1021/acs.est.2c09235);
  - drone mass-balance error above 100% in some systems — [AMT 2025](https://amt.copernicus.org/articles/18/1301/2025/)
- CMS "blind time" depends on sensor configuration and wind, modelled across more than 100 facilities — [ACS ES&T Air](https://pubs.acs.org/aeacd5/article/2/8/1439/3693888/A-Framework-for-Optimizing-Continuous-Methane)
- A 2026 *Nature Communications* paper, "Duration of super-emitting oil and gas methane sources", addresses persistence and intermittency directly — [Nature Comms s41467-026-68804-7](https://www.nature.com/articles/s41467-026-68804-7) (paywall redirect; findings not read).
- Eni's −60% was mostly a boundary change, a sign that boundary changes can masquerade as reductions — [EDF Leveling Up 2025](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)

### Inferences
- A reconciliation workbench needs these core functions (inferred from the pain points above):
  1. A canonical asset/site/source hierarchy with polygons and equipment points (GIS).
  2. Ingestion of heterogeneous measurements into a common schema: rate in kg/h CH4, uncertainty distribution, detection limit and POD curve, time window, platform, wind source, censoring flag.
  3. Spatial matching of plumes to site polygons and equipment, with ambiguity flags for neighbouring sites.
  4. A temporal join with operating logs (SCADA, maintenance, blowdowns, flare status).
  5. Monte Carlo annualisation combining event duration and frequency with sub-threshold POD modelling.
  6. Method versioning and lineage for audit.
  7. Report export to OGMP templates and EU MR formats.
- Unit friction is real but secondary. Inputs arrive as ppm·m (EMIT), kg/h, scfh (METEC tests), %-of-production intensity and tonnes/yr, so conversion is easy to automate.

### Gaps
- No quantitative survey of practitioners (time spent, team size, cost of reconciliation) was found.
- Data volumes (GB per campaign, records per CMS site-year) were not found in sources.
- I could not read the Nature Comms 2026 super-emitter duration results (paywall).

---

## 6. Role of drone/UAV operators and GIS; drone regulation (BVLOS etc.)

### Takeaway
Drones are used as an L5 site-level method (e.g. 6 of Petrobras's 8 L5 pilot campaigns) and for source pinpointing, but mass-balance quantification is wind-sensitive and offshore operations are constrained. In the US, routine BVLOS still needs Part 107 waivers. The FAA Part 108 BVLOS final rule has been under White House review since 10 Jul 2026 and was not yet published as of early Sep 2026. GIS is the implicit backbone of reconciliation: asset polygons, plume-to-equipment attribution, neighbour drift.

### Cited Findings
- Petrobras L5 pilots used drones from SeekOps, Aeromon, Insight M and AUSEA, and reported operational constraints for drones offshore — [EDF Leveling Up 2025](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf)
- OGMP lists sensors on "planes, drones, boats, trucks" as acceptable source- or site-level methods, provided they are documented — [OGMP U&R Guidance](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)
- Drone mass-balance error depends on wind steadiness and flight pattern (16% RMSE under constraints vs over 100% otherwise; arc patterns best) — [AMT 2025](https://amt.copernicus.org/articles/18/1301/2025/); [MDPI Methane](https://www.mdpi.com/2674-0389/4/3/18)
- FAA Part 108:
  - sent to OIRA on 10 Jul 2026, with the 90-day review not complete before 8 Oct;
  - EO 14307's deadline was 1 Feb 2026;
  - right-of-way disputes with crewed-aviation groups remain;
  - publication is possibly late 2026 or 2027, with staggered compliance;
  - Part 107 waivers are needed meanwhile.
  - Source: [Airdata](https://airdata.com/blog/2026/part-108); [PickDrones](https://pickdrones.com/faa-part-108-bvlos-rule-delayed-oira-2026/); [Commercial UAV News](https://www.commercialuavnews.com/part-108-proposed-rule-moves-onto-office-of-information-and-regulatory-affairs)
- Scope mismatch from "plume drift from neighboring sites" and attribution are listed as top reconciliation pitfalls — [Highwood Briefing 003](https://www.highwoodemissions.com/briefing-003-mind-the-methane-gap/)
- The UNEP pipeline cross-references plumes with infrastructure databases before attribution — [arXiv 2408.04745](https://arxiv.org/html/2408.04745v1)

### Inferences
- Someone with UAV, GIS and HSE skills fits the role of independent field-data integrator. That person plans representative site-level sampling (OGMP matrix), flies or commissions drone surveys, and then performs plume-to-asset attribution and reconciliation. The workbench would be the deliverable engine.
- BVLOS limits favour drone work on compact facilities (LNG plants, compressor stations, well pads) over long linear assets until Part 108 or equivalent rules take effect.

### Gaps
- Not researched (search budget exhausted): EU (EASA SORA/specific category), UK CAA, GCC (UAE GCAA/Saudi GACA), Canada (Transport Canada BVLOS rules in effect 2025) and Australia (CASA) drone rules for methane surveys. Also offshore helideck/drone procedures.
- No data was found on drone survey pricing per site or on the number of drone methane service providers.

---

## 7. Open-source code, methods and datasets for reconciliation, plume quantification and attribution

### Takeaway
Solid open building blocks exist for detection, localisation and quantification (DLQ) and for satellite plume detection: Shell's pyELQ (Apache-2.0), UNEP's MARS-S2L (LGPL code; models and data non-commercial), Stanford FEAST, and open Gaussian puff implementations. Free data sources include EMIT, Carbon Mapper and the MethaneSET-S2 dataset. I found no open-source tool that performs the full OGMP-style source-vs-site reconciliation with uncertainty. That gap matches the niche.

### Cited Findings
- pyELQ (Shell, GitHub org "sede-open", Apache-2.0, PyPI "pyelq-sdk") detects, localises and quantifies methane emissions from concentration and wind data from point or beam sensors — [PyPI pyelq-sdk](https://pypi.org/project/pyelq-sdk/1.0.10)
- MARS-S2L (PyPI "marss2l") is UNEP IMEO's operational Sentinel-2/Landsat plume detection, segmentation and quantification pipeline (MBMP retrieval to ΔXCH4 to flux). Code is LGPL v3; the database and trained models are CC BY-NC-SA (non-commercial) — [PyPI marss2l](https://pypi.org/project/marss2l/)
- MethaneSET-S2: about 87,000 image pairs with more than 5,600 manually verified plumes at 1,315 emitter sites — [Source Cooperative](https://source.coop/csaybar/methaneset/s2)
- FEAST (Stanford EAO) is a Python simulator of LDAR program costs and benefits, on GitHub — [Stanford FEAST](https://eao.stanford.edu/research-project/feast)
- Open Gaussian puff implementations (Python and R) for oil and gas sites outperformed the Gaussian plume model on correlation and error metrics — [ChemRxiv 2023](https://chemrxiv.org/engage/chemrxiv/article-details/63b7b4a0ded31e2c817ec8e4)
- Ball et al. 2025 (AMT; Project Canary) compare plume vs puff dispersion and least-squares vs MCMC inversion for multi-source attribution from CMS data. A code release was not confirmed — [AMT 18, 5375, 2025](https://amt.copernicus.org/articles/18/5375/2025/)
- A 2025 review of AI for methane detection (continuous monitoring through verified mitigation) is a useful entry point — [arXiv 2511.21777](https://arxiv.org/html/2511.21777v1)
- Public data:
  - EMIT L2B plume COG/GeoJSON — [NASA](https://data.nasa.gov/dataset/emit-l2b-estimated-methane-plume-complexes-60-m-v002);
  - Carbon Mapper portal (API and bulk, 30-day latency for Tanager) — [Carbon Mapper preprint](https://egusphere.copernicus.org/preprints/2025/egusphere-2025-2275/egusphere-2025-2275.pdf);
  - UNEP plumes on methanedata.unep.org every two weeks — [arXiv 2408.04745](https://arxiv.org/html/2408.04745v1);
  - MethaneSAT archive kept public — [EDF](https://www.edf.org/media/methanesat-loses-contact-satellite).
- Methods literature cited by OGMP for reconciliation:
  - Zavala-Araiza et al. 2015 PNAS, "Reconciling divergent estimates";
  - Tullos et al. 2021 (short-duration measurements);
  - Vaughn et al. 2018 PNAS (temporal variability explains the top-down/bottom-up difference);
  - MEET model (2022).
  - Source: [OGMP U&R Guidance references](https://www.ogmpartnership.org/sites/default/files/2025-04/OGMP-2.0-UR-Guidance-document-SG-approved%20%281%29.pdf)

### Inferences
- A commercial offline workbench could embed pyELQ (Apache-2.0, permissive) for CMS DLQ and could call MARS-S2L code (LGPL, dynamic linking OK). However, it could not ship UNEP's trained models or dataset commercially (non-commercial licence) without permission.
- The missing open piece is the reconciliation layer itself: hierarchy, spatial join, temporal annualisation, Monte Carlo comparison and audit trail. No OSS project was found for it, so it is a differentiation opportunity rather than something to duplicate.

### Gaps
- LDAR-Sim (believed to be Highwood/University of Calgary open-source) did not appear in results and was not verified. Also unverified: the EDF OGIM global infrastructure database, ESA/Kayrros/SRON TROPOMI open products, STARCOP, the EEMDL code repositories, and the Colorado School of Mines CMS codes.
- I did not check GitHub directly because the search budget was exhausted, so star counts, maintenance status and licences beyond those listed are unknown.
- Regional adoption, from limited evidence:
  - The IEA says the measured-vs-reported gap is narrowest in Europe — [IEA](https://www.iea.org/reports/global-methane-tracker-2025/key-findings).
  - EDF says OGMP coverage should grow "outside the United States and Europe" — [EDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf).
  - Eni ran OGMP campaigns with NOCs in North Africa and OGI/LDAR training in Libya — [EDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf).
  - Petrobras is building measurement for offshore Brazil — [EDF](https://library.edf.org/AssetLink/5sob4fjqte20hwd54310l584eeu5y50j.pdf).
  - The US is rolling back federal measurement policy: the super-emitter program is delayed to Jan 2027, a Subpart W delay to 2034 has been proposed, and the 2009 Endangerment Finding was rescinded (Feb 2026) — [Trinity](https://trinityconsultants.com/resources/2025-oooobc-interim-final-rule/); [Harvard EELP](https://eelp.law.harvard.edu/2019/09/epa-voc-and-methane-standards-for-oil-and-gas-facilities/); [Highwood Bulletin 083](https://www.highwoodemissions.com/bulletin/the-highwood-bulletin-083/).
  - Middle East and Asia-Pacific specifics (ADNOC, Aramco, QatarEnergy, Australian Safeguard/NGER measurement, China) could not be researched before the search budget ran out.
