# ADR-0005: Cover every NLM namespace through a link-first reference tool

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The NLM client used by this server exposes fourteen namespaces: `rxNorm`,
`prescribable`, `rxClass`, `rxTerms`, `dailyMed`, `identifiers`, `mesh`,
`pubMed`, `medlinePlus`, `medlinePlusGenetics`, `medlinePlusConnect`, `umls`,
`clinicalTrials`, and `pubChem`. Before this decision, the server used only
`rxNorm`, `dailyMed`, `identifiers`, and one `rxTerms` call — most of what
the client offers was installed but unreachable, which a review rightly
called a poor scoping decision.

The remaining namespaces split by shape:

- **Reference-shaped sources** answer "what exists about this term?" —
  literature citations (PubMed), study registrations (ClinicalTrials.gov),
  subject headings (MeSH), consumer health pages (MedlinePlus, Genetics,
  Connect), classification systems (RxClass), prescribable-name lists
  (prescribable), and vocabulary concepts (UMLS). None of them are products
  or ingredients, so they do not fit `drugdata_search_products` /
  `drugdata_search_ingredients`, and stuffing them into product profiles
  would bury real search capability behind opt-in flags.
- **Chemistry-shaped data** (PubChem) is ingredient-shaped: a compound with
  a name, formula, molecular weight, and InChIKey fits ingredient search and
  profiles naturally.

A second constraint came from the same review: licensing and terms. PubMed
abstracts may carry publisher copyright, MedlinePlus embeds licensed ASHP and
A.D.A.M. content, and the UMLS Metathesaurus mixes in copyrighted source
vocabularies. Extracting full article or page text would move this server
from citing sources toward redistributing them. Meanwhile the project rule
"A link is valid if data is not extracted" was confirmed as the intended
posture: a deep link back to the upstream record is a usable, legitimate
result.

Finally, UMLS is the one gated source: its API requires a free UTS account
key, so it cannot be assumed present the way keyless NLM services can.

## Decision

- **Add one tool, `drugdata_search_references`**, that queries a single NLM
  reference source per call. Input is `source` (one of `prescribable`,
  `rxclass`, `mesh`, `pubmed`, `medlineplus`, `medlineplus_genetics`,
  `medlineplus_connect`, `umls`, `clinicaltrials`), `type` (`name` by
  default; `rxcui`, `ndc`, or `cui` where the source supports them),
  `query`, `limit`, and an opaque `cursor`. Output is exactly one
  reference group: titles, closed identifier fields (PMID, NCT, MeSH id,
  CUI, RxCUI, class id), deep links, and provenance. Invalid source/type
  combinations are rejected before any network call.
- **Keep results link-first.** The tool returns citations and links, not
  article text, page text, or study records. This is the terms-respecting
  posture for PubMed, MedlinePlus, and ClinicalTrials.gov, and it keeps
  responses small.
- **Make PubChem an adapter, not a reference source.** It joins
  `drugdata_search_ingredients` (name and CID searches) and adds a
  `chemistry` block to `drugdata_get_ingredient` profiles. It shares the
  NLM client and the `nlm` disable id rather than introducing a new
  switch, and it stays out of the identity chain and category filtering:
  a CID is a compound, not a product or a regulatory identity.
- **Gate UMLS on `UMLS_API_KEY`.** Without the key the UMLS reference
  source returns an authored configuration error naming the variable and
  makes no network call; `drugdata_ping` reports the key's presence. All
  other new surfaces are keyless. PubMed accepts optional
  `NLM_PUBMED_API_KEY`, `NLM_PUBMED_EMAIL`, and `NLM_PUBMED_TOOL`
  identification per NCBI's E-utilities guidelines.
- **Paginate with opaque, stateless cursors.** PubMed offsets,
  ClinicalTrials.gov page tokens, and MedlinePlus continuation handles
  differ per source, so the tool returns an encoded, versioned cursor that
  validates the source, type, query, and limit it was issued for. Sources
  with no upstream pagination report a limitation instead of pretending.
- **Do not extend the identity chain.** The chain's bridges are product and
  ingredient identifiers (UNII, INCI, RxCUI, NDC, SPL set id). CUIs and
  CIDs are lookup aids, not cross-source identities for a drug product,
  and RxClass memberships are classification, not identity.

## Consequences

- All fourteen NLM client namespaces are now reachable through seven tools
  that keep the type-discriminated shape: nothing forced the per-source
  tool sprawl this project rejects.
- Literature and classification searches return links the caller can cite.
  An agent wanting abstracts or full study records follows the links; the
  server never republishes that text, which keeps it inside the verified
  terms for each source (recorded in `docs/SOURCES.md`).
- The tool surface grows from six to seven, and `DatabaseId` grows from
  seven to fifteen labels. Both are additive; existing callers see no
  change.
- Cursor validation makes malformed or stale cursors a model-facing input
  error rather than a corrupted page, at the cost of one more error path
  to test.
- UMLS coverage depends on the operator setting `UMLS_API_KEY`. The
  configuration error is authored, lazy, and specific; the rest of the
  server is unaffected.
- Excluded by this decision: MedlinePlus Genetics native page fetches and
  raw MeSH SPARQL passthrough. Genetics pages are reachable as search
  links (their content is condition/gene pages, not drug research), and
  raw SPARQL is an arbitrary-query surface this server's bounded tools do
  not expose.
