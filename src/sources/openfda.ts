import {
  and,
  type DrugLabel,
  type DrugNdc,
  exact,
  field,
  not,
  type OpenFdaClient,
  OpenFdaNotFoundError,
  or,
  range,
  type Substance,
  type UniiRecord,
} from "@knorby/openfda-client";
import { getClients } from "../clients.js";
import { isSplSetId, isUnii } from "../lib/ids.js";
import type {
  IngredientIdentifiers,
  IngredientProfile,
  IngredientRef,
  IngredientRole,
  ProductIdentifiers,
  ProductRef,
  SourceRef,
} from "../lib/schemas.js";
import { parseBarcodeInput } from "./identity/barcode.js";
import {
  dailyMedLabelUrl,
  parseSplIngredients,
  type SplIngredient,
} from "./identity/spl-ingredients.js";
import { type NlmBridges, nlmBridges } from "./nlm.js";
import type {
  IngredientGroup,
  IngredientLookupRecord,
  IngredientSearchType,
  ProductGroup,
  ProductSearchType,
  SourceAdapter,
} from "./types.js";

/**
 * The openFDA source adapter.
 *
 * Two upstream endpoints feed the unified vocabulary:
 *
 * - `drug/ndc` for marketed drug products (the FDA drug directory), and
 * - `other/substance` + `other/unii` for ingredient substances.
 *
 * The directory record is a marketing listing, not an approval, and the
 * map below keeps that distinction out of the result text: it carries only
 * identifiers, the labeler, and a short form/route/strength summary.
 *
 * **Quirks handled here** (all observed against the live API on 2026-10-22):
 *
 * - A zero-match search answers HTTP 404 with `NOT_FOUND`, which the client
 *   raises as `OpenFdaNotFoundError`; that is an empty result, never a
 *   failure.
 * - `drug/ndc` has no usable `openfda.brand_name` field, and `.exact`
 *   subfields 404 on its top-level name fields. Brand search therefore uses
 *   the analyzed `brand_name`/`brand_name_base` fields.
 * - The directory returns one record per product, with package variants in
 *   `packaging[]`. Prescription products that differ only by package size
 *   still arrive as separate records, so the adapter collapses them by
 *   name, form, and strengths (the ritualog `dedupeKey` port).
 * - `other/substance` name search is unreliable; the `other/unii` crosswalk
 *   is the dependable name entry point, and each UNII is then fetched for
 *   its full record.
 */

/** Records per page, matching the ritualog directory adapter. */
const PAGE_SIZE = 20;

/** Crosswalk hits to resolve per name search. */
const CROSSWALK_LIMIT = 5;

/** A product NDC as the directory spells it: 4-4 or 5-3/5-4 segments. */
const PRODUCT_NDC = /^\d{4,5}-\d{3,4}$/;

/** A package NDC, capturing the product portion when it is numeric. */
const PACKAGE_NDC = /^(\d{4,5}-\d{3,4})-\d{1,2}$/;

/** Active-ingredient strength shape (`"10 mg/1"`, `"0.5 mg/1"`). */
const STRENGTH = /^([\d.]+)\s*([A-Za-zμ]+)(?:\s*\/.*)?$/;

/** A CAS Registry Number, in the conventional dashed spelling. */
const CAS = /^\d{2,7}-\d{2}-\d$/;

/** How closely a substance name agrees with the searched text. */
export type SubstanceMatchTier = "inci" | "exact" | "prefix" | "none";

/** Ranking weight per tier; unmatched candidates still sort last, not out. */
const TIER_SCORE: Record<SubstanceMatchTier, number> = {
  inci: 3,
  exact: 2,
  prefix: 1,
  none: 0,
};

/** Model-facing explanation of how a crosswalk hit was matched. */
const MATCH_BASIS: Record<SubstanceMatchTier, string> = {
  inci: "INCI name match",
  exact: "exact name match",
  prefix: "name prefix match",
  none: "name differs from query",
};

/** A non-blank string, or `undefined` when absent or whitespace-only. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** Deduplicates values without altering their spelling or order. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Whether a page came back full (the caller may request another page). */
function hasMore(count: number, pageSize: number): boolean {
  return count === pageSize;
}

/** An ordinary empty result: a zero match is not an error. */
function emptyProductGroup(page: number): ProductGroup {
  return { source: "openFDA", items: [], page, hasMore: false };
}

/** Ingredient counterpart of {@link emptyProductGroup}. */
function emptyIngredientGroup(page: number): IngredientGroup {
  return { source: "openFDA", items: [], page, hasMore: false };
}

/** Today as an openFDA `YYYYMMDD` stamp. */
function todayStamp(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${now.getUTCFullYear()}${month}${day}`;
}

/**
 * Text clause for a name search. The directory indexes these three fields;
 * `openfda.brand_name` is not present on this endpoint.
 */
function nameClause(query: string): string {
  return or(
    field("brand_name", query),
    field("generic_name", query),
    field("brand_name_base", query),
  );
}

/**
 * Brand clause. `exact("openfda.brand_name", …)` returns a 404 on this
 * endpoint, so the analyzed brand fields are the working equivalent.
 */
function brandClause(query: string): string {
  return or(field("brand_name", query), field("brand_name_base", query));
}

/**
 * Restricts a text search to current listings. The directory lists marketed
 * products; expired listings are off-market. openFDA ranges do not match
 * records missing the field, so `NOT` a range keeps still-listed products
 * (no expiration date) visible.
 */
function currentListingClause(clause: string): string {
  return and(
    clause,
    field("finished", "true"),
    not(range("listing_expiration_date", { lte: todayStamp() })),
  );
}

/**
 * Product identifiers for a typed NDC or barcode.
 *
 * A 10/11-digit NDC has several labeler layouts; `parseBarcodeInput` expands
 * them into dashed candidates. Each candidate's product NDC is derived by
 * dropping its package segment, so the query can probe both spellings. A
 * two-segment product NDC is already the product-level spelling and needs no
 * expansion.
 */
export function ndcQueryCandidates(raw: string): {
  packageNdc: string[];
  productNdc: string[];
} {
  const trimmed = raw.trim();
  if (PRODUCT_NDC.test(trimmed)) {
    return { packageNdc: [], productNdc: [trimmed] };
  }

  const parsed = parseBarcodeInput(trimmed);
  if (parsed.kind !== "ndc") {
    return { packageNdc: [], productNdc: [] };
  }

  const productNdc: string[] = [];
  for (const candidate of parsed.ndcCandidates) {
    const product = productNdcFromPackage(candidate);
    if (product !== undefined && !productNdc.includes(product)) {
      productNdc.push(product);
    }
  }
  return { packageNdc: parsed.ndcCandidates, productNdc };
}

/** Drops a package NDC's package segment, when the shape is numeric. */
function productNdcFromPackage(packageNdc: string): string | undefined {
  return PACKAGE_NDC.exec(packageNdc)?.[1];
}

/** Label normalization for the prescription dedupe key. */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Each active ingredient's strength, normalized (`"10 mg/1"` → `"10 mg"`).
 * A strength that does not parse is kept trimmed, so two records with the
 * same free-text strength still collapse.
 */
function strengthEntries(raw: DrugNdc): string[] {
  const entries: string[] = [];
  for (const ingredient of raw.active_ingredients ?? []) {
    const strength = ingredient.strength;
    if (strength === undefined || strength.trim().length === 0) continue;
    const match = STRENGTH.exec(strength);
    entries.push(
      match === null
        ? strength.trim()
        : `${Number.parseFloat(match[1] as string)} ${(match[2] as string).toLowerCase()}`,
    );
  }
  return entries;
}

/** Strength display text, combinations joined with `" · "`. */
function strengthText(raw: DrugNdc): string | undefined {
  const parts = strengthEntries(raw);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Identity key for pharmacy package variants of the same prescription
 * (name + form + strengths). Non-prescription listings are never collapsed:
 * their package sizes are the product. `name` is the product's display name,
 * which the caller has already established is present.
 */
function rxDedupeKey(raw: DrugNdc, name: string): string | undefined {
  if (raw.product_type !== "HUMAN PRESCRIPTION DRUG") return undefined;
  const form = raw.dosage_form ?? "";
  const strengths = strengthEntries(raw).slice().sort().join(";");
  return `${normalizeKey(name)}|${normalizeKey(form)}|${strengths}`;
}

/** Short model-facing subtitle: form, route, and strength. */
function productSummary(raw: DrugNdc): string | undefined {
  const parts: string[] = [];
  const form = nonEmpty(raw.dosage_form);
  if (form !== undefined) parts.push(form);
  const route = (raw.route ?? [])
    .filter((value) => value.length > 0)
    .join(", ");
  if (route.length > 0) parts.push(route);
  const strength = strengthText(raw);
  if (strength !== undefined) parts.push(strength);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Deep link to the directory record. */
function productUrl(productNdc: string): string {
  return `https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(
    `product_ndc:"${productNdc}"`,
  )}&limit=1`;
}

/** Deep link to the substance record. */
function ingredientUrl(unii: string): string {
  return `https://api.fda.gov/other/substance.json?search=${encodeURIComponent(
    `unii:"${unii}"`,
  )}&limit=1`;
}

/**
 * Maps one directory record to a product ref.
 *
 * `identifiers.ndc` carries the package spellings the labeler published; a
 * missing package list falls back to the product NDC. The product NDC is
 * also derived from a package when the record omits the product-level field.
 */
function mapProduct(raw: DrugNdc, retrievedAt: string): ProductRef | null {
  const packageNdcs = (raw.packaging ?? [])
    .map((entry) => nonEmpty(entry.package_ndc))
    .filter((value): value is string => value !== undefined);
  const productNdc =
    nonEmpty(raw.product_ndc) ??
    (packageNdcs[0] === undefined
      ? undefined
      : productNdcFromPackage(packageNdcs[0]));
  const name = nonEmpty(raw.brand_name) ?? nonEmpty(raw.generic_name);
  if (productNdc === undefined || name === undefined) return null;

  const openfda = raw.openfda;
  const splSetId = openfda?.spl_set_id?.[0];
  const rxcuis = openfda?.rxcui;
  const upcs = openfda?.upc;
  const labeler = nonEmpty(raw.labeler_name);
  const applicationNumber = nonEmpty(raw.application_number);
  const summary = productSummary(raw);

  const identifiers: ProductIdentifiers = {
    ndc: packageNdcs.length > 0 ? packageNdcs : [productNdc],
    ...(splSetId !== undefined ? { splSetId } : {}),
    ...(rxcuis !== undefined && rxcuis.length > 0 ? { rxcui: rxcuis } : {}),
    ...(applicationNumber !== undefined ? { applicationNumber } : {}),
    ...(upcs !== undefined && upcs.length > 0 ? { upc: upcs } : {}),
  };

  return {
    name,
    ...(labeler !== undefined ? { brand: labeler } : {}),
    category: "medication",
    identifiers,
    source: {
      database: "openFDA",
      id: productNdc,
      url: productUrl(productNdc),
      retrievedAt,
    },
    ...(summary !== undefined ? { summary } : {}),
  };
}

/** Maps a page of directory records, collapsing prescription variants. */
function mapProductResults(
  records: DrugNdc[],
  retrievedAt: string,
): ProductRef[] {
  const items: ProductRef[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const ref = mapProduct(record, retrievedAt);
    if (ref === null) continue;
    const key = rxDedupeKey(record, ref.name);
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    items.push(ref);
  }
  return items;
}

/** Classifies how a substance name agrees with the searched text. */
export function matchSubstanceTier(
  substance: Substance,
  query: string,
): SubstanceMatchTier {
  const target = query.trim().toUpperCase();
  if (target.length === 0) return "none";

  let exact = false;
  for (const entry of substance.names ?? []) {
    const name = nonEmpty(entry.name)?.toUpperCase();
    if (name === undefined) continue;
    if (name === target) {
      if ((entry.name_orgs ?? []).some((org) => org.name_org === "INCI")) {
        return "inci";
      }
      exact = true;
    }
  }
  if (exact) return "exact";

  for (const entry of substance.names ?? []) {
    const name = nonEmpty(entry.name)?.toUpperCase();
    if (name?.startsWith(target)) return "prefix";
  }
  return "none";
}

/**
 * Ranks substances by match tier without filtering: an unmatched candidate
 * is still returned for the caller to judge.
 */
export function rankSubstances(
  substances: Substance[],
  query: string,
): Substance[] {
  return [...substances].sort(
    (a, b) =>
      TIER_SCORE[matchSubstanceTier(b, query)] -
      TIER_SCORE[matchSubstanceTier(a, query)],
  );
}

/** Maps one substance record to an ingredient ref. */
function mapIngredient(
  raw: Substance,
  retrievedAt: string,
  matchBasis?: string,
): IngredientRef | null {
  const unii = nonEmpty(raw.unii);
  if (unii === undefined) return null;

  const names = raw.names ?? [];
  const named = names.filter((entry) => nonEmpty(entry.name) !== undefined);
  const primary =
    named.find(
      (entry) => entry.preferred === true || entry.display_name === true,
    ) ?? named[0];
  const name = nonEmpty(primary?.name) ?? unii;
  const inciName = nonEmpty(
    named.find((entry) =>
      (entry.name_orgs ?? []).some((org) => org.name_org === "INCI"),
    )?.name,
  );
  const cas = [
    ...new Set(
      (raw.codes ?? [])
        .filter((code) => code.code_system === "CAS")
        .map((code) => nonEmpty(code.code))
        .filter((code): code is string => code !== undefined),
    ),
  ];

  const identifiers: IngredientIdentifiers = {
    unii,
    ...(cas.length > 0 ? { cas } : {}),
  };

  return {
    name,
    ...(inciName !== undefined ? { inciName } : {}),
    identifiers,
    source: {
      database: "openFDA",
      id: unii,
      url: ingredientUrl(unii),
      retrievedAt,
    },
    ...(matchBasis !== undefined ? { matchBasis } : {}),
  };
}

/**
 * The profile fields an openFDA substance lookup exposes: every recorded name,
 * code, and relationship. The values are openFDA's; labels belong to the tool.
 */
function substanceProfile(raw: Substance): IngredientProfile {
  const names = (raw.names ?? []).flatMap((entry) => {
    const name = nonEmpty(entry.name);
    if (name === undefined) return [];
    return [
      {
        name,
        ...(nonEmpty(entry.type) !== undefined
          ? { type: nonEmpty(entry.type) }
          : {}),
        ...(typeof entry.preferred === "boolean"
          ? { preferred: entry.preferred }
          : {}),
        ...(typeof entry.display_name === "boolean"
          ? { displayName: entry.display_name }
          : {}),
        organizations: (entry.name_orgs ?? [])
          .map((org) => nonEmpty(org.name_org))
          .filter((org): org is string => org !== undefined),
      },
    ];
  });

  const codes = (raw.codes ?? []).flatMap((entry) => {
    const code = nonEmpty(entry.code);
    const system = nonEmpty(entry.code_system);
    if (code === undefined || system === undefined) return [];
    return [
      {
        code,
        system,
        ...(nonEmpty(entry.type) !== undefined
          ? { type: nonEmpty(entry.type) }
          : {}),
      },
    ];
  });

  const relationships = (raw.relationships ?? []).flatMap((entry) => {
    const related = entry.related_substance;
    const relationship = {
      ...(nonEmpty(entry.type) !== undefined
        ? { type: nonEmpty(entry.type) }
        : {}),
      ...(nonEmpty(entry.qualification) !== undefined
        ? { qualification: nonEmpty(entry.qualification) }
        : {}),
      ...(nonEmpty(related?.name) !== undefined
        ? { relatedName: nonEmpty(related?.name) }
        : {}),
      ...(nonEmpty(related?.unii) !== undefined
        ? { relatedUnii: nonEmpty(related?.unii)?.toUpperCase() }
        : {}),
      ...(nonEmpty(related?.substance_class) !== undefined
        ? { relatedSubstanceClass: nonEmpty(related?.substance_class) }
        : {}),
    };
    return Object.keys(relationship).length > 0 ? [relationship] : [];
  });

  return {
    ...(nonEmpty(raw.substance_class) !== undefined
      ? { substanceClass: nonEmpty(raw.substance_class) }
      : {}),
    ...(nonEmpty(raw.definition_level) !== undefined
      ? { definitionLevel: nonEmpty(raw.definition_level) }
      : {}),
    ...(nonEmpty(raw.definition_type) !== undefined
      ? { definitionType: nonEmpty(raw.definition_type) }
      : {}),
    ...(names.length > 0 ? { names } : {}),
    ...(codes.length > 0 ? { codes } : {}),
    ...(relationships.length > 0 ? { relationships } : {}),
  };
}

/** A short source-faithful summary: substance class and definition level. */
function substanceSummary(raw: Substance): string | undefined {
  const parts: string[] = [];
  const substanceClass = nonEmpty(raw.substance_class);
  if (substanceClass !== undefined) {
    parts.push(`Substance class: ${substanceClass}`);
  }
  const definitionLevel = nonEmpty(raw.definition_level);
  if (definitionLevel !== undefined) {
    parts.push(`Definition level: ${definitionLevel}`);
  }
  const definitionType = nonEmpty(raw.definition_type);
  if (definitionType !== undefined) {
    parts.push(`Definition type: ${definitionType}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A not-found error the tool layer renders as an ordinary 404. */
function openFdaIngredientNotFound(id: string): Error {
  return Object.assign(
    new Error(
      `openFDA has no substance record for "${id}". Check the UNII or CAS number, or search openFDA ingredients by name.`,
    ),
    { status: 404 },
  );
}

/**
 * Fetches one substance record and maps it to the unified ingredient record.
 *
 * The id must be a UNII or a dashed CAS number; the tool validates first, but
 * the adapter keeps the same guard so a direct caller gets actionable text
 * rather than an upstream query built from arbitrary input.
 */
async function fetchSubstance(
  client: OpenFdaClient,
  rawId: string,
  retrievedAt: string,
): Promise<IngredientLookupRecord> {
  const id = rawId.trim();
  const unii = isUnii(id) ? id.toUpperCase() : undefined;
  const cas = unii === undefined && CAS.test(id) ? id : undefined;
  if (unii === undefined && cas === undefined) {
    throw new Error(
      `Expected a UNII or a dashed CAS number for an openFDA substance, but got "${id}". Pass identifiers.unii or a CAS number from an openFDA ingredient result.`,
    );
  }

  const search =
    unii !== undefined
      ? and(field("unii", unii))
      : and(
          field("codes.code", cas as string),
          field("codes.code_system", "CAS"),
        );

  let raw: Substance | undefined;
  try {
    const response = await client.other.substance.search({ search, limit: 1 });
    raw = response.results[0];
  } catch (error) {
    if (error instanceof OpenFdaNotFoundError) {
      throw openFdaIngredientNotFound(id);
    }
    throw openFdaFailure("The openFDA ingredient lookup", error);
  }
  if (raw === undefined) throw openFdaIngredientNotFound(id);

  const base = mapIngredient(raw, retrievedAt);
  if (base === null) throw openFdaIngredientNotFound(id);
  const summary = substanceSummary(raw);

  return {
    ingredient: {
      ...base,
      ...(summary !== undefined ? { summary } : {}),
    },
    profile: substanceProfile(raw),
  };
}

/**
 * Turns a failed request into model-facing text.
 *
 * The message carries only openFDA's status and advice: client names, raw
 * URLs (which may include an API key), and upstream bodies are deliberately
 * dropped.
 */
function openFdaFailure(context: string, error: unknown): Error {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status === 429) {
    return new Error(
      `${context} was rate limited by openFDA (HTTP 429). Wait a few seconds, then retry.`,
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new Error(
      `${context} failed: openFDA returned HTTP ${status} and may be temporarily unavailable. Retry shortly.`,
    );
  }
  if (typeof status === "number") {
    return new Error(
      `${context} failed: openFDA rejected the request (HTTP ${status}). Check the search value and try again.`,
    );
  }
  return new Error(
    `${context} failed: openFDA did not return a usable response. Retry shortly.`,
  );
}

/** Runs one product query and maps its page. */
async function fetchProducts(
  client: OpenFdaClient,
  search: string,
  page: number,
  retrievedAt: string,
): Promise<ProductGroup> {
  try {
    const response = await client.drug.ndc.search({
      search,
      limit: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    });
    return {
      source: "openFDA",
      items: mapProductResults(response.results, retrievedAt),
      page,
      hasMore: hasMore(response.results.length, PAGE_SIZE),
    };
  } catch (error) {
    if (error instanceof OpenFdaNotFoundError) return emptyProductGroup(page);
    throw openFdaFailure("The openFDA product search", error);
  }
}

/** Runs one substance query and maps its page. */
async function fetchIngredients(
  client: OpenFdaClient,
  search: string,
  page: number,
  retrievedAt: string,
): Promise<IngredientGroup> {
  try {
    const response = await client.other.substance.search({
      search,
      limit: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    });
    const items = response.results
      .map((record) => mapIngredient(record, retrievedAt))
      .filter((item): item is IngredientRef => item !== null);
    return {
      source: "openFDA",
      items,
      page,
      hasMore: hasMore(response.results.length, PAGE_SIZE),
    };
  } catch (error) {
    if (error instanceof OpenFdaNotFoundError)
      return emptyIngredientGroup(page);
    throw openFdaFailure("The openFDA ingredient search", error);
  }
}

/** Runs one page of a UNII crosswalk query. */
async function fetchCrosswalkPage(
  client: OpenFdaClient,
  search: string,
  page: number,
): Promise<UniiRecord[]> {
  const response = await client.other.unii.search({
    search,
    limit: CROSSWALK_LIMIT,
    skip: (page - 1) * CROSSWALK_LIMIT,
  });
  return response.results;
}

/**
 * Resolves the crosswalk entries for a name.
 *
 * `substance_name` is analyzed, so a term query ranks partial names ahead of
 * the exact substance (for example GLYCERIN METHYL ETHER before GLYCERIN).
 * Try the exact field first; only when it has no match fall back to the
 * analyzed query so partial-name searches still work. Zero matches at either
 * level are an ordinary empty list.
 */
async function crosswalkEntries(
  client: OpenFdaClient,
  query: string,
  page: number,
): Promise<UniiRecord[]> {
  const name = query.toUpperCase();
  try {
    return await fetchCrosswalkPage(
      client,
      exact("substance_name", name),
      page,
    );
  } catch (error) {
    if (!(error instanceof OpenFdaNotFoundError)) {
      throw openFdaFailure("The openFDA ingredient search", error);
    }
  }

  try {
    return await fetchCrosswalkPage(
      client,
      field("substance_name", name),
      page,
    );
  } catch (error) {
    if (error instanceof OpenFdaNotFoundError) return [];
    throw openFdaFailure("The openFDA ingredient search", error);
  }
}

/**
 * Name/INCI search: the UNII crosswalk, then one substance fetch per hit.
 *
 * The crosswalk page controls pagination; the per-UNII records are
 * enrichments of that page, not additional results. Zero matches at either
 * level are ordinary empties. A 404 for one crosswalk entry simply drops that
 * candidate, matching ritualog's lookup.
 */
async function crosswalkIngredients(
  client: OpenFdaClient,
  query: string,
  page: number,
  retrievedAt: string,
): Promise<IngredientGroup> {
  const entries = await crosswalkEntries(client, query, page);

  const records: Substance[] = [];
  for (const entry of entries) {
    const unii = nonEmpty(entry.unii);
    if (unii === undefined) continue;
    try {
      const response = await client.other.substance.search({
        search: field("unii", unii),
        limit: 1,
      });
      const record = response.results[0];
      if (record !== undefined) records.push(record);
    } catch (error) {
      if (!(error instanceof OpenFdaNotFoundError)) {
        throw openFdaFailure("The openFDA ingredient search", error);
      }
    }
  }

  const items = rankSubstances(records, query)
    .map((record) =>
      mapIngredient(
        record,
        retrievedAt,
        MATCH_BASIS[matchSubstanceTier(record, query)],
      ),
    )
    .filter((item): item is IngredientRef => item !== null);

  return {
    source: "openFDA",
    items,
    page,
    hasMore: hasMore(entries.length, CROSSWALK_LIMIT),
  };
}

/** The detail fields an openFDA product lookup exposes. */
export interface OpenFdaProductDetails {
  source: "ndc" | "label";
  labeler?: string;
  marketingCategory?: string;
  applicationNumber?: string;
  productType?: string;
  splSetId?: string;
  effectiveTime?: string;
  version?: string;
}

/** A full openFDA product record in the unified vocabulary. */
export interface OpenFdaProductRecord {
  product: ProductRef;
  ingredients: IngredientRef[];
  details: OpenFdaProductDetails;
  summary?: string;
  labelIngredientsIncluded: boolean;
}

/** A not-found error the tool layer renders as an ordinary 404. */
function openFdaNotFound(id: string): Error {
  return Object.assign(
    new Error(`No openFDA product record was found for "${id}".`),
    { status: 404 },
  );
}

/** Deep link to an FDA label record by set id. */
function openFdaLabelUrl(setid: string): string {
  return `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(
    `set_id:"${setid}"`,
  )}&limit=1`;
}

/**
 * Runs one openFDA product query and returns its first record.
 *
 * A zero-match 404 is a normal "no record", not a failure; anything else is
 * reworded to name only openFDA.
 */
async function firstNdcRecord(
  client: OpenFdaClient,
  search: string,
): Promise<DrugNdc | undefined> {
  try {
    const response = await client.drug.ndc.search({ search, limit: 5 });
    return response.results[0];
  } catch (error) {
    if (error instanceof OpenFdaNotFoundError) return undefined;
    throw openFdaFailure("The openFDA product lookup", error);
  }
}

/** Runs one FDA label query and returns its first record. */
async function firstLabelRecord(
  client: OpenFdaClient,
  search: string,
): Promise<DrugLabel | undefined> {
  try {
    const response = await client.drug.label.search({ search, limit: 1 });
    return response.results[0];
  } catch (error) {
    if (error instanceof OpenFdaNotFoundError) return undefined;
    throw openFdaFailure("The openFDA label lookup", error);
  }
}

/** A label's product ref, keyed by its SPL set id. */
function labelProductRef(
  label: DrugLabel,
  requestedSetid: string,
  retrievedAt: string,
): ProductRef {
  const openfda = label.openfda;
  const setid = nonEmpty(label.set_id) ?? requestedSetid;
  const name =
    nonEmpty(openfda?.brand_name?.[0]) ??
    nonEmpty(openfda?.generic_name?.[0]) ??
    `openFDA label ${setid}`;
  const brand = nonEmpty(openfda?.manufacturer_name?.[0]);
  const ndc = unique(
    [...(openfda?.product_ndc ?? []), ...(openfda?.package_ndc ?? [])]
      .map((value) => nonEmpty(value))
      .filter((value): value is string => value !== undefined),
  );
  const rxcui = openfda?.rxcui ?? [];
  const upc = openfda?.upc ?? [];
  const effectiveTime = nonEmpty(label.effective_time);
  const version = nonEmpty(label.version);
  const parts: string[] = [];
  if (effectiveTime !== undefined) {
    parts.push(`FDA label effective ${effectiveTime}`);
  }
  if (version !== undefined) parts.push(`version ${version}`);

  return {
    name,
    ...(brand !== undefined ? { brand } : {}),
    category: "medication",
    identifiers: {
      ...(ndc.length > 0 ? { ndc } : {}),
      ...(rxcui.length > 0 ? { rxcui } : {}),
      ...(upc.length > 0 ? { upc } : {}),
      splSetId: setid,
    },
    source: {
      database: "openFDA",
      id: setid,
      url: openFdaLabelUrl(setid),
      retrievedAt,
    },
    ...(parts.length > 0 ? { summary: parts.join(" · ") } : {}),
  };
}

/** Maps directory active ingredients to label-style ingredient refs. */
function directoryIngredients(
  raw: DrugNdc,
  source: SourceRef,
): IngredientRef[] {
  const items: IngredientRef[] = [];
  for (const ingredient of raw.active_ingredients ?? []) {
    const name = nonEmpty(ingredient.name);
    if (name === undefined) continue;
    const strength = nonEmpty(ingredient.strength);
    items.push({
      name,
      role: "active",
      ...(strength !== undefined ? { quantity: strength } : {}),
      identifiers: {},
      source,
    });
  }
  return items;
}

/** Normalized ingredient key for strength matching across SPL and the NDC directory. */
export function ingredientKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strength text from the NDC directory, keyed by normalized ingredient name. */
function directoryStrengths(raw: DrugNdc): Map<string, string> {
  const strengths = new Map<string, string>();
  for (const ingredient of raw.active_ingredients ?? []) {
    const name = nonEmpty(ingredient.name);
    const strength = nonEmpty(ingredient.strength);
    if (name !== undefined && strength !== undefined) {
      strengths.set(ingredientKey(name), strength);
    }
  }
  return strengths;
}

/**
 * Maps parsed SPL ingredients to ingredient refs, crediting DailyMed.
 *
 * Exported for the identity chain, which parses a product's SPL rows itself
 * when it resolves label ingredients at product level.
 */
export function splIngredientRefs(
  entries: readonly SplIngredient[],
  setid: string,
  retrievedAt: string,
  strengths: ReadonlyMap<string, string>,
): IngredientRef[] {
  const source: SourceRef = {
    database: "DailyMed",
    id: setid,
    url: dailyMedLabelUrl(setid),
    retrievedAt,
  };
  return entries.map((entry) => {
    const directoryStrength = strengths.get(ingredientKey(entry.name));
    const strength = entry.strength ?? directoryStrength;
    const role: IngredientRole | undefined =
      entry.role === "unknown" ? undefined : entry.role;
    return {
      name: entry.name,
      ...(role !== undefined ? { role } : {}),
      ...(strength !== undefined ? { quantity: strength } : {}),
      ...(entry.form !== undefined ? { form: entry.form } : {}),
      identifiers: {
        ...(entry.unii !== undefined ? { unii: entry.unii } : {}),
      },
      source,
    };
  });
}

/** The record shape shared by both openFDA product paths. */
function openFdaRecord(
  product: ProductRef,
  ingredients: IngredientRef[],
  details: OpenFdaProductDetails,
  summary: string | undefined,
  labelIngredientsIncluded: boolean,
): OpenFdaProductRecord {
  return {
    product,
    ingredients,
    details,
    ...(summary !== undefined ? { summary } : {}),
    labelIngredientsIncluded,
  };
}

/** The adapter's openFDA-specific surface, narrowed for callers and tests. */
export interface OpenFdaAdapter extends SourceAdapter {
  getProduct(
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenFdaProductRecord>;
  getIngredient(
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<IngredientLookupRecord>;
}

/**
 * Builds the openFDA adapter.
 *
 * @param client Optional client override. Tests inject one backed by fixtures;
 *   production falls back to the process-wide shared openFDA client.
 * @param bridges SPL bridge used by `include_label_ingredients`; defaults to
 *   the shared NLM bridge and is injectable for tests.
 */
export function createOpenFdaAdapter(
  client?: OpenFdaClient,
  bridges: Pick<NlmBridges, "getSplXml"> = nlmBridges,
): OpenFdaAdapter {
  const clients = () => client ?? getClients().openfda;

  const productSearchTypes: ProductSearchType[] = [
    "name",
    "brand",
    "ingredient",
    "barcode",
    "ndc",
  ];
  const ingredientSearchTypes: IngredientSearchType[] = [
    "name",
    "inci",
    "unii",
    "cas",
  ];

  /** Parses SPL ingredients for a label-backed product, when requested. */
  async function labelIngredients(
    setid: string,
    retrievedAt: string,
    strengths: ReadonlyMap<string, string>,
  ): Promise<IngredientRef[]> {
    const xml = await bridges.getSplXml(setid);
    return splIngredientRefs(
      parseSplIngredients(xml),
      setid,
      retrievedAt,
      strengths,
    );
  }

  /** Builds a record from a directory record, optionally enriching with SPL. */
  async function ndcProductRecord(
    raw: DrugNdc,
    product: ProductRef,
    includeLabelIngredients: boolean,
    retrievedAt: string,
    knownSetid?: string,
  ): Promise<OpenFdaProductRecord> {
    let setid = knownSetid ?? nonEmpty(raw.openfda?.spl_set_id?.[0]);
    let ingredients = directoryIngredients(raw, product.source);
    let included = false;

    if (includeLabelIngredients) {
      if (setid === undefined) {
        const label = await firstLabelRecord(
          clients(),
          field("openfda.product_ndc", product.source.id),
        );
        setid = nonEmpty(label?.set_id);
      }
      if (setid !== undefined) {
        const parsed = await labelIngredients(
          setid,
          retrievedAt,
          directoryStrengths(raw),
        );
        if (parsed.length > 0) ingredients = parsed;
        included = true;
      }
    }

    const details: OpenFdaProductDetails = {
      source: "ndc",
      labeler: nonEmpty(raw.labeler_name),
      marketingCategory: nonEmpty(raw.marketing_category),
      applicationNumber: nonEmpty(raw.application_number),
      ...(setid !== undefined ? { splSetId: setid } : {}),
    };

    return openFdaRecord(
      product,
      ingredients,
      details,
      productSummary(raw),
      included,
    );
  }

  /** Builds a record from a drug label record. */
  async function labelProductRecord(
    label: DrugLabel,
    setid: string,
    includeLabelIngredients: boolean,
    retrievedAt: string,
  ): Promise<OpenFdaProductRecord> {
    const product = labelProductRef(label, setid, retrievedAt);
    let ingredients: IngredientRef[] = [];
    let included = false;
    if (includeLabelIngredients) {
      ingredients = await labelIngredients(setid, retrievedAt, new Map());
      included = true;
    }

    const openfda = label.openfda;
    const details: OpenFdaProductDetails = {
      source: "label",
      labeler: nonEmpty(openfda?.manufacturer_name?.[0]),
      productType: nonEmpty(openfda?.product_type?.[0]),
      applicationNumber: nonEmpty(openfda?.application_number?.[0]),
      splSetId: setid,
      effectiveTime: nonEmpty(label.effective_time),
      version: nonEmpty(label.version),
    };

    return openFdaRecord(
      product,
      ingredients,
      details,
      product.summary,
      included,
    );
  }

  /** Resolves a set id through the NDC directory, then the label endpoint. */
  async function productBySetid(
    setid: string,
    includeLabelIngredients: boolean,
    retrievedAt: string,
  ): Promise<OpenFdaProductRecord> {
    const ndc = await firstNdcRecord(
      clients(),
      field("openfda.spl_set_id", setid),
    );
    if (ndc !== undefined) {
      const base = mapProduct(ndc, retrievedAt);
      if (base !== null) {
        const product: ProductRef = {
          ...base,
          source: {
            database: "openFDA",
            id: setid,
            url: openFdaLabelUrl(setid),
            retrievedAt,
          },
        };
        return await ndcProductRecord(
          ndc,
          product,
          includeLabelIngredients,
          retrievedAt,
          setid,
        );
      }
    }

    const label = await firstLabelRecord(clients(), field("set_id", setid));
    if (label === undefined) throw openFdaNotFound(setid);
    return await labelProductRecord(
      label,
      setid,
      includeLabelIngredients,
      retrievedAt,
    );
  }

  /** Resolves a product NDC through the NDC directory. */
  async function productByNdc(
    id: string,
    includeLabelIngredients: boolean,
    retrievedAt: string,
  ): Promise<OpenFdaProductRecord> {
    const { packageNdc, productNdc } = ndcQueryCandidates(id);
    const clauses = [
      ...productNdc.map((value) => field("product_ndc", value)),
      ...packageNdc.map((value) => field("package_ndc", value)),
    ];
    if (clauses.length === 0) {
      throw new Error(
        `Expected an openFDA product NDC or SPL set id, but got "${id}". Pass an NDC such as "00093-1046", an 11-digit NDC, or a UUID-shaped set id from an openFDA result.`,
      );
    }

    const raw = await firstNdcRecord(clients(), or(...clauses));
    if (raw === undefined) throw openFdaNotFound(id);
    const product = mapProduct(raw, retrievedAt);
    if (product === null) throw openFdaNotFound(id);
    return await ndcProductRecord(
      raw,
      product,
      includeLabelIngredients,
      retrievedAt,
    );
  }

  return {
    id: "openfda",
    databases: ["openFDA"],
    productSearchTypes,
    ingredientSearchTypes,
    productCategories: ["medication"],

    async searchProducts(
      type: ProductSearchType,
      query: string,
      page: number,
    ): Promise<ProductGroup[]> {
      const retrievedAt = new Date().toISOString();

      if (type === "barcode" || type === "ndc") {
        const { packageNdc, productNdc } = ndcQueryCandidates(query);
        const clauses = [
          ...packageNdc.map((value) => field("package_ndc", value)),
          ...productNdc.map((value) => field("product_ndc", value)),
        ];
        if (clauses.length === 0) return [emptyProductGroup(page)];
        // An identifier lookup is the package in hand: it bypasses the
        // off-market filter, which is only meaningful for text discovery.
        return [
          await fetchProducts(clients(), or(...clauses), page, retrievedAt),
        ];
      }

      const trimmed = query.trim();
      if (trimmed.length === 0) return [emptyProductGroup(page)];

      const clause =
        type === "name"
          ? nameClause(trimmed)
          : type === "brand"
            ? brandClause(trimmed)
            : field("active_ingredients.name", trimmed);
      return [
        await fetchProducts(
          clients(),
          currentListingClause(clause),
          page,
          retrievedAt,
        ),
      ];
    },

    async searchIngredients(
      type: IngredientSearchType,
      query: string,
      page: number,
    ): Promise<IngredientGroup[]> {
      const trimmed = query.trim();
      const retrievedAt = new Date().toISOString();
      if (trimmed.length === 0) return [emptyIngredientGroup(page)];

      if (type === "name" || type === "inci") {
        return [
          await crosswalkIngredients(clients(), trimmed, page, retrievedAt),
        ];
      }

      if (type === "unii") {
        return [
          await fetchIngredients(
            clients(),
            field("unii", trimmed.toUpperCase()),
            page,
            retrievedAt,
          ),
        ];
      }

      if (type === "cas") {
        return [
          await fetchIngredients(
            clients(),
            and(
              field("codes.code", trimmed),
              field("codes.code_system", "CAS"),
            ),
            page,
            retrievedAt,
          ),
        ];
      }

      return [emptyIngredientGroup(page)];
    },

    async getProduct(
      id: string,
      opts: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<OpenFdaProductRecord> {
      const trimmed = id.trim();
      const retrievedAt = new Date().toISOString();
      const includeLabelIngredients = opts.includeLabelIngredients === true;

      if (isSplSetId(trimmed)) {
        return await productBySetid(
          trimmed.toLowerCase(),
          includeLabelIngredients,
          retrievedAt,
        );
      }
      return await productByNdc(trimmed, includeLabelIngredients, retrievedAt);
    },

    async getIngredient(
      id: string,
      _opts: Record<string, unknown>,
    ): Promise<IngredientLookupRecord> {
      const retrievedAt = new Date().toISOString();
      return await fetchSubstance(clients(), id, retrievedAt);
    },
  };
}

/** The process-wide adapter, backed by the shared openFDA client. */
export const openfdaAdapter: OpenFdaAdapter = createOpenFdaAdapter();

/** One name-search hit from the openFDA UNII crosswalk, with its match tier. */
export interface OpenFdaSubstanceHit {
  ingredient: IngredientRef;
  tier: SubstanceMatchTier;
}

/** The identifier and product bridges the identity chain consumes. */
export interface OpenFdaBridges {
  /** The substance record for a UNII, or `null` when openFDA has none. */
  substanceByUnii(
    unii: string,
    signal?: AbortSignal,
  ): Promise<IngredientRef | null>;
  /** The substance record for a dashed CAS number, or `null`. */
  substanceByCas(
    cas: string,
    signal?: AbortSignal,
  ): Promise<IngredientRef | null>;
  /**
   * Ranked substance candidates for a name, empty on a zero match. This is
   * the unreliable name path: the crosswalk decides which UNIIs to fetch,
   * and the ranked tier tells the caller whether one is a clear hit.
   */
  substancesByName(
    name: string,
    signal?: AbortSignal,
  ): Promise<OpenFdaSubstanceHit[]>;
  /** One directory product by NDC, or `null` on a zero match. */
  productByNdc(
    ndc: string,
    signal?: AbortSignal,
  ): Promise<OpenFdaProductRecord | null>;
  /** One product by SPL set id, or `null` on a zero match. */
  productBySetId(
    setid: string,
    signal?: AbortSignal,
  ): Promise<OpenFdaProductRecord | null>;
}

/** Fetches a substance record by one fielded search, or `null`. */
async function bridgeSubstance(
  client: OpenFdaClient,
  search: string,
): Promise<IngredientRef | null> {
  const retrievedAt = new Date().toISOString();
  try {
    const response = await client.other.substance.search({ search, limit: 1 });
    const raw = response.results[0];
    return raw === undefined ? null : mapIngredient(raw, retrievedAt);
  } catch (error) {
    if (error instanceof OpenFdaNotFoundError) return null;
    throw openFdaFailure("The openFDA ingredient lookup", error);
  }
}

/** Resolves one product through the adapter, treating a miss as `null`. */
async function bridgeProduct(
  client: OpenFdaClient,
  id: string,
): Promise<OpenFdaProductRecord | null> {
  try {
    return await createOpenFdaAdapter(client).getProduct(id, {
      includeLabelIngredients: false,
    });
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return null;
    throw error;
  }
}

/**
 * Builds the chain-facing openFDA bridges.
 *
 * Unknown or malformed identifiers resolve to `null`/empty results (a zero
 * match, never an error). Name search fetches the crosswalk's UNIIs and ranks
 * the records by how closely their names agree, mirroring the adapter.
 *
 * @param client Optional client override, mirroring
 *   {@link createOpenFdaAdapter}.
 */
export function createOpenFdaBridges(client?: OpenFdaClient): OpenFdaBridges {
  const clients = () => client ?? getClients().openfda;

  return {
    async substanceByUnii(unii, _signal) {
      const normalized = unii.trim().toUpperCase();
      if (!isUnii(normalized)) return null;
      return await bridgeSubstance(clients(), field("unii", normalized));
    },

    async substanceByCas(cas, _signal) {
      const normalized = cas.trim();
      if (!CAS.test(normalized)) return null;
      return await bridgeSubstance(
        clients(),
        and(field("codes.code", normalized), field("codes.code_system", "CAS")),
      );
    },

    async substancesByName(name, _signal) {
      const trimmed = name.trim();
      if (trimmed.length === 0) return [];

      const entries = await crosswalkEntries(clients(), trimmed, 1);
      const retrievedAt = new Date().toISOString();
      const records: Substance[] = [];
      for (const entry of entries) {
        const unii = nonEmpty(entry.unii);
        if (unii === undefined) continue;
        try {
          const response = await clients().other.substance.search({
            search: field("unii", unii),
            limit: 1,
          });
          const record = response.results[0];
          if (record !== undefined) records.push(record);
        } catch (error) {
          if (!(error instanceof OpenFdaNotFoundError)) {
            throw openFdaFailure("The openFDA ingredient search", error);
          }
        }
      }

      const hits: OpenFdaSubstanceHit[] = [];
      for (const record of rankSubstances(records, trimmed)) {
        const ingredient = mapIngredient(
          record,
          retrievedAt,
          MATCH_BASIS[matchSubstanceTier(record, trimmed)],
        );
        if (ingredient !== null) {
          hits.push({ ingredient, tier: matchSubstanceTier(record, trimmed) });
        }
      }
      return hits;
    },

    async productByNdc(ndc, _signal) {
      return await bridgeProduct(clients(), ndc.trim());
    },

    async productBySetId(setid, _signal) {
      return await bridgeProduct(clients(), setid.trim().toLowerCase());
    },
  };
}

/** The process-wide chain bridges, backed by the shared openFDA client. */
export const openfdaBridges: OpenFdaBridges = createOpenFdaBridges();
