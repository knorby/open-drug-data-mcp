# Data sources, terms, and attribution

Open Drug Data MCP queries public databases at runtime and credits each
record to the database that supplied it. This page records what each source
covers, which identifiers it knows, the terms we verified, and the attribution
each source asks for.

The one-line disclaimer every agent-facing surface carries is:

> Informational/research use only — not medical advice; see docs/SOURCES.md
> for source terms.

This page is the full version.

## Disclaimer

**Informational and research use only — not medical advice.**

This server does not provide medical advice, diagnosis, treatment, dosing, or
a recommendation about any product or ingredient. It does not create a
clinician-patient relationship. Do not use its output to decide whether to
start, stop, or change a medicine, supplement, or cosmetic, and do not delay
seeking professional care because of something it returned. In an emergency,
contact local emergency services.

The databases behind this server are not interchangeable with clinical
judgment:

- openFDA data is published as-is and is not validated for clinical use.
- RxNorm and DailyMed describe terminology and labeling, not a treatment plan.
- DrugCentral assertions and FAERS report counts are research data; a report
  count is not an incidence rate and does not establish causation.
- DSLD captures manufacturer-supplied supplement labels; ODS does not verify
  that a label meets FDA requirements.
- CosIng is an information database with no legal value; only Regulation
  (EC) No 1223/2009 and its Annexes establish regulatory status.
- INKEEDecoder is editorial content, not a regulatory or medical authority.

Data may be incomplete, delayed, out of date, or wrong. No warranty is made,
and no liability is accepted for use of the data or this software. Always
consult a qualified physician, pharmacist, or other licensed professional,
and read the current official labeling or operative regulation.

This page describes source terms as they appeared on the verification date.
It is not legal advice. Terms can change; check the linked page before
redistributing data.

## How this server uses the sources

- Queries run at request time. There is no local mirror and no cache, so
  `retrievedAt` is the time of the request that produced the record.
- Searches fan out to every enabled source that declares the requested search
  type and category. A source that cannot answer is absent; a source that
  fails contributes an error group without failing the whole search.
- Results name the upstream database, carry its deep link, and keep
  regulatory text verbatim and labeled. Client library names never appear in
  tool output.
- `DRUGDATA_DISABLED_SOURCES` can switch off any adapter for a process. The
  ids are `openfda`, `cosing`, `nlm`, `drugcentral`, `dsld`, and
  `inkeedecoder`; `nlm` covers both RxNorm and DailyMed.
- The server does not bulk-download, mirror, or redistribute datasets. The
  INKEEDecoder adapter keeps a one-request-per-second pace, and searches
  never walk pagination automatically.

## openFDA

| | |
| --- | --- |
| **Publisher** | U.S. Food and Drug Administration (FDA) |
| **Upstream** | <https://open.fda.gov/> — `drug/ndc`, `drug/label`, `other/substance`, `other/unii` |
| **Coverage** | Marketed US drug products in the NDC directory, Structured Product Label (SPL) documents, and ingredient substance records. |
| **Identifiers** | Product and package NDC, UNII, CAS (on substance records), SPL set id, FDA application number. |
| **Search types** | Products: name, brand, ingredient, barcode, NDC. Ingredients: name, INCI, UNII, CAS. |
| **Lookups** | `drugdata_get_product` (`openfda`) by product/package NDC or SPL set id; `drugdata_get_ingredient` (`openfda`) by UNII or dashed CAS. |
| **Update cadence** | Endpoint-specific. openFDA publishes each dataset's update schedule with its API documentation; this server always queries the live endpoint. |

**Terms verified 2026-10-22:** <https://open.fda.gov/terms/>.

The terms state: "Unless otherwise noted, the content, data, documentation,
code, and related materials on openFDA is public domain and made available
with a Creative Commons CC0 1.0 Universal dedication." The terms say any work
where CC0 does not apply is clearly marked with a warning in the relevant
documentation, so check the per-dataset notice if you reuse a dataset beyond
this server's read-only queries.

**Attribution:** not required, but requested. The terms ask for proper credit
and give this example:

> Data provided by the U.S. Food and Drug Administration
> (<https://open.fda.gov>)

**Caveats:** openFDA says not to rely on it for medical-care decisions and to
assume results are unvalidated. The NDC directory is a marketing listing, not
an approval or a statement that a product is on the market today.
Adverse-event data, where present, is voluntary and does not establish
causation.

## CosIng

| | |
| --- | --- |
| **Publisher** | European Commission, Directorate-General for Internal Market, Industry, Entrepreneurship and SMEs |
| **Upstream** | <https://ec.europa.eu/growth/tools-databases/cosing/> |
| **Coverage** | EU cosmetic ingredient inventory built from Regulation (EC) No 1223/2009, Directive 76/768/EEC, the glossary in Decision (EU) 2019/701, SCCS opinions, and the Annex II–VI listings. Includes active and historical entries. No product records. |
| **Identifiers** | CosIng substance id, INCI name, CAS number, EC number; functions, annex numbers, restriction and opinion text. |
| **Search types** | Ingredients: name, INCI, CAS, EC. CAS and EC matching is substring-based upstream, so hits are labeled `cas-substring` or `ec-substring` rather than exact registry matches. |
| **Lookups** | `drugdata_get_ingredient` (`cosing`) by numeric substance id or exact INCI/glossary name. |
| **Update cadence** | Updated by the Commission as the inventory and Annexes change; entries carry an active/not-active status. No fixed public release schedule. |

**Terms verified 2026-10-22:** the European Commission legal notice at
<https://commission.europa.eu/legal-notice_en>, with the database description
at
<https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en>.

The legal notice states that, unless otherwise indicated, content owned by
the EU on Commission websites is licensed under Creative Commons Attribution
4.0 International (CC BY 4.0): reuse is allowed "provided appropriate credit
is given and changes are indicated." It also excludes third-party works and
material covered by industrial-property rights.

**Attribution:** credit the European Commission and link to CosIng. Indicate
that values were retrieved and may have changed.

**CosIng-specific limits:** CosIng points to the Personal Care Products
Council (PCPC) as the authority for INCI names, and the Commission's reuse
notice excludes third-party works. CosIng is a search interface, not a
bulk-data offering. Do not treat the whole database as CC BY 4.0, do not
bulk-download it, and do not republish INCI names as if they were EU-owned
open data. This server queries the public search/detail interface read-only
and links back.

**Caveats:** CosIng has informative purpose and no legal value. An INCI name
in the inventory is not an authorization, and only Regulation (EC) No
1223/2009 and its Annexes establish whether and how a substance may be used.

## RxNorm

| | |
| --- | --- |
| **Publisher** | U.S. National Library of Medicine (NLM), National Institutes of Health |
| **Upstream** | <https://www.nlm.nih.gov/research/umls/rxnorm/> via the RxNav REST APIs |
| **Coverage** | Normalized clinical drug concepts and ingredient concepts, their NDC crosswalks, and RxTerms presentation fields. |
| **Identifiers** | RxCUI, NDC, UNII. |
| **Search types** | Products: name, NDC. Ingredients: name, UNII, RxCUI. |
| **Lookups** | `drugdata_get_ingredient` (`nlm`) by numeric RxCUI. |
| **Update cadence** | RxNorm publishes monthly full releases and weekly updates. This server uses the public RxNav APIs and does not download the full release. |

**Terms verified 2026-10-22:**
<https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html> and
the NLM Terms and Conditions at
<https://www.nlm.nih.gov/databases/download/terms_and_conditions.html>.

The RxNorm terms state that NLM-created normalized names and codes, including
RxCUI, are in the public domain, and that "it is requested that in any
subsequent use, NLM be given appropriate acknowledgement." Downloading the
full RxNorm release requires a free UMLS license; this server does not do
that. The terms request this statement for products that use RxNorm data:

> This product uses publicly available data courtesy of the U.S. National
> Library of Medicine (NLM), National Institutes of Health, Department of
> Health and Human Services; NLM is not responsible for the product and does
> not endorse or recommend this or any other product.

They also request the RxNorm citation: Nelson SJ, Zeng K, Kilbourne J, Powell
T, Moore R. Normalized names for clinical drugs: RxNorm at 6 years. J Am Med
Inform Assoc. 2011;18(4):441–448. doi:10.1136/amiajnl-2011-000116.

**NLM general terms:** acknowledge NLM as the source with "Courtesy of the
U.S. National Library of Medicine" in a clear and conspicuous manner; do not
imply NLM endorsement; if redistributing data, keep it current or clearly say
it may not reflect the current data.

**Caveats:** RxNorm is a terminology, not a clinical recommendation. NDC
crosswalks can include historical or package-specific values.

## DailyMed

| | |
| --- | --- |
| **Publisher** | U.S. National Library of Medicine (NLM); labeling is submitted to the FDA by companies |
| **Upstream** | <https://dailymed.nlm.nih.gov/> — DailyMed web services and SPL XML |
| **Coverage** | Structured Product Label documents for FDA-approved and additional regulated products, including human and animal drugs, some devices, cosmetics, dietary supplements, and medical foods. This server uses label documents, usage sections, and SPL ingredient rows. |
| **Identifiers** | SPL set id, NDC (search), UNII and ingredient names from SPL ingredient rows. |
| **Search types** | Products: name, NDC. |
| **Lookups** | `drugdata_get_product` (`dailymed`) by SPL set id; `include_label_sections` extracts usage sections. |
| **Update cadence** | Labels appear as companies submit them; DailyMed presents the most recent labeling currently in use. No fixed public cadence. |

**Terms verified 2026-10-22:** the NLM Terms and Conditions at
<https://www.nlm.nih.gov/databases/download/terms_and_conditions.html>, plus
the DailyMed About page at
<https://dailymed.nlm.nih.gov/dailymed/about-dailymed.cfm>. We found no
separate DailyMed data license on the About page; treat the NLM terms as
governing NLM data.

**Attribution:** the NLM acknowledgement above applies: "Courtesy of the U.S.
National Library of Medicine," no endorsement, and a clear statement if data
may not be current.

**Caveats:** NLM does not review SPL content before publication. "In use"
labeling on DailyMed may differ from the most recent FDA-approved labeling,
and unapproved products are labeled as such. Always check the current
official labeling before relying on a section.

## DrugCentral

| | |
| --- | --- |
| **Publisher** | University of New Mexico, Division of Translational Informatics, in collaboration with the Illuminating the Druggable Genome (IDG) project |
| **Upstream** | <https://drugcentral.org/> — DrugCentral DRS API |
| **Coverage** | Active-ingredient chemical structures, identifier crosswalks, ATC classifications, indications, off-label uses, contraindications, and FAERS disproportionality signals. DrugCentral structures are ingredients, not marketed products. |
| **Identifiers** | DrugCentral structId, UNII, RxCUI, CAS, and a crosswalk that includes DrugBank, ChEMBL, and other vocabularies. |
| **Search types** | Ingredients: name, UNII, CAS, RxCUI. |
| **Lookups** | `drugdata_get_ingredient` (`drugcentral`) by structId, UNII, dashed CAS, or a supported `TYPE:value` crosswalk id; `include_clinical` adds the clinical and FAERS sections. |
| **Update cadence** | Periodic releases; the site currently identifies itself as the 2027 update and says it monitors FDA, EMA, and PMDA approvals on a regular basis. |

**Terms verified 2026-10-22:** <https://drugcentral.org/privacy>.

The license page states: "DrugCentral is available under Creative Commons
license, download and use of this resource evidences your agreement to all
the terms and conditions of license." The linked license is **CC BY-SA 4.0**
(<https://creativecommons.org/licenses/by-sa/4.0/legalcode>): attribution and
share-alike apply to redistributed or adapted DrugCentral data.

**Requested citation:** the site links
<https://doi.org/10.1093/nar/gkac1085>. The paper is: Avram S, Wilson TB,
Curpan R, Halip L, Borota A, Bora A, Bologa CG, Holmes J, Knockel J, Yang JJ,
Oprea TI. DrugCentral 2023 extends human clinical data and integrates
veterinary drugs. Nucleic Acids Res. 2023;51(D1):D1276–D1287.

**Caveats:** there is no NDC → structure path upstream, so this server does
not offer one. Clinical assertions are source assertions, not treatment
recommendations. FAERS values are report contingencies, not incidence rates
or proof of causation. The public API host can change; the adapter reports a
DrugCentral-specific failure rather than leaking a URL or client detail.

## DSLD (Dietary Supplement Label Database)

| | |
| --- | --- |
| **Publisher** | National Institutes of Health (NIH), Office of Dietary Supplements (ODS) |
| **Upstream** | <https://dsld.od.nih.gov/> — DSLD v9 REST API |
| **Coverage** | US dietary supplement labels, both on-market and off-market: product names, brands, ingredient rows and quantities, claims, net contents, target groups, and barcodes. |
| **Identifiers** | DSLD label id, barcode/UPC, ingredient names, UNII codes on label rows, and CAS numbers where the nutrient-info enrichment supplies them. |
| **Search types** | Products: name, brand, ingredient, barcode. |
| **Lookups** | `drugdata_get_product` (`dsld`) by numeric label id. |
| **Update cadence** | Periodic versioned releases; the v9 API is current, and labels are added and updated between releases. |

**Terms verified 2026-10-22:** the official API guide at
<https://dsld.od.nih.gov/api-guide>. The standalone
`https://dsld.od.nih.gov/terms-and-conditions` URL returned no content when
fetched on that date, so licensing was verified on the API guide instead.

The API guide states: "DSLD data are in the public domain and they are not
copyrighted. They are published under CC0 1.0 Universal (CC0 1.0). No
permission is needed for their use, but we request that developers list DSLD
as the source of the data, and when possible, notify us of the product that
uses the data so we may better track how DSLD is being used in the public
domain."

**Suggested citation:**

> National Institutes of Health, Office of Dietary Supplements. Dietary
> Supplement Label Database, 2026. <https://dsld.od.nih.gov/>.

**Access limits:** 1,000 requests per hour per IP without a key; 10,000 per
hour with a data.gov key. The server supports `DSLD_API_KEY` for the higher
limit.

**Caveats:** ODS does not verify that labels meet FDA requirements. A label
can be incomplete or inaccurate, and inclusion is not an endorsement.

## INKEEDecoder

| | |
| --- | --- |
| **Publisher** | INKEEDecoder, an independent site (formerly INCIDecoder; based in Hungary). Not affiliated with the European Commission, PCPC, or this project. |
| **Upstream** | <https://inkeedecoder.com/> |
| **Coverage** | Cosmetic product pages with INCI ingredient lists, and ingredient pages with functions, irritancy and comedogenicity ratings, editorial write-ups, references, and an optional CosIng CAS/EC/IUPAC panel. Editorial content, not a regulatory database. |
| **Identifiers** | Product slug, ingredient slug, INCI name; CAS and EC numbers from the CosIng panel. |
| **Search types** | Products: name, brand (a name search — the site has no brand entity), ingredient. Ingredients: name, INCI. |
| **Lookups** | `drugdata_get_product` (`inkeedecoder`) by product slug or URL; `drugdata_get_ingredient` (`inkeedecoder`) by ingredient slug or URL. `include_cosing_panel` adds one upstream request. |
| **Update cadence** | Editorial and continuous; no published schedule. |

**Terms verified 2026-10-22:** <https://inkeedecoder.com/termsofservice>. The
site's `robots.txt` at <https://inkeedecoder.com/robots.txt> was also checked:
it allows `/` and disallows only `/auth/` and `/products/recommend/`.

This is the one source in the server that is **not** an open-data or
government database. Its terms state, among other restrictions:

> All content and images published by the Service, except user-generated
> content and submissions, are owned solely by us. We retain all rights to
> our content. Any unauthorized copying, reproduction, republishing,
> uploading, posting, transmitting, or duplicating of any of the material is
> prohibited without express written permission from the website.

> You may not duplicate, create derivative works, distribute, or otherwise
> make any commercial use of any content, materials, or databases from the
> Service or our website. You are permitted to keep information for your own
> non-commercial purposes.

The terms expressly address automated crawlers and scrapers as users bound by
the agreement. There is no open license and no explicit attribution clause.

**What this server does about it:** it treats INKEEDecoder as a read-only,
rate-limited source for the public product and ingredient pages that
`robots.txt` permits. It fetches at most one page per second, never crawls a
whole category or bulk-downloads, limits page prose to the fields a caller
requests (labeled verbatim and bounded by the response character limit), and
always links back to the page. Attribution is given anyway ("INKEEDecoder"
plus the deep link), even though the terms do not require it.

**Caveats:** the site's ratings and write-ups are editorial opinion, not
medical or regulatory conclusions. Its CosIng panel is a convenient copy of
upstream CosIng data, not an independent authority. If the terms or site
change, disable this adapter with `DRUGDATA_DISABLED_SOURCES=inkeedecoder`;
the rest of the server does not depend on it. Do not redistribute
INKEEDecoder content without permission.

## Verification log

All pages below were fetched on **2026-10-22**.

| Source | URL | Result |
| --- | --- | --- |
| openFDA | <https://open.fda.gov/terms/> | Fetched. CC0 1.0 with requested credit; third-party exclusions. |
| CosIng | <https://commission.europa.eu/legal-notice_en> | Fetched. CC BY 4.0 for EU-owned content; third-party works excluded; attribution and changes required. |
| CosIng | <https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en> | Fetched. Database description, PCPC/INCI source, non-binding status. The interactive search UI itself does not render to a plain fetch; it was queried through its public API during this task. |
| RxNorm | <https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html> | Fetched. Public-domain normalized names/codes; requested statement and citation; UMLS license for full release. |
| NLM (RxNorm, DailyMed) | <https://www.nlm.nih.gov/databases/download/terms_and_conditions.html> | Fetched. Acknowledgement, no endorsement, currency disclosure. |
| DailyMed | <https://dailymed.nlm.nih.gov/dailymed/about-dailymed.cfm> | Fetched. Coverage and "in use" labeling caveats; no separate license terms. |
| DrugCentral | <https://drugcentral.org/privacy> | Fetched. CC BY-SA 4.0; citation DOI. |
| DSLD | <https://dsld.od.nih.gov/api-guide> | Fetched. CC0 1.0; source listing requested; suggested citation; rate limits. |
| DSLD | <https://dsld.od.nih.gov/terms-and-conditions> | **Could not be verified:** the URL returned no content on 2026-10-22. Licensing was taken from the API guide instead. |
| INKEEDecoder | <https://inkeedecoder.com/termsofservice> | Fetched. All rights reserved; no copying, republishing, derivative works, or commercial use; non-commercial personal use only. |
| INKEEDecoder | <https://inkeedecoder.com/robots.txt> | Fetched. Allows `/`; disallows `/auth/` and `/products/recommend/`. |

## Reporting a problem

If a source's terms change, a page disappears, or an attribution requirement
is missed, open an issue in the repository. If you believe this server
misattributes or misrepresents your data, say so and the adapter can be
disabled or corrected.
