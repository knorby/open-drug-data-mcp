import {
  type CosingClient,
  type CosingIngredient,
  type CosingMatch,
  type CosingPage,
  cosingDetailUrl,
  type IngredientSearchCriteria,
} from "@knorby/eu-cosing-client";
import { getClients } from "../clients.js";
import type {
  IngredientIdentifiers,
  IngredientProfile,
  IngredientRef,
  IngredientRegulatory,
  RegulatoryNotice,
} from "../lib/schemas.js";
import type {
  IngredientGroup,
  IngredientLookupRecord,
  IngredientSearchType,
  SourceAdapter,
} from "./types.js";

/**
 * The CosIng source adapter.
 *
 * CosIng is the European Commission's cosmetic-ingredient inventory. It
 * contributes ingredients only (INCI names, CAS/EC numbers, functions, and
 * annex references); it has no product records.
 *
 * **Search strategy** (all observed against the live public search on
 * 2026-10-22):
 *
 * - `inci` queries the exact `inciName` field first. When that finds nothing,
 *   it falls back to the web app's fuzzy `text` search so partial or
 *   differently-spelled names still resolve.
 * - `name` uses the fuzzy `text` search directly. The source's relevance
 *   ranking is what makes it useful for discovery; exact names belong to the
 *   `inci` type.
 * - `cas` and `ec` use the source's wildcard query scoped to `casNo`/`ecNo`.
 *   The match is a substring of the source's `" / "`-joined identifier
 *   strings, so every such hit is labeled `cas-substring`/`ec-substring`
 *   rather than presented as an exact registry match.
 *
 * A zero-match search is an ordinary empty group: CosIng answers HTTP 200
 * with an empty result list. Failures are reworded to name only CosIng, never
 * a client library or a URL (which carries the public search key).
 *
 * The `status` field is the inventory's current/historical flag ("Active"),
 * not biological activity. Source functions, that status, annex numbers, and
 * restriction text go into `summary` as source facts; the adapter does not
 * interpret them.
 */

/** Records per page, matching the CosIng web app default. */
const PAGE_SIZE = 20;

/** A non-blank string, trimmed, or `undefined` when absent or blank. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Deduplicates a source identifier list without altering its values. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** An ordinary empty result: a zero match is not an error. */
function emptyIngredientGroup(page: number): IngredientGroup {
  return { source: "CosIng", items: [], page, hasMore: false };
}

/** How the source matched this record, in model-facing words. */
function matchBasisOf(match: CosingMatch<CosingIngredient>): string {
  switch (match.matchedOn) {
    case "casNo":
      return "cas-substring";
    case "ecNo":
      return "ec-substring";
    case "inciName":
      return "INCI name match";
    default:
      return "fuzzy name match";
  }
}

/**
 * A short, source-faithful summary: assigned functions, inventory status,
 * annex numbers, and restriction references. Labels are ours; every value is
 * CosIng's, and restriction text is preserved verbatim, including any line
 * breaks.
 */
function summaryOf(item: CosingIngredient): string | undefined {
  const parts: string[] = [];
  if (item.functions.length > 0) {
    parts.push(`Functions: ${item.functions.join(", ")}`);
  }
  const status = nonEmpty(item.status);
  if (status !== undefined) parts.push(`Status: ${status}`);
  if (item.annexNumbers.length > 0) {
    parts.push(`Annex: ${item.annexNumbers.join(", ")}`);
  }
  if (
    item.cosmeticRestriction !== undefined &&
    item.cosmeticRestriction.trim().length > 0
  ) {
    parts.push(`Restriction (verbatim): ${item.cosmeticRestriction}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Maps one CosIng ingredient to the unified ref vocabulary.
 *
 * The glossary name is the display name (it is what the inventory calls the
 * ingredient), falling back to the INCI name and then the substance id. A
 * record without a substance id has no stable identity or deep link, so it is
 * dropped rather than emitted with an empty source id.
 */
function refOf(
  item: CosingIngredient,
  matchBasis?: string,
): IngredientRef | null {
  const id = nonEmpty(item.substanceId);
  if (id === undefined) return null;

  const name = nonEmpty(item.glossaryName) ?? nonEmpty(item.inciName) ?? id;
  const inciName = nonEmpty(item.inciName);
  const cas = unique(item.casNumbers);
  const ec = unique(item.ecNumbers);
  const summary = summaryOf(item);

  const identifiers: IngredientIdentifiers = {
    ...(cas.length > 0 ? { cas } : {}),
    ...(ec.length > 0 ? { ec } : {}),
  };

  return {
    name,
    ...(inciName !== undefined ? { inciName } : {}),
    identifiers,
    source: {
      database: "CosIng",
      id,
      url: cosingDetailUrl(id),
      retrievedAt: item.source.retrievedAt,
    },
    ...(matchBasis !== undefined ? { matchBasis } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

/** Maps one CosIng search match to the unified ref vocabulary. */
function mapIngredient(
  match: CosingMatch<CosingIngredient>,
): IngredientRef | null {
  return refOf(match.item, matchBasisOf(match));
}

/** The profile fields a CosIng inventory record exposes. */
function profileOf(item: CosingIngredient): IngredientProfile {
  const strings = (values: readonly string[]): string[] =>
    unique(values).filter((value) => value.trim().length > 0);
  return {
    ...(nonEmpty(item.glossaryName) !== undefined
      ? { glossaryName: nonEmpty(item.glossaryName) }
      : {}),
    ...(nonEmpty(item.inciName) !== undefined
      ? { inciName: nonEmpty(item.inciName) }
      : {}),
    ...(nonEmpty(item.innName) !== undefined
      ? { innName: nonEmpty(item.innName) }
      : {}),
    ...(nonEmpty(item.inciUsaName) !== undefined
      ? { inciUsaName: nonEmpty(item.inciUsaName) }
      : {}),
    ...(nonEmpty(item.phEurName) !== undefined
      ? { phEurName: nonEmpty(item.phEurName) }
      : {}),
    ...(nonEmpty(item.chemicalName) !== undefined
      ? { chemicalName: nonEmpty(item.chemicalName) }
      : {}),
    ...(nonEmpty(item.chemicalDescription) !== undefined
      ? { chemicalDescription: nonEmpty(item.chemicalDescription) }
      : {}),
    functions: strings(item.functions),
    ...(nonEmpty(item.status) !== undefined
      ? { status: nonEmpty(item.status) }
      : {}),
    annexNumbers: strings(item.annexNumbers),
    identifiedIngredientIds: strings(item.identifiedIngredientIds),
    ...(nonEmpty(item.cosmeticRestriction) !== undefined
      ? { cosmeticRestriction: nonEmpty(item.cosmeticRestriction) }
      : {}),
    otherRestrictions: strings(item.otherRestrictions),
    sccsOpinions: strings(item.sccsOpinions),
    notes: strings(item.notes),
    ...(item.perfuming === undefined ? {} : { perfuming: item.perfuming }),
    ...(item.officialJournalPublication === undefined
      ? {}
      : { officialJournalPublication: item.officialJournalPublication }),
  };
}

/**
 * Builds the verbatim regulatory notices CosIng carries.
 *
 * Restriction and opinion text is never paraphrased. `basis` says why the
 * notice applies: the annex list the record names, or the field it came from
 * when CosIng assigns no annex.
 */
function regulatoryOf(
  item: CosingIngredient,
): IngredientRegulatory | undefined {
  const notices: RegulatoryNotice[] = [];
  const restriction = nonEmpty(item.cosmeticRestriction);
  if (restriction !== undefined) {
    notices.push({
      text: restriction,
      basis:
        item.annexNumbers.length > 0
          ? `annex ${item.annexNumbers.join(", ")}`
          : "CosIng restriction",
      source: "CosIng",
    });
  }
  for (const text of item.otherRestrictions) {
    if (text.trim().length === 0) continue;
    notices.push({
      text,
      basis: "other restriction (verbatim)",
      source: "CosIng",
    });
  }
  for (const text of item.sccsOpinions) {
    if (text.trim().length === 0) continue;
    notices.push({
      text,
      basis: "SCCS opinion (verbatim)",
      source: "CosIng",
    });
  }
  return notices.length > 0 ? { notices } : undefined;
}

/** A not-found error the tool layer renders as an ordinary 404. */
function cosingNotFound(id: string): Error {
  return Object.assign(
    new Error(
      `CosIng has no inventory record for "${id}". Check the substance id or INCI name, or search CosIng ingredients by name or INCI.`,
    ),
    { status: 404 },
  );
}

/**
 * Fetches one CosIng ingredient by substance id, INCI name, or glossary name.
 *
 * A numeric id is the inventory's stable key. A text value must match exactly,
 * first as an INCI name and then as a glossary name; fuzzy text search belongs
 * to `drugdata_search_ingredients`, not to a lookup that promises one record.
 */
async function fetchCosingIngredient(
  client: CosingClient,
  rawId: string,
  signal: AbortSignal | undefined,
): Promise<IngredientLookupRecord> {
  const id = rawId.trim();
  let match: CosingMatch<CosingIngredient> | null;
  try {
    if (/^\d+$/.test(id)) {
      match = await client.ingredients.get(id, { signal });
    } else {
      const inci = await client.ingredients.search({
        inciName: id.toUpperCase(),
        page: 1,
        pageSize: 1,
        signal,
      });
      match = inci.items[0] ?? null;
      if (match === null) {
        const glossary = await client.ingredients.search({
          glossaryName: id.toUpperCase(),
          page: 1,
          pageSize: 1,
          signal,
        });
        match = glossary.items[0] ?? null;
      }
    }
  } catch (error) {
    throw cosingFailure("The CosIng ingredient lookup", error);
  }
  if (match === null) throw cosingNotFound(id);

  const ingredient = refOf(match.item);
  if (ingredient === null) throw cosingNotFound(id);
  const regulatory = regulatoryOf(match.item);
  return {
    ingredient,
    profile: profileOf(match.item),
    ...(regulatory !== undefined ? { regulatory } : {}),
  };
}

/** Maps one upstream page to a grouped ingredient result. */
function groupOf(page: CosingPage<CosingIngredient>): IngredientGroup {
  const items: IngredientRef[] = [];
  for (const match of page.items) {
    const item = mapIngredient(match);
    if (item !== null) items.push(item);
  }
  return {
    source: "CosIng",
    items,
    page: page.page,
    hasMore: page.hasMore,
  };
}

/**
 * Turns a failed request into model-facing text.
 *
 * The message carries only CosIng's status and advice: client names, raw URLs
 * (which include the search key), upstream bodies, and the underlying error
 * text are deliberately dropped.
 */
function cosingFailure(context: string, error: unknown): Error {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status === 429) {
    return new Error(
      `${context} was rate limited by CosIng (HTTP 429). Wait a few seconds, then retry.`,
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new Error(
      `${context} failed: CosIng returned HTTP ${status} and may be temporarily unavailable. Retry shortly.`,
    );
  }
  if (typeof status === "number") {
    return new Error(
      `${context} failed: CosIng rejected the request (HTTP ${status}). Check the search value and try again.`,
    );
  }
  return new Error(
    `${context} failed: CosIng did not return a usable response. Retry shortly.`,
  );
}

/**
 * Builds the CosIng adapter.
 *
 * @param client Optional client override. Tests inject one backed by fixtures;
 *   production falls back to the process-wide shared CosIng client, which
 *   already carries the public search key.
 */
export function createCosingAdapter(client?: CosingClient): SourceAdapter {
  const clients = () => client ?? getClients().cosing;

  const ingredientSearchTypes: IngredientSearchType[] = [
    "name",
    "inci",
    "cas",
    "ec",
  ];

  return {
    id: "cosing",
    databases: ["CosIng"],
    productSearchTypes: [],
    ingredientSearchTypes,
    productCategories: [],

    async searchIngredients(
      type: IngredientSearchType,
      query: string,
      page: number,
      signal?: AbortSignal,
    ): Promise<IngredientGroup[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [emptyIngredientGroup(page)];

      // Resolve the client before the failure boundary: configuration errors
      // are actionable as-is and must not be reworded as a CosIng outage.
      const cosing = clients();
      const search = (criteria: IngredientSearchCriteria) =>
        cosing.ingredients.search({
          ...criteria,
          page,
          pageSize: PAGE_SIZE,
          signal,
        });

      try {
        switch (type) {
          case "inci": {
            const exact = await search({ inciName: trimmed.toUpperCase() });
            if (exact.total > 0) return [groupOf(exact)];
            return [groupOf(await search({ text: trimmed }))];
          }
          case "cas":
            return [groupOf(await search({ casNo: trimmed }))];
          case "ec":
            return [groupOf(await search({ ecNo: trimmed }))];
          case "name":
            return [groupOf(await search({ text: trimmed }))];
          default:
            return [emptyIngredientGroup(page)];
        }
      } catch (error) {
        throw cosingFailure("The CosIng ingredient search", error);
      }
    },

    async getIngredient(
      id: string,
      _opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<IngredientLookupRecord> {
      return await fetchCosingIngredient(clients(), id, signal);
    },
  };
}

/** The process-wide adapter, backed by the shared CosIng client. */
export const cosingAdapter: SourceAdapter = createCosingAdapter();
