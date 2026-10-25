# ADR-0003: Identity chain port and confidence policy

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The research loop this server implements was proven in ritualog, which
resolved a drug or ingredient across the same upstream databases and persisted
the result in SQLite for a human UI. An MCP does not need persistence; it
needs to return a linked graph an agent can act on immediately, plus an
honest account of what remains ambiguous.

The hard part is not fetching records. It is deciding when two records from
different databases name the same substance. Names collide, salts and
mixtures complicate ingredient identity, identifier coverage is asymmetric,
and some upstream matches are substring or name-based rather than exact.

## Decision

- **Port the chain, drop the persistence.** `drugdata_resolve_identifiers`
  runs the same step order and confidence rules as the ritualog chain and
  returns an `IdentityGraph` instead of writing rows.
- **Fixed step order: openFDA → CosIng → RxNorm (NLM) → DrugCentral.** Each
  step consumes whatever identifiers the previous steps established. The
  order is stable so links and candidate sets can be sorted deterministically
  and tests can reason about precedence.
- **Two passes, never a fixpoint.** Pass 1 runs every step. Pass 2 re-runs a
  step only when the signature of its inputs changed (for example, a CAS
  input did not resolve at openFDA, CosIng supplied an INCI name, and openFDA
  can now answer a name search). A step that linked, returned candidates, or
  failed is never retried.
- **Effective-UNII precedence.** When the chain needs one UNII, an openFDA
  link wins over the caller's input UNII. This follows the ritualog rule:
  the database record is the stronger anchor once it is established.
- **Confidence is explicit.** A `link` is `direct` when it came from the same
  identifier the caller supplied or an exact identifier hit, and `derived`
  when it came through a documented crosswalk. A single top-tier name
  candidate may link; any ambiguity becomes a `candidate` set with a
  `matchedVia`, a `reason`, and the options the caller must choose between.
  The chain never silently picks an ambiguous record.
- **Zero matches and failures are ordinary.** A missing record produces no
  link, not an error. An upstream failure costs that step's link; the rest of
  the graph still returns. The tool reports validation problems as
  `isError` results with the search that finds a valid identifier.
- **Weak terminals are always candidates.** After the four steps, DSLD
  ingredient-name groups and an INKEEDecoder ingredient-slug guess may be
  attached. They are always `reason: "name-match"` candidates, never links,
  and a failure in either terminal never costs the confident graph.
- **Product inputs return product links, not a fake ingredient graph.** An
  NDC, SPL set id, or DSLD id resolves to the product's own cross-source
  links plus its ingredient rows, with role, quantity, and form where the
  source exposes them. `include_label_ingredients` opts into parsing SPL XML
  for ingredient UNIIs. `resolve_ingredients` opts into a full graph per
  ingredient row.
- **Per-ingredient graphs cover a disclosed prefix.** A product call builds at
  most 20 graphs (an ordered prefix of `ingredients`). The result carries
  `graphCoverage` with included/total counts, the cap, and a `capped` flag;
  the full ingredient row list remains authoritative. The cap is a bound, not
  a claim of completeness.
- **Candidate options are capped per call.** `max_candidates` (default 5,
  range 1–10) bounds each candidate set. The cap is applied after collection,
  so truncation never turns an ambiguous set into a silent link.

## Consequences

- Results are explainable: every link says what matched it and whether it was
  direct or derived; every candidate says why it stayed ambiguous.
- The chain is source-order biased. A source earlier in the order can anchor
  identity before a later source contributes; that is deliberate and
  documented, not a neutral merge.
- There is no NDC → DrugCentral structure path, because the upstream id spaces
  are disjoint. The tool does not offer one.
- Weak terminals improve recall for supplements and cosmetics at the cost of
  more candidate sets. They never raise confidence.
- Per-ingredient resolution on a multi-ingredient product is expensive. It is
  opt-in and capped, and the result states partial coverage rather than
  implying every ingredient was resolved.
- The chain makes no fixpoint claim. A second pass is triggered only by a
  changed input signature, so edge cases that would require repeated
  re-derivation remain unresolved and appear as candidates or omissions.
- The graph is returned, not stored. Callers that need a stable snapshot must
  keep the result themselves; `retrievedAt` records when it was fetched.
