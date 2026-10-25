# ADR-0004: Include INKEEDecoder despite the separate cosmetic server

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

A separate MCP server for INKEEDecoder already exists. The obvious objection
is duplication: why serve the same cosmetic source from two MCP servers?

The identity loop answers it. Cosmetic ingredients participate in the same
identity graph as drugs and supplements: an INCI name or CAS number from a
cosmetic product can resolve to a CosIng record, an openFDA substance, and
sometimes an RxNorm or DrugCentral record. If INKEEDecoder lived only in a
separate process, an agent researching a cosmetic ingredient would have to
discover the second server, call it separately, and bridge the results by
hand. That is exactly the per-source interface this project rejects.

The counterweight is legal and operational. INKEEDecoder is a commercial,
editorial site, not a government open-data source. Its terms reserve all
rights, prohibit unauthorized copying and republishing, and limit use to
non-commercial personal purposes. Its `robots.txt` permits the product and
ingredient pages this server reads, but a robots allowance is not a license.

## Decision

- **Include INKEEDecoder as the cosmetic source** in the same six-tool
  surface as the other databases, so one search → resolve → get loop covers
  drugs, supplements, and cosmetics.
- **Keep it an adapter, not a special case.** It declares cosmetic product and
  ingredient capabilities and uses the same registry, refs, pagination, and
  error handling as every other source. If it is removed, the six tools keep
  their shape; only cosmetic coverage changes.
- **Treat its terms as restrictive.** The adapter:
  - reads only public product and ingredient pages that `robots.txt` permits;
  - paces requests at one per second through one shared client instance;
  - never bulk-downloads, crawls categories, or walks pagination on its own;
  - returns facts, identifiers, labeled verbatim fields the caller requests,
    and a deep link; it does not substitute for visiting the site;
  - credits INKEEDecoder and links the record even though the terms do not
    require attribution.
- **Keep weak matches weak.** INKEEDecoder name and slug matches are always
  candidates in the identity graph, never confident links.
- **Make removal cheap.** `DRUGDATA_DISABLED_SOURCES=inkeedecoder` switches
  the adapter off for a process. The documentation records the terms and the
  sensitivity so a future maintainer can revisit inclusion without
  re-discovering the constraints.

## Consequences

- One server covers the whole cosmetic identity loop. An agent does not need
  to bridge a second MCP server by hand, and INCI/CAS identifiers flow into
  the same graph as drug identifiers.
- The project depends on a non-open source with terms that could change or be
  enforced differently. That risk is isolated to one adapter and documented
  in `docs/SOURCES.md`; it is not spread through the tool layer.
- Coverage of cosmetic products is only as good as the site's editorial
  database. Its ratings and write-ups are opinions, not regulatory findings,
  and the server labels them as INKEEDecoder content.
- Politeness costs latency: a cosmetic search or lookup can take at least a
  second per request. That is accepted in exchange for not abusing the site.
- If INKEEDecoder becomes unavailable or its terms become incompatible with
  this use, disabling the adapter leaves a coherent five-source server. A
  replacement cosmetic source must satisfy the same adapter contract and be
  documented before it ships.
