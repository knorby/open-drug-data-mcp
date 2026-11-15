---
name: open-drug-data
description: Use when researching drugs, ingredients, dietary supplements, or cosmetics, or when looking up an NDC, UNII, RxCUI, CAS, EC, INCI, CID, PMID, or NCT identifier. Searches openFDA, CosIng, RxNorm, DailyMed, DrugCentral, DSLD, INKEEDecoder, and PubChem; resolves identifiers across databases; fetches full records with citations and confidence labels; and searches NLM reference sources — PubMed literature, ClinicalTrials.gov studies, MedlinePlus pages, RxClass, MeSH, UMLS, and the prescribable drug dataset.
---

# Open Drug Data

Open Drug Data is a local MCP server that puts openFDA, CosIng, RxNorm,
DailyMed, DrugCentral, NIH DSLD, INKEEDecoder, PubChem, and the NLM reference
sources behind one read-only research interface. Every record is credited to the
upstream database that supplied it and carries a deep link. The server queries
the sources at request time; it does not mirror or redistribute their data.

This skill lives in the repository under `skills/open-drug-data/`. The npm
package does not ship it — install it from the project's GitHub repository
alongside the server.

**Informational and research use only — not medical advice.** This server does
not diagnose, treat, prescribe, or recommend anything, and it does not create a
clinician-patient relationship. Do not use its output to decide whether to
start, stop, or change a medicine, supplement, or cosmetic, and do not delay
professional care because of something it returned. In an emergency, contact
local emergency services. Full source terms and caveats are in the project's
`docs/SOURCES.md`.

## When to use this skill

Use it when a task involves:

- A drug, biologic, dietary supplement, or cosmetic product.
- A product label, supplement facts panel, ingredient list, or regulatory
  annex entry.
- An identifier lookup: NDC, UNII, RxCUI, CAS, EC, INCI, SPL set id, DSLD
  label id, barcode, PubChem CID, or a source-specific slug.
- Cross-source identity: deciding whether two records describe the same
  ingredient or product.
- The literature and context around a substance: PubMed articles,
  ClinicalTrials.gov studies, drug classes, MeSH descriptors, consumer-health
  pages, or UMLS terminology.

Do not use it for emergencies, diagnosis, prescribing, or dosing decisions.
Answer those requests with the disclaimer above and a recommendation to consult
a qualified professional.

## The loop: search → resolve → get

Every task follows the same three moves. Do not invent or reshape an identifier
to force a lookup — but calling a lookup directly is fine when the user's
message already contains the database's own identifier (an NDC read off a
package, an RxCUI from another tool, a PMID in a citation). What is never fine
is guessing an id or reshaping one namespace into another.

1. **Search by what you have.**
   - `drugdata_search_products` takes `type`: `name`, `brand`, `ingredient`,
     `barcode`, or `ndc`, plus `query`. Add `category`: `medication`,
     `supplement`, or `cosmetic` only when the task is limited to one category.
   - `drugdata_search_ingredients` takes `type`: `name`, `inci`, `unii`, `cas`,
     `ec`, `rxcui`, or `cid`, plus `query`.
   - The server fans out to every source that declares the search type. A
     source that cannot answer is simply absent from the result.
2. **Resolve cross-source identity.**
   - `drugdata_resolve_identifiers` takes **exactly one** of `unii`, `ndc`,
     `rxcui`, `cas`, `inci_name`, `substance_name`, `spl_setid`, or `dsld_id`.
   - An ingredient identifier returns an identity graph: confident links,
     labeled candidate sets, and the identifiers the chain established.
   - A product identifier (`ndc`, `spl_setid`, `dsld_id`) returns the
     product's cross-source links plus its ingredient rows.
3. **Get the full record from the database that owns it.**
   - `drugdata_get_product` takes `source`: `openfda`, `dsld`, `dailymed`, or
     `inkeedecoder`, plus that database's own `id`.
   - `drugdata_get_ingredient` takes `source`: `openfda`, `cosing`,
     `drugcentral`, `nlm`, `inkeedecoder`, or `pubchem`, plus that database's
     own `id`.
   - Pass the id from the search or resolve result unchanged. Ids are
     source-specific even when they look alike.
4. **For what is written about a substance, search the references.**
   - `drugdata_search_references` searches one NLM reference source per call:
     `pubmed`, `clinicaltrials`, `medlineplus`, `medlineplus_genetics`,
     `medlineplus_connect`, `rxclass`, `mesh`, `umls`, or `prescribable`.
   - Results are link-first: a title, the stable identifier (PMID, NCT
     number, class id, MeSH id, CUI, or RxCUI), and a deep link — not article
     or study text. Continue with the returned `cursor` when `hasMore` is
     true.
   - `umls` needs `UMLS_API_KEY` in the server environment; without it that
     one source returns configuration advice while the others work.

Every search and resolve result ends with `nextSteps`: concrete follow-up calls
derived from the identifiers that were actually found. Follow them instead of
guessing. Use `drugdata_ping` when a source looks unavailable; it reports which
sources are enabled and whether optional keys are configured, with no network
call.

### Worked example: aspirin

**1. Search ingredients by name.**

```json
{ "type": "name", "query": "aspirin" }
```

`drugdata_search_ingredients` returns, among others, an openFDA substance:

```text
### openFDA — 1 result (page 1)
- **ACETYLSALICYLIC ACID** · UNII: R16CO5Y76E · CAS: 50-78-2
```

**2. Resolve the UNII.** It is the strongest pivot the result offers.

```json
{ "unii": "R16CO5Y76E" }
```

`drugdata_resolve_identifiers` returns an ingredient graph:

```text
## Identity — ACETYLSALICYLIC ACID
- Identifiers: UNII: R16CO5Y76E · CAS: 50-78-2 · EC: 200-064-1 · RxCUI: 1191
## Links (3)
- openFDA `R16CO5Y76E` — matched via unii (direct)
- CosIng `100042` — matched via inci (direct)
- RxNorm `1191` — matched via unii (direct)
## Candidates (2)
### DSLD — matched via ingredient-name (name-match)
### INKEEDecoder — matched via slug (name-match)
## Confidence
- 3 direct · 0 derived · 2 candidate sets
```

The DSLD and INKEEDecoder entries are deliberately weak, name-based candidates.
They are not links and must not be described as confirmed matches.

**3. Get the record from the database that owns it.** The RxNorm link carries
RxCUI `1191`, which is a `drugdata_get_ingredient` id under source `nlm`.

```json
{ "source": "nlm", "id": "1191" }
```

The result profiles the RxNorm concept, repeats its identifiers and source
link, and offers `nextSteps` derived from the identifiers it actually carries —
follow those rather than assuming a particular source will appear.

## Tool catalog

| Tool | Use it for | Key inputs |
| --- | --- | --- |
| `drugdata_ping` | Connectivity and configuration check. | Optional `message`. |
| `drugdata_search_products` | Find products by name, brand, ingredient, barcode, or NDC. | `type`, `query`, optional `category`, `page`. |
| `drugdata_search_ingredients` | Find ingredients by name, INCI, UNII, CAS, EC, RxCUI, or PubChem CID. | `type`, `query`, `page`. |
| `drugdata_get_product` | Fetch one product from the database that owns it. | `source`, `id`, `include_label_sections`, `include_ingredients`, `page`. |
| `drugdata_get_ingredient` | Fetch one ingredient profile from the database that owns it. | `source`, `id`, `include_clinical`, `include_cosing_panel`. |
| `drugdata_resolve_identifiers` | Walk cross-source identity from one identifier. | Exactly one identifier, `include_label_ingredients`, `resolve_ingredients`, `max_candidates`. |
| `drugdata_search_references` | Search one NLM reference source: PubMed, ClinicalTrials.gov, MedlinePlus, RxClass, MeSH, UMLS, prescribable RxNorm. | `source`, `type`, `query`, `limit`, `cursor`. |

The search, lookup, and resolve tools accept `response_format`: `markdown`
(default) or `json`. The flag changes only the text block;
`structuredContent` is always present.

## Identifier vocabulary

| Identifier | What it identifies | Sources that know it |
| --- | --- | --- |
| NDC | A US drug product or package code. | openFDA, RxNorm, DailyMed. |
| UNII | An FDA ingredient identifier. The best pivot between drug sources. | openFDA, RxNorm, DrugCentral, DailyMed ingredient rows, DSLD rows. |
| RxCUI | An RxNorm clinical concept. | RxNorm, DrugCentral crosswalks, some product records. |
| CAS | A chemical registry number, conventionally dashed (`50-78-2`). | openFDA substances, CosIng, DrugCentral, DSLD. |
| EC | A European Community number for a chemical substance. | CosIng. |
| INCI | A cosmetic ingredient name. A name, not an exact registry id. | CosIng, INKEEDecoder, openFDA. |
| SPL set id | A DailyMed Structured Product Label document. UUID-shaped. | DailyMed, openFDA labels. |
| DSLD label id | A dietary supplement label record. Positive integer. | DSLD. |
| structId | A DrugCentral chemical structure. Ingredients, not products. | DrugCentral. |
| CID | A PubChem chemical compound. | PubChem; DrugCentral crosswalks. |
| PMID | A PubMed article. | PubMed reference results. |
| NCT number | A ClinicalTrials.gov study. | ClinicalTrials.gov reference results. |
| CUI | A UMLS concept. | UMLS reference results. |
| MeSH id | A MeSH descriptor. | MeSH reference results. |
| Slug | An INKEEDecoder product or ingredient page. | INKEEDecoder. |
| Barcode | A UPC/EAN. | DSLD; openFDA package NDC candidates. |

### Bridges that exist

- **UNII is the hub.** Search an ingredient by name, resolve its UNII, then use
  the linked records. UNII connects openFDA, RxNorm, and DrugCentral directly.
  CosIng joins through INCI, not UNII, because its inventory keys on INCI names.
- **NDC → RxCUI → SPL set id.** Resolve the NDC to get the product's
  cross-source links. An RxCUI opens the RxNorm concept with
  `drugdata_get_ingredient` (`source: "nlm"`); an SPL set id opens the label
  with `drugdata_get_product` (`source: "dailymed"`). The product result also
  lists its ingredient rows, each carrying a UNII or INCI when the label has
  one.
- **INCI → CosIng.** Resolve `inci_name`, or search ingredients with
  `type: "inci"`, then fetch the exact CosIng record by its numeric substance
  id or exact INCI name. INKEEDecoder covers the product side of cosmetics.
- **RxCUI crosswalk or UNII → DrugCentral.** Use `drugdata_get_ingredient` with
  `source: "drugcentral"` and the numeric `structId`, the UNII, the dashed CAS
  number, or a supported `TYPE:value` crosswalk such as `RXCUI:1191`.
  DrugCentral describes ingredient structures, not marketed products.
- **Product → ingredient.** `drugdata_get_product` and product-level
  `drugdata_resolve_identifiers` return ingredient rows with roles and
  quantities. Resolve each row's UNII or INCI to reach its ingredient profile.

### Bridges that do not exist

- **NDC → DrugCentral.** DrugCentral has no NDC path upstream. Resolve the NDC
  to a UNII, RxCUI, or CAS first, then query DrugCentral by that identifier.
- **UNII → CosIng.** CosIng has no UNII key. Go through the INCI name.
- **Product id → ingredient lookup.** Product ids are not ingredient ids.
  Source namespaces also differ: a numeric `100042` is a CosIng substance id,
  not an RxCUI, structId, or DSLD label id.

## Reading results

### Confidence: links versus candidates

In `drugdata_resolve_identifiers` results:

- **`links[]` are trusted matches.** Each link's `matchedVia` names the key
  that matched and `confidence` grades that match rule, not a general promise:
  `direct` means the link was made on an exact, unique match of a key the
  source owns — the same UNII or RxCUI, or a unique exact INCI name at CosIng;
  `derived` means a documented crosswalk (NDC → RxCUI, an SPL bridge) or a
  unique exact-name match connected them. Read `matchedVia` to see which rule
  produced the link.
- **`candidates[]` need judgment.** A candidate set means a source had one or
  more plausible matches but not a confident one. The set records how it
  matched (`matchedVia`) and why it is weak (`reason`, often `name-match`).
  When a set shows more options upstream than it lists, it says so with
  `optionsTruncated` — raise `max_candidates` to see the rest.
- **Never present a candidate as fact.** Do not silently choose one, merge its
  data into another record, or describe it as the same ingredient. When identity
  matters, use a direct link, search the candidate by name to disambiguate, or
  ask the user which record is meant.
- **Zero links is a valid answer.** It means no confident cross-source match
  was found, not that the identifier is invalid.

The compact confidence count at the end of a resolve result reports how many
direct links, derived links, and candidate sets the response actually contains.

### Errors, zero matches, and pagination

- **Zero matches are normal.** An empty group is not an error. Try another
  search type, a broader name, or a different source before concluding the
  record is absent. For a full product name, retry `type: "name"` with only the brand
  (Natrol) or only the ingredient (melatonin); compare brand, variant, strength,
  and dosage form before selecting a record. `type: "brand"` reaches fewer sources.
- **An error group is one database failing.** Other groups remain valid.
  Retry the search (there is no single-source retry: one call re-queries the
  whole fan-out) or proceed with the rest; `drugdata_ping` shows whether a
  source is disabled or missing a key.
- **A malformed identifier is an error result**, not a miss. It names the
  search tool that finds a valid one. Use that tool rather than guessing.
- **One `page` applies to every source in a search fan-out and re-queries all
  of them.** Each group reports its own `page` and `hasMore`, so sources can
  run out of results at different pages. Read `hasMore` per group; do not
  assume a shared page count.
- **Lookups page their own collections.** `drugdata_get_product` pages
  ingredient rows and label sections; `drugdata_resolve_identifiers` caps
  per-ingredient graphs. The result says when a page or a cap is incomplete.
- **Nothing walks pages automatically.** Request `page + 1` only when the
  answer needs more records. Never fetch every page by default.
- **Responses are character-bounded.** When text or structured fields are
  shortened, the result says so; prefer a narrower request over assuming the
  record is complete.

## Cost flags

Turn a flag on only when the question needs what it adds. The defaults are
deliberate.

| Flag | Tool | What it costs | Use it when |
| --- | --- | --- | --- |
| `include_label_sections` | `drugdata_get_product` (DailyMed) | Extracts and returns SPL usage sections — dosage, directions, patient guidance. Large, often the biggest part of a response. Default `false`. | The task needs label instructions or patient-facing wording. Not for identity, brand, or ingredient-list questions. |
| `resolve_ingredients` | `drugdata_resolve_identifiers` | Runs the full identity chain once per ingredient — many upstream requests on a multi-ingredient product. Graphs cover a prefix of the rows, capped at 20. Default `false`. | The product has one or a few ingredients and each needs its own cross-source identity. For long ingredient lists, resolve individual rows from `nextSteps` instead. |
| `include_clinical` | `drugdata_get_ingredient` (DrugCentral) | Fetches indications, off-label uses, contraindications, and FAERS signals. Extra requests and often verbose. Default `false`. | The task is clinical or pharmacovigilance research. Not for identifying a structure or crosswalking an identifier. |
| `include_cosing_panel` | `drugdata_get_ingredient` (INKEEDecoder) | Includes the CosIng CAS/EC/IUPAC panel from the same page fetch — no extra request. Default `false`. | A cosmetic ingredient needs CAS, EC, or IUPAC data that the page profile does not already show. |
| `include_label_ingredients` | `drugdata_resolve_identifiers` | Parses SPL XML for ingredient UNIIs — an extra request. Default `false`. | A product record lacks ingredient identifiers and you need them to pivot to ingredient profiles. |

`drugdata_get_product` includes ingredient rows by default; set
`include_ingredients: false` only when the rows are irrelevant and response
size matters. Clinical and label content is source text, not a recommendation.
FAERS report counts are contingencies, not incidence rates, and do not establish
causation.

## Etiquette and attribution

- **Cite the upstream database and its deep link** in every answer. Say
  "according to openFDA" or "per DrugCentral", not "Open Drug Data says".
  Every search item and lookup record carries a `source` with `database`,
  `id`, `url`, and `retrievedAt`; use that link.
- **Do not present this server as the source.** It is an interface over public
  databases, not a database.
- **Keep regulatory and label text verbatim and attributed.** Quote briefly
  and name the source. Do not republish long passages or present a label
  section as your own conclusion.
- **Do not imply endorsement.** This project is independent and is not
  affiliated with or endorsed by the FDA, the European Commission, NIH, NLM,
  the University of New Mexico, or INKEEDecoder.
- **Respect upstream limits.** Do not bulk-download, mirror, or redistribute
  data. Query at request time, keep pagination deliberate, and leave
  INKEEDecoder's one-request-per-second pacing intact. Do not ask the server to
  crawl a category or enumerate a whole database.
- **Say what is uncertain.** Report an unavailable source, an unresolved
  candidate, or an identifier no database recognizes. A precise "not found"
  is better than a confident guess.

## Source caveats to carry into answers

- **openFDA** data is published as-is and is not validated for clinical use.
  The NDC directory is a marketing listing, not proof that a product is on the
  market today.
- **CosIng** is informative and has no legal value. An INCI name in the
  inventory is not an authorization; only Regulation (EC) No 1223/2009 and its
  Annexes establish regulatory status.
- **RxNorm** is a terminology, not a treatment recommendation. NDC crosswalks
  can include historical or package-specific values.
- **DailyMed** publishes labeling submitted by companies; NLM does not review
  it first. "In use" labeling may differ from the latest FDA-approved labeling.
- **DrugCentral** assertions are source assertions. FAERS values are report
  contingencies, not incidence rates or proof of causation.
- **DSLD** labels are manufacturer-supplied. ODS does not verify that a label
  meets FDA requirements, and inclusion is not an endorsement.
- **INKEEDecoder** is editorial content, not a regulatory or medical authority.
  Its ratings are opinions, and its CosIng panel is a copy of upstream data.

## Pitfalls

- **Do not try NDC → DrugCentral.** That path does not exist upstream. Resolve
  the NDC to UNII, RxCUI, or CAS first.
- **CosIng CAS and EC search is substring-based.** Hits are labeled
  `cas-substring` or `ec-substring`; they are not exact registry matches.
  Verify the exact number before treating a hit as the same substance.
- **Zero matches are not failures.** They are ordinary empty groups. A group
  with an `error` field is a source failure, and only that group is affected.
- **One page re-queries the whole fan-out.** Paging a product or ingredient
  search runs every source again, not just the one with more results. Use the
  per-group `hasMore` and page only when needed.
- **Do not invent or reshape identifiers.** Pass the database's id back
  unchanged. If a result offers `nextSteps`, use those calls; if it offers only
  candidates, disambiguate before proceeding.
- **Do not mix source namespaces.** Numeric ids in particular mean different
  things per database. Check the `source` before reusing an id.
- **Do not treat a product as an ingredient or the reverse.** Product lookups
  take product ids; ingredient lookups take ingredient ids. The tool error
  names the search that finds the right one.
