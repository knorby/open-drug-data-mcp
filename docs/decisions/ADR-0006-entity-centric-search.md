# ADR-0006: Entity-centric search with bounded identity enrichment

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

Source-grouped fan-out made the caller reconcile duplicate identities, missed
useful crosswalks, and capped follow-ups before later databases appeared.
Live checks also found a false DrugCentral CID mapping, lost DSLD search ids,
and unverified direct RxCUI links. Search must assemble evidence without
inventing identity or fetching every full profile.

## Decision

Keep seven tools and existing source+id lookups. Both searches return
`query`, `type`, optional product `category`, `page`, `entities`, `sources`,
`coverage`, `partial`, and top-level paging `nextSteps`. Entities retain original
source records and per-record lookup actions, combined identifiers,
resolver-only confirmed links, grouping evidence, attributed scalar conflicts,
unconfirmed candidates, and resolution state.

Deduplicate database+id first, then join exact normalized strong evidence.
Ingredients use UNII, RxCUI, dashed CAS, CID, or InChIKey; products use full
package NDC, SPL set id, or UPC. Names, EC numbers, product RxCUI, and
application numbers alone do not join. Strong joins survive conflicting
scalar evidence, which remains visible. Enrichment retains attributed
ingredient refs internally, without adding them to the original search records.

Default searches cluster evidence already returned by sources, without
identity resolution. `resolve_identities: true` opts in to enriching the first
five resolvable initial entities, concurrency three, through the existing
identity resolver. Unrequested resolution has zero attempted/completed counts,
no cap, and does not make healthy results partial. Use one shared 45,000 ms search deadline,
configurable by `DRUGDATA_SEARCH_TIMEOUT_MS`; preserve completed source
subgroups and stop scheduling at expiry. Cancel supported calls, ignore late
settlements, and handle their rejections. Existing 30,000 ms per-attempt fetch
timeouts and bounded 429 retry stay unchanged. No cache, mirroring, page walks,
new dependencies, or default full-profile fetches.

DrugCentral CID comes only from explicit `PUBCHEM_CID`, never `cd_id`.
DSLD envelope `_id` takes precedence over legacy embedded ids. Fetch an
RxNorm concept before publishing an input RxCUI as a direct link. PubChem
CID resolution verifies the compound and follows exact DrugCentral crosswalks;
multiple compounds stay candidates.

For response limits, slim summaries and derived collections before removing
trailing entities (retain at least one), records, and large identifier arrays.
Rebuild actions after record/identifier loss; never rewrite retained values or
provenance URLs. A minimal entity shell is the last resort; if that cannot fit,
return an explicit error rather than an empty successful page. `truncated`,
`entitiesOmitted`, and per-entity `omitted` counts report output loss and set
`partial: true` without changing the entity's resolution state;
coverage continues to describe the full pre-bound search.

Alternatives: retaining source groups leaves identity work to the model;
unbounded enrichment wastes requests and makes latency unpredictable.
Bounded server-side grouping gives a useful entity picture with explicit
limits and existing get tools as the selective detail path.

## Consequences

The unreleased search interface returns `entities` and source metadata; there
is no released consumer contract to migrate or version against.
Evidence can remain ambiguous or conflict. A search may be partial even when
its returned records are valid, and completed enrichment is not exhaustive
database coverage. Bounding can omit trailing entities or slim the final entity,
with counted omissions; a non-empty result retains at least one entity or
returns an explicit error. Narrow the query or use a known source+id for details.
Uncancellable clients remain bounded by
their existing per-attempt policy, not by the search-return deadline.
