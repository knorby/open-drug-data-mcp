# Open Drug Data MCP

One research interface over open drug, supplement, and cosmetic data. A local
MCP server that searches public databases by the kind of value you have,
resolves identifiers across them, fetches full records with citations, and
pulls literature and classification references.

The server is read-only, runs over stdio, and is launched by an MCP host. It
does not cache, mirror, or redistribute any dataset.

## Not medical advice

**Informational and research use only — not medical advice.**

This server does not diagnose, treat, prescribe, or recommend anything. It
returns what public databases publish, and those databases carry their own
limits: openFDA data is unvalidated, supplement labels are manufacturer
statements, adverse-event reports do not establish causation, and regulatory
listings are not a determination of safety or approval. Always consult a
qualified physician, pharmacist, or other licensed professional before making
a health decision, and read the operative regulation or product labeling
rather than relying on a database summary.

The data comes from public sources with their own terms. Full disclaimers,
licenses, attribution requirements, and source caveats are in
[`docs/SOURCES.md`](docs/SOURCES.md).

## What it does

- **Search by what you have.** A product name, brand, ingredient, barcode, or
  NDC; an ingredient name, INCI name, UNII, CAS number, EC number, RxCUI, or
  PubChem CID. You never choose a database first — the server fans out to
  every source that can answer.
- **Resolve identity across sources.** One call walks the cross-source
  identity chain and returns trusted `links` (direct or derived) plus labeled
  `candidates` where the match is ambiguous. A link needs a direct identifier
  hit or a single top-tier name match; several plausible records stay
  candidates, and the chain never silently picks one.
- **Fetch the full record.** Product and ingredient lookups return the owning
  database's record, its identifier crosswalk, deep links, and suggested next
  calls.
- **Follow the literature and classifications.** A reference search covers
  PubMed, ClinicalTrials.gov, MeSH, MedlinePlus (topics, Genetics, Connect),
  UMLS, RxClass, and RxNorm's prescribable name list by name or identifier,
  returning titles, identifiers, and deep links — citations, not extracted
  article text.
- **Stay attributable.** Every result is credited to the upstream database
  with a deep link and a retrieval timestamp. Client libraries are never named
  in tool output.

The loop is **search → resolve → get**, plus a reference step for literature
and classification sources. Every search and resolution ends with
`nextSteps`, so an agent can continue without inventing an identifier.

## Quick start

**Not yet published.** The manifest is still `0.0.0` and the release workflow
is staged, so install from a local checkout for now. The `npx` configuration
is the intended setup once the first release is published.

### From a local checkout (current option)

```bash
npm install
npm run build
```

```json
{
  "mcpServers": {
    "open-drug-data": {
      "command": "node",
      "args": ["/absolute/path/to/open-drug-data-mcp/dist/index.js"]
    }
  }
}
```

### After the first release

Add the server to an MCP host. Most hosts accept a JSON block shaped like
this (see your host's documentation if it nests servers under a different
key):

```json
{
  "mcpServers": {
    "open-drug-data": {
      "command": "npx",
      "args": ["-y", "@knorby/open-drug-data-mcp"],
      "env": {
        "OPENFDA_API_KEY": "your-key",
        "DSLD_API_KEY": "your-key"
      }
    }
  }
}
```

Both keys are optional. Omit the `env` block entirely if you have neither;
keyless access works at a lower upstream rate limit.

Run `drugdata_ping` after connecting. It reports the server version, which
sources are enabled, and whether each source's optional key is configured —
never a key value.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENFDA_API_KEY` | unset | Optional openFDA key. Raises the upstream rate limit; keyless requests work. |
| `DSLD_API_KEY` | unset | Optional NIH DSLD key (from data.gov). Raises the limit from 1,000 to 10,000 requests per hour. Keyless requests work. |
| `UMLS_API_KEY` | unset | Required for the UMLS reference source only. A free UTS account API key under the UMLS Metathesaurus license. Without it, other sources work and the UMLS reference source returns a configuration error naming this variable. |
| `NLM_PUBMED_API_KEY` | unset | Optional NCBI E-utilities key for PubMed. Raises the rate limit. |
| `NLM_PUBMED_EMAIL` | unset | Optional contact address NCBI asks distributed software to send with PubMed requests. |
| `NLM_PUBMED_TOOL` | unset | Optional tool name NCBI asks distributed software to send with PubMed requests. |
| `DRUGDATA_TIMEOUT_MS` | `30000` | Per-request upstream timeout in milliseconds. Must be a positive integer when set; a blank value counts as unset. |
| `DRUGDATA_DISABLED_SOURCES` | unset | Comma-separated adapter ids to switch off: `openfda`, `cosing`, `nlm`, `drugcentral`, `dsld`, `inkeedecoder`. `nlm` covers every NLM namespace (RxNorm, RxTerms, RxClass, DailyMed, MeSH, PubMed, MedlinePlus, UMLS, ClinicalTrials.gov) and the PubChem adapter, which shares the NLM client. Applies to searches, lookups, resolution, and reference searches. Unknown ids are a configuration error. |

Configuration is read lazily when a tool runs, never at startup. A
misconfigured server still answers `tools/list` and explains the problem
through a tool result. Blank API-key values count as unset, and a blank
`DRUGDATA_TIMEOUT_MS` falls back to the default; a non-blank value must be a
positive integer.

## Tools

| Tool | Inputs | Returns |
| --- | --- | --- |
| `drugdata_ping` | optional `message` | Server name/version, every source's enabled state and whether its key is configured (including UMLS and PubMed reference keys), never a key value. No network. |
| `drugdata_search_products` | `type`: `name`, `brand`, `ingredient`, `barcode`, `ndc`; `query`; optional `category`: `medication`, `supplement`, `cosmetic`; `page`; `response_format` | Product groups per upstream database, each item carrying identifiers, a deep link, and `matchBasis` where the match is weak. |
| `drugdata_search_ingredients` | `type`: `name`, `inci`, `unii`, `cas`, `ec`, `rxcui`, `cid`; `query`; `page`; `response_format` | Ingredient groups per database, with UNII/CAS/EC/RxCUI and other identifiers the source knows. PubChem answers name and CID searches. |
| `drugdata_get_product` | `source`: `openfda`, `dsld`, `dailymed`, `inkeedecoder`; `id`; `include_label_sections` (default `false`); `include_ingredients` (default `true`); `page`; `response_format` | One product record, its ingredient rows and roles, source-specific details, links, and next steps. DailyMed usage sections are opt-in because they are large. |
| `drugdata_get_ingredient` | `source`: `openfda`, `cosing`, `drugcentral`, `nlm`, `inkeedecoder`, `pubchem`; `id`; `include_clinical` (default `false`); `include_cosing_panel` (default `false`); `response_format` | One ingredient profile: identifiers, names, functions, regulatory notices, clinical assertions, chemistry (PubChem), RxTerms presentation (RxNorm), links, and next steps. DrugCentral clinical data and the INKEEDecoder CosIng panel are opt-in. |
| `drugdata_resolve_identifiers` | exactly one of `unii`, `ndc`, `rxcui`, `cas`, `inci_name`, `substance_name`, `spl_setid`, `dsld_id`; `include_label_ingredients` (default `false`); `resolve_ingredients` (default `false`); `max_candidates` (default `5`); `response_format` | An identity graph for an ingredient, or a product's cross-source links plus its ingredient rows. `links` are trusted; `candidates` need judgment. |
| `drugdata_search_references` | `source`: `prescribable`, `rxclass`, `mesh`, `pubmed`, `medlineplus`, `medlineplus_genetics`, `medlineplus_connect`, `umls`, `clinicaltrials`; `type`: `name` (default), `rxcui`, `ndc`, `cui`; `query`; `limit` (default `10`); `cursor`; `response_format` | Titles, identifiers (PMID, NCT, MeSH id, CUI, RxCUI, class id), and deep links from one NLM reference source per call. Paginated sources return an opaque `cursor`. UMLS requires `UMLS_API_KEY`. |

Pagination is per call. One `page` applies to every source in a search
fan-out, and each group reports its own `hasMore`. Lookups page their own
collections. Reference searches page through the `cursor` the previous
response returned. Nothing walks pages automatically.

Every result carries `structuredContent` validated against a closed schema,
plus a readable markdown text block. Search, lookup, and resolve tools accept
`response_format`; set it to `json` if a host wants JSON in the text block
too.

## Worked example: aspirin

These calls were run against the live sources on 2026-10-22. Output is
abridged.

**1. Search by name.**

```json
{ "type": "name", "query": "aspirin" }
```

`drugdata_search_ingredients` returns (among others):

```text
### openFDA — 1 result (page 1)
- **ACETYLSALICYLIC ACID** · UNII: R16CO5Y76E · CAS: 50-78-2 · https://api.fda.gov/other/substance.json?search=unii%3A%22R16CO5Y76E%22&limit=1
```

**2. Resolve the UNII.**

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
- Acetylsalicylic acid — https://dsld.od.nih.gov/ingredient/Acetylsalicylic%20acid
### INKEEDecoder — matched via slug (name-match)
- Acetylsalicylic Acid · slug: acetylsalicylic-acid — https://inkeedecoder.com/ingredients/acetylsalicylic-acid
## Confidence
- 3 direct · 0 derived · 2 candidate sets
```

The DSLD and INKEEDecoder entries are deliberately weak, name-based
candidates. The result never promotes them to links.

**3. Fetch the full record from the database that owns it.**

```json
{ "source": "nlm", "id": "1191" }
```

`drugdata_get_ingredient` returns the RxNorm concept `aspirin` (term type
`IN`), its identifiers, an RxTerms presentation block, source link, and next
steps such as opening the CosIng ingredient or resolving a product NDC.

**4. Pull the literature.**

```json
{ "source": "pubmed", "query": "aspirin" }
```

`drugdata_search_references` returns article titles with PMIDs and PubMed
links (ten per page, with a cursor for more). Other reference sources answer
the same shape of question: `clinicaltrials` for studies, `mesh` for
descriptors, `medlineplus` for consumer health topics, `umls` for
Metathesaurus concepts, `rxclass` for drug classes.

## Sourcing and attribution

- **Cite the upstream database, not this server.** Each result names the
  database that supplied it (openFDA, CosIng, RxNorm, RxTerms, RxClass,
  DailyMed, DrugCentral, DSLD, INKEEDecoder, MeSH, PubMed, MedlinePlus, UMLS,
  ClinicalTrials.gov, or PubChem) and includes a deep link.
- **Regulatory and label text is verbatim.** Summarize or quote briefly with
  attribution; do not republish long passages.
- **Do not imply endorsement.** This project is independent and is not
  affiliated with or endorsed by the FDA, the European Commission, NIH, NLM,
  the University of New Mexico, or INKEEDecoder.
- **Respect upstream limits.** No bulk download or mirroring. The server
  honors a one-request-per-second pace for INKEEDecoder, supports optional
  openFDA, DSLD, and PubMed keys, requires a UMLS key for the UMLS reference
  source, and never auto-walks pagination.
- **Keep identifiers intact.** Pass a database's own id back unchanged when
  following a result's `nextSteps`.

Attribution wording, licenses, and per-source caveats are in
[`docs/SOURCES.md`](docs/SOURCES.md).

## Data sources

| Database | Covers | Identifiers |
| --- | --- | --- |
| [openFDA](https://open.fda.gov/) | US drug products, labels, and ingredient substances | NDC, UNII, CAS, SPL set id, application number |
| [CosIng](https://ec.europa.eu/growth/tools-databases/cosing/) | EU cosmetic ingredients, functions, and annex listings | CosIng substance id, INCI name, CAS, EC |
| [RxNorm](https://www.nlm.nih.gov/research/umls/rxnorm/) | Normalized clinical drug concepts and the prescribable name list (NLM) | RxCUI, NDC, UNII |
| [RxTerms](https://www.nlm.nih.gov/research/umls/rxnorm/rxterms.html) | Presentation names for clinical drugs (NLM RxNav) | RxCUI |
| [RxClass](https://www.nlm.nih.gov/research/umls/rxnorm/rxclass.html) | Drug classifications across relationship sources (NLM RxNav) | class id, RxCUI |
| [DailyMed](https://dailymed.nlm.nih.gov/) | Structured Product Label documents (NLM) | SPL set id, NDC, label ingredient UNIIs |
| [DrugCentral](https://drugcentral.org/) | Active-ingredient structures, crosswalks, ATC, clinical assertions, FAERS signals | structId, UNII, RxCUI, CAS |
| [DSLD](https://dsld.od.nih.gov/) | US dietary supplement labels (NIH ODS) | DSLD label id, barcode, ingredient names, UNIIs, CAS |
| [INKEEDecoder](https://inkeedecoder.com/) | Cosmetic products and ingredient pages | product/ingredient slug, INCI name, CAS, EC |
| [MeSH](https://id.nlm.nih.gov/mesh) | Biomedical subject headings and supplementary concept records (NLM) | MeSH descriptor id |
| [PubMed](https://pubmed.ncbi.nlm.nih.gov/) | Biomedical literature citations (NLM/NCBI) | PMID |
| [MedlinePlus](https://medlineplus.gov/) | Consumer health topics, Genetics pages, Connect drug pages (NLM) | topic/page URL |
| [UMLS](https://uts.nlm.nih.gov/) | Metathesaurus concepts across vocabularies (NLM) | CUI |
| [ClinicalTrials.gov](https://clinicaltrials.gov/) | Registry of clinical studies (NLM) | NCT number |
| [PubChem](https://pubchem.ncbi.nlm.nih.gov/) | Chemical compound records (NCBI) | CID, InChIKey |

Not every source answers every search type. A source that cannot answer is
simply absent from the result; a source that fails contributes an error
group, and the other groups remain valid. Zero matches are a normal result,
not an error.

## Development

Requirements: Node 22+ (Node 24 LTS recommended), npm, and the repository's
git hooks if you are contributing. See [`AGENTS.md`](AGENTS.md) for the full
setup.

```bash
npm install
npx husky                # .npmrc blocks lifecycle scripts
pre-commit install       # file hygiene + secret scanning
```

| Command | What it does |
| --- | --- |
| `npm run build` | Build the ESM bundle and type declarations. |
| `npm run dev` | Run from source with a watch loop. |
| `npm test` | Run the Vitest suite. |
| `npm run test:coverage` | Run tests with 100% thresholds on statements, branches, functions, and lines. |
| `npm run typecheck` | Type-check `src/` and `tests/`. |
| `npm run lint` | Biome lint and formatting check. |
| `npm run check` | Biome lint and format, writing changes. |
| `npm run test:smoke` | Inspector CLI `tools/list` against the built server. |
| `npm run inspect` | Open the MCP Inspector against the built server. |

The suite uses an in-process MCP client for tool tests, a spawned stdio test
for the built binary, and fixture-backed HTTP stubs for every source. No test
requires an API key or the network.

### Project layout

```text
src/
  index.ts            stdio entrypoint
  server.ts           createServer(): registrations, fixed order, instructions
  config.ts           lazy environment configuration
  clients.ts          one shared client per source, uniform fetch policy
  sources/
    types.ts          adapter contract and capability declarations
    registry.ts       search fan-out and lookup routing
    openfda.ts        openFDA adapter
    cosing.ts         CosIng adapter
    nlm.ts            RxNorm + DailyMed adapter (with RxTerms profiles)
    nlm-references/   reference search handlers + cursors (one NLM source per call)
    drugcentral.ts    DrugCentral adapter
    dsld.ts           NIH DSLD adapter
    inkeedecoder.ts   INKEEDecoder adapter
    pubchem.ts        PubChem compound adapter (shares the NLM client)
    identity/         two-pass identity chain, SPL parsing, barcode parsing
  tools/              seven tool registrations
  resources/          server://info
  prompts/            research_drug
tests/                fixtures and integration tests
docs/SOURCES.md       source terms, licenses, attribution
docs/decisions/       architecture decision records
```

## Releasing

Versioning uses Changesets. Add a changeset for any change that affects
published output, then merge; `npx changeset version` updates the manifest and
changelog, and `npm run release` builds and publishes.

The GitHub Actions release workflow is intentionally staged at
`workflow-templates/release.yml` and is inactive while the repository is
private. Activation is a deliberate step after the public move:
`git mv workflow-templates/release.yml .github/workflows/release.yml`, then
configure the npm trusted publisher and the `release` environment as
described in [`AGENTS.md`](AGENTS.md).

## Documentation

- [`docs/SOURCES.md`](docs/SOURCES.md) — per-database coverage, terms,
  licenses, attribution, and update cadence.
- [`docs/decisions/`](docs/decisions/) — architecture decision records.
- [`AGENTS.md`](AGENTS.md) — contributor and agent instructions, sourcing
  policy, and release setup.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development workflow and commit
  conventions.
- [`skills/open-drug-data/SKILL.md`](https://github.com/knorby/open-drug-data-mcp/blob/main/skills/open-drug-data/SKILL.md) — an
  installable agent skill teaching the search → resolve → get loop.

## License

[Apache-2.0](LICENSE) © Kali Norby ([@knorby](https://github.com/knorby))

The software license does not relicense any upstream data. Each database keeps
its own terms; see [`docs/SOURCES.md`](docs/SOURCES.md).
