# ADR-0002: Unified tools and upstream-only sourcing

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Six sources overlap on identity but differ in coverage and shape: openFDA has
US drug products and substance records; CosIng has EU cosmetic ingredients;
NLM supplies RxNorm concepts and DailyMed labels; DrugCentral has ingredient
structures and clinical assertions; DSLD has supplement labels; INKEEDecoder
has cosmetic products and ingredient pages. An agent researching one product
or ingredient should not have to know which database to ask first, or how each
one spells an identifier.

Two failure modes were explicit non-goals:

- Per-source tools (`openfda_search`, `cosing_search`, …) that push database
  selection onto the caller.
- Output that names or implies the client libraries as the source.

The result also has to be bounded and machine-readable while remaining useful
as text, because hosts differ in how much `structuredContent` they surface.

## Decision

- **Six type-discriminated tools, never source-discriminated.** `ping`,
  `search_products`, `search_ingredients`, `get_product`, `get_ingredient`,
  and `resolve_identifiers`. A search takes the kind of value the caller has
  (`name`, `brand`, `ingredient`, `barcode`, `ndc`; `name`, `inci`, `unii`,
  `cas`, `ec`, `rxcui`) and the registry fans it out to every enabled adapter
  that declares that capability.
- **One adapter per source module, one registry.** An adapter declares its
  databases, product search types, ingredient search types, and categories,
  then implements only the search and lookup methods it can answer. The
  registry fans searches out concurrently with `allSettled`, isolates a
  failed adapter into error groups for its databases, and routes lookups to
  the adapter that owns the named database. Adding a source is a new adapter
  module plus registration; adding a search type is an enum value plus an
  adapter capability, not a new tool.
- **Grouped, sourced result refs.** Every `ProductRef` and `IngredientRef`
  carries unified identifiers and a `SourceRef` with the upstream `database`,
  its own `id`, a deep-link `url`, and `retrievedAt`. `database` is the
  upstream database (openFDA, CosIng, RxNorm, DailyMed, DrugCentral, DSLD,
  INKEEDecoder), never a client library. Regulatory text is kept verbatim,
  labeled, and attributed.
- **Sourcing is a hard rule, not a presentation preference.** Client package
  names, package scopes, and client-shaped source labels must not appear in
  result text, `structuredContent`, or agent-facing errors. Adapters reword
  upstream failures to name only the database; the tool boundary applies a
  final scrub; a test sweeps every tool's serialized output for leaks.
- **The loop is part of the interface.** Search and resolve results end with
  `nextSteps`: concrete follow-up calls with a `why`. Pagination is explicit
  (`page` plus per-group `hasMore`); responses are character-bounded; a zero
  match is an ordinary empty result, never an error.
- **Bounded, dual output.** Each tool declares a closed output schema and
  returns validated `structuredContent` plus a curated markdown or JSON text
  block. The text block is truncated at `CHARACTER_LIMIT` with a visible note
  when shortened.
- **No caching, no mirroring, no bulk download.** Queries run at request time.
  This keeps `retrievedAt` meaningful and respects upstream rate limits.

## Consequences

- The caller cannot ask a specific database for a search; it can only search
  by a type and read the groups that answer. Source-specific detail remains
  available through `get_*` by naming the database that owns the record.
- Adapters are asymmetric, so result completeness varies by search type. A
  source that cannot answer is absent, not an error.
- A wide fan-out costs several upstream requests per page. Each adapter pages
  its own source and the registry does not walk pages, so cost stays bounded.
- Error groups and empty groups are distinct. Hosts and agents must read a
  group's `error` field rather than treating an empty `items` array as
  failure.
- Hiding client names requires discipline at three layers: adapter mapping,
  error rewording, and the final scrub. The leak test is the enforcement.
- The closed schemas intentionally strip unknown upstream fields. New source
  fields need a schema addition and a test, not a passthrough.
