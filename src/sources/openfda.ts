import {
  and,
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
import type {
  IngredientIdentifiers,
  IngredientRef,
  ProductIdentifiers,
  ProductRef,
} from "../lib/schemas.js";
import { parseBarcodeInput } from "./identity/barcode.js";
import type {
  IngredientGroup,
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
function ndcQueryCandidates(raw: string): {
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

/**
 * Builds the openFDA adapter.
 *
 * @param client Optional client override. Tests inject one backed by fixtures;
 *   production falls back to the process-wide shared openFDA client.
 */
export function createOpenFdaAdapter(client?: OpenFdaClient): SourceAdapter {
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
  };
}

/** The process-wide adapter, backed by the shared openFDA client. */
export const openfdaAdapter: SourceAdapter = createOpenFdaAdapter();
