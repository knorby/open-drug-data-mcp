import {
  APPLY_SYNONYMS,
  BROWSE_METHODS,
  type Claim,
  type DsldClient,
  type Hit,
  type IngredientGroupDoc,
  type IngredientQuantity,
  type IngredientRow,
  type Label,
  MARKET_STATUS,
  type NetContents,
  type OtherIngredient,
  type SearchFilters,
  type SearchLabelSource,
  type SearchResult,
} from "@knorby/nih-dsld-client";
import { getClients } from "../clients.js";
import type {
  IngredientIdentifiers,
  IngredientRef,
  IngredientRole,
  ProductIdentifiers,
  ProductRef,
  SourceRef,
} from "../lib/schemas.js";
import { parseBarcodeInput } from "./identity/barcode.js";
import type {
  ProductGroup,
  ProductSearchType,
  SourceAdapter,
} from "./types.js";

/**
 * The NIH DSLD source adapter.
 *
 * DSLD is the US dietary-supplement label database. It contributes
 * **supplement products only**: label summaries from the search index, one
 * full label behind `getProduct`, and the label's ingredient rows as
 * `IngredientRef`s. Ingredient rows keep the source's `uniiCode` as
 * `identifiers.unii`, their Supplement Facts / "other ingredients" role, and
 * their quantity, which is what the identity chain pivots on later.
 *
 * **Search strategy**
 *
 * - `name` uses the fielded `product_name` filter, restricted to on-market
 *   labels. The `q` catch-all is deliberately not used: a product name is a
 *   product-name search.
 * - `brand` resolves brand spelling through `brands.browse` first. Exact
 *   normalized hits (case and punctuation aside) win; otherwise the browsed
 *   candidates are used, and a browse with no usable names falls back to the
 *   typed value. Products are then filtered by `brand`, never by `q`. The
 *   first browse page is the spelling authority; `page` pages the label
 *   results, not the brand list.
 * - `ingredient` uses the `ingredient_name` filter with `apply_synonyms:
 *   "Yes"`, also restricted to on-market labels.
 * - `barcode` runs the parser's `upcVariants` through `search.byBarcode`,
 *   unions the pages, and collapses duplicate label ids. An NDC-shaped or
 *   unrecognizable code never reaches DSLD: it is a drug identifier, not a
 *   supplement package barcode.
 *
 * **Cost.** A search maps only search-index hits; it never fetches a full
 * label. `getProduct` fetches one label, then best-effort nutrient-info rows
 * for ingredients that have no UNII (the only place DSLD publishes CAS), so a
 * label that already carries UNIIs costs exactly one request.
 *
 * **Pagination.** One page per call; every search reports `hasMore` from a
 * full page. The adapter never walks pages on its own.
 *
 * **Signals.** No DSLD client method accepts an `AbortSignal` (verified
 * against the published type declarations), so an `AbortSignal` passed
 * through the `SourceAdapter` contract cannot cancel an in-flight request.
 * Failures are reworded to name only DSLD: client package names, raw URLs
 * (which carry an optional API key), upstream bodies, and underlying error
 * text never reach the agent. A 429 keeps the server's `Retry-After` advice
 * as a wait instruction without exposing headers.
 */

/** Records per page, matching the other search adapters. */
const PAGE_SIZE = 20;

/** Brand names requested per brand-browse resolution. */
const BRAND_LIMIT = 20;

/** Ingredient-group candidates requested per nutrient-info lookup. */
const GROUP_LIMIT = 10;

/** Ingredient names listed in a search summary before "+N more". */
const INGREDIENT_SUMMARY_LIMIT = 5;

/** DSLD's `status: 1` filter value: on-market labels only. */
const ON_MARKET = MARKET_STATUS.ON_MARKET;

/** A non-blank string, trimmed, or `undefined` when absent or blank. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Deduplicates values without altering their spelling or order. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Case-, punctuation-, and space-insensitive comparison key. */
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** An ordinary empty result: a zero match is not an error. */
function emptyProductGroup(page: number): ProductGroup {
  return { source: "DSLD", items: [], page, hasMore: false };
}

/** Deep link to the public DSLD label page. */
function labelUrl(id: number): string {
  return `https://dsld.od.nih.gov/label/${id}`;
}

/** The source reference every DSLD ref carries. */
function labelSourceRef(id: number, retrievedAt: string): SourceRef {
  return {
    database: "DSLD",
    id: String(id),
    url: labelUrl(id),
    retrievedAt,
  };
}

/**
 * A quantity as model-facing text (`"200 mg"`). Either half may be absent;
 * neither is invented.
 */
function amountText(
  quantity: number | undefined,
  unit: string | undefined,
): string | undefined {
  const amount = typeof quantity === "number" ? String(quantity) : undefined;
  const suffix = nonEmpty(unit);
  if (amount !== undefined && suffix !== undefined)
    return `${amount} ${suffix}`;
  return amount ?? suffix;
}

/** Net-content entries as the label displays them, with a computed fallback. */
function contentsText(entries: readonly NetContents[] | undefined): string[] {
  const texts: string[] = [];
  for (const entry of entries ?? []) {
    const text =
      nonEmpty(entry.display) ?? amountText(entry.quantity, entry.unit);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

/** Claim descriptions the label prints. */
function claimTexts(claims: readonly Claim[] | undefined): string[] {
  const texts: string[] = [];
  for (const claim of claims ?? []) {
    const text = nonEmpty(claim.langualCodeDescription);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

/** Target-group names the label prints. */
function targetGroupTexts(label: Label): string[] {
  const texts: string[] = [];
  for (const group of label.targetGroups ?? []) {
    const text = nonEmpty(group);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

/**
 * A short search-result summary: product type, package size, and the first
 * few ingredient names. Every value is DSLD's; the labels between values are
 * ours.
 */
function searchSummary(raw: SearchLabelSource): string | undefined {
  const parts: string[] = [];
  const type = nonEmpty(raw.productType?.langualCodeDescription);
  if (type !== undefined) parts.push(type);

  const contents = contentsText(raw.netContents);
  if (contents.length > 0) parts.push(contents.join(", "));

  const names = unique(
    (raw.allIngredients ?? [])
      .map((ingredient) => nonEmpty(ingredient.name))
      .filter((name): name is string => name !== undefined),
  );
  if (names.length > 0) {
    const head = names.slice(0, INGREDIENT_SUMMARY_LIMIT);
    const extra = names.length - head.length;
    parts.push(
      `Ingredients: ${head.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`,
    );
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A short label-summary string for a full label's product ref. */
function labelSummary(label: Label): string | undefined {
  const parts: string[] = [];
  const type = nonEmpty(label.productType?.langualCodeDescription);
  if (type !== undefined) parts.push(type);

  const contents = contentsText(label.netContents);
  if (contents.length > 0) parts.push(contents.join(", "));

  const count =
    (label.ingredientRows?.length ?? 0) +
    (label.otheringredients?.ingredients?.length ?? 0);
  if (count > 0) {
    parts.push(`${count} ${count === 1 ? "ingredient" : "ingredients"}`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Maps one search hit to a product ref. A hit without a positive label id has
 * no stable identity or deep link, so it is dropped rather than emitted with
 * an empty source id.
 */
function productRefOf(
  raw: SearchLabelSource | undefined,
  retrievedAt: string,
): ProductRef | null {
  if (raw === undefined) return null;
  const id = raw.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;

  const brand = nonEmpty(raw.brandName);
  const upc = nonEmpty(raw.upcSku);
  const summary = searchSummary(raw);
  const identifiers: ProductIdentifiers = {
    dsldId: id,
    ...(upc !== undefined ? { upc: [upc] } : {}),
  };

  return {
    name: nonEmpty(raw.fullName) ?? brand ?? `DSLD label ${id}`,
    ...(brand !== undefined ? { brand } : {}),
    category: "supplement",
    identifiers,
    source: labelSourceRef(id, retrievedAt),
    ...(summary !== undefined ? { summary } : {}),
  };
}

/** Maps one search page, collapsing labels that repeat across hits. */
function mapSearchResult(
  result: SearchResult,
  retrievedAt: string,
): ProductRef[] {
  const items: ProductRef[] = [];
  const seen = new Set<number>();
  for (const hit of result.hits ?? []) {
    const ref = productRefOf(hit._source, retrievedAt);
    if (ref === null) continue;
    const id = ref.identifiers.dsldId;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    items.push(ref);
  }
  return items;
}

/** Whether a page came back full (the caller may request another page). */
function hasFullPage(result: SearchResult): boolean {
  return (result.hits?.length ?? 0) === PAGE_SIZE;
}

/**
 * Turns a failed request into model-facing text.
 *
 * The message carries only DSLD's status and advice: client names, raw URLs
 * (which may include an API key), upstream bodies, and underlying error text
 * are deliberately dropped. A 429 keeps `Retry-After` as a wait instruction.
 */
function dsldFailure(context: string, error: unknown): Error {
  const status = (error as { status?: unknown } | null | undefined)?.status;

  if (status === 429) {
    const retryAfter = (
      error as { retryAfterSeconds?: unknown } | null | undefined
    )?.retryAfterSeconds;
    const advice =
      typeof retryAfter === "number" &&
      Number.isFinite(retryAfter) &&
      retryAfter > 0
        ? `Wait ${Math.ceil(retryAfter)} seconds, then retry.`
        : "Wait a few seconds, then retry.";
    return new Error(
      `${context} was rate limited by DSLD (HTTP 429). ${advice}`,
    );
  }

  if (typeof status === "number" && status >= 500) {
    return new Error(
      `${context} failed: DSLD returned HTTP ${status}. The service may be temporarily unavailable or the request was rejected; retry shortly, or adjust the input if it persists.`,
    );
  }

  if (typeof status === "number") {
    return new Error(
      `${context} failed: DSLD rejected the request (HTTP ${status}). Check the value and try again.`,
    );
  }

  return new Error(
    `${context} failed: DSLD did not return a usable response. Retry shortly.`,
  );
}

/** Runs one `search-filter` page and maps its hits. */
async function searchGroup(
  client: DsldClient,
  filters: SearchFilters,
  page: number,
  retrievedAt: string,
  context: string,
): Promise<ProductGroup> {
  try {
    const result = await client.search.labels({
      ...filters,
      from: (page - 1) * PAGE_SIZE,
      size: PAGE_SIZE,
    });
    return {
      source: "DSLD",
      items: mapSearchResult(result, retrievedAt),
      page,
      hasMore: hasFullPage(result),
    };
  } catch (error) {
    throw dsldFailure(context, error);
  }
}

/**
 * Resolves the brand names a query means.
 *
 * `brands.browse` is the spelling authority: exact normalized matches win so
 * "natures best" reaches the label that says "Nature's Best". A browse with
 * no exact match contributes its keyword candidates; an empty browse falls
 * back to the typed value. Either way the product search filters by `brand`.
 */
async function brandNames(
  client: DsldClient,
  query: string,
): Promise<string[]> {
  try {
    const result = await client.brands.browse({
      method: BROWSE_METHODS.BY_KEYWORD,
      q: query,
      from: 0,
      size: BRAND_LIMIT,
    });
    const names: string[] = [];
    for (const hit of result.hits ?? []) {
      const name =
        nonEmpty(hit._source?.brandName) ?? nonEmpty(hit._source?.brand);
      if (name !== undefined) names.push(name);
    }

    const candidates = unique(names);
    const target = normalizeToken(query);
    const exact = candidates.filter(
      (candidate) => normalizeToken(candidate) === target,
    );
    if (exact.length > 0) return exact;
    return candidates.length > 0 ? candidates : [query];
  } catch (error) {
    throw dsldFailure("The brand search", error);
  }
}

/** Runs a brand search: resolve the spelling, then filter labels by brand. */
async function brandGroup(
  client: DsldClient,
  query: string,
  page: number,
  retrievedAt: string,
): Promise<ProductGroup> {
  const names = await brandNames(client, query);
  return await searchGroup(
    client,
    { brand: names.length === 1 ? names[0] : names, status: ON_MARKET },
    page,
    retrievedAt,
    "The brand search",
  );
}

/**
 * Runs a barcode search over every parser variant.
 *
 * `search.byBarcode` handles DSLD's own spacing variants; the parser's
 * variants are the caller-level readings (digits-only and space-grouped).
 * Pages from both are unioned and duplicate label ids collapse, so a scan
 * answered by both spellings still yields one ref per label.
 */
async function barcodeGroup(
  client: DsldClient,
  query: string,
  page: number,
  retrievedAt: string,
): Promise<ProductGroup> {
  const parsed = parseBarcodeInput(query);
  if (parsed.kind !== "upc") return emptyProductGroup(page);

  const items: ProductRef[] = [];
  const seen = new Set<number>();
  let hasMore = false;

  for (const variant of unique(parsed.upcVariants)) {
    let result: SearchResult;
    try {
      result = await client.search.byBarcode(variant, {
        from: (page - 1) * PAGE_SIZE,
        size: PAGE_SIZE,
      });
    } catch (error) {
      throw dsldFailure("The barcode search", error);
    }

    for (const ref of mapSearchResult(result, retrievedAt)) {
      const id = ref.identifiers.dsldId;
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      items.push(ref);
    }
    hasMore = hasMore || hasFullPage(result);
  }

  return { source: "DSLD", items, page, hasMore };
}

/** A label ingredient row, active or inactive, in one shared shape. */
interface LabelIngredient {
  name?: string;
  description?: string;
  category?: string;
  ingredientGroup?: string;
  uniiCode?: string;
  quantity?: IngredientQuantity[];
}

/** The nutrient facts DSLD publishes on an ingredient group. */
interface NutrientInfo {
  cas: string[];
  category?: string;
  groupName?: string;
}

/** The ingredient name a label row carries, preferring the display name. */
function ingredientName(row: LabelIngredient): string | undefined {
  return (
    nonEmpty(row.name) ??
    nonEmpty(row.description) ??
    nonEmpty(row.ingredientGroup)
  );
}

/** Quantity entries as model-facing text. */
function quantityTexts(
  entries: readonly IngredientQuantity[] | undefined,
): string[] {
  const texts: string[] = [];
  for (const entry of entries ?? []) {
    const text = amountText(entry.quantity, entry.unit);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

/** Finds the ingredient group whose name or synonym is exactly the row name. */
function findGroup(
  hits: readonly Hit<IngredientGroupDoc>[] | undefined,
  name: string,
): IngredientGroupDoc | undefined {
  const target = normalizeToken(name);

  for (const hit of hits ?? []) {
    const doc = hit._source;
    if (doc === undefined) continue;
    const names = [doc.groupName ?? "", ...(doc.synonyms ?? [])];
    for (const candidate of names) {
      if (normalizeToken(candidate) === target) return doc;
    }
  }
  return undefined;
}

/** Reads CAS numbers, category, and name from an ingredient group. */
function nutrientInfoOf(doc: IngredientGroupDoc): NutrientInfo {
  const cas: string[] = [];
  for (const info of doc.nutrientInfo ?? []) {
    const value = nonEmpty(info.cas);
    if (value !== undefined) cas.push(value);
  }
  const category = nonEmpty(doc.category?.[0]);
  const groupName = nonEmpty(doc.groupName);

  return {
    cas: unique(cas),
    ...(category !== undefined ? { category } : {}),
    ...(groupName !== undefined ? { groupName } : {}),
  };
}

/**
 * Best-effort CAS and category lookup for label rows without a UNII.
 *
 * One `ingredient-groups` request per distinct name, bounded by the label's
 * own ingredient list. A group contributes CAS only on an exact normalized
 * name or synonym match: a near-miss would attach another ingredient's CAS to
 * the label row, which is worse than leaving it blank. Any failure (including
 * a 429) is treated as absent enrichment: the label is the authoritative
 * payload, and optional identity data must not fail it.
 */
async function nutrientInfoByName(
  client: DsldClient,
  names: readonly string[],
): Promise<Map<string, NutrientInfo>> {
  const result = new Map<string, NutrientInfo>();

  for (const name of unique(names)) {
    const key = normalizeToken(name);
    if (key.length === 0 || result.has(key)) continue;

    try {
      const groups = await client.ingredients.groups({
        term: name,
        method: BROWSE_METHODS.BY_KEYWORD,
        size: GROUP_LIMIT,
      });
      const match = findGroup(groups.hits, name);
      if (match !== undefined) result.set(key, nutrientInfoOf(match));
    } catch {
      // Optional enrichment: the label remains usable without it.
    }
  }

  return result;
}

/** A short ingredient summary: label category and ingredient group. */
function ingredientSummary(
  row: LabelIngredient,
  info: NutrientInfo | undefined,
): string | undefined {
  const parts: string[] = [];
  const category = nonEmpty(row.category) ?? info?.category;
  if (category !== undefined) parts.push(`Category: ${category}`);
  const group = nonEmpty(row.ingredientGroup) ?? info?.groupName;
  if (group !== undefined) parts.push(`Group: ${group}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Maps one label row to an ingredient ref. */
function ingredientRefOf(
  row: LabelIngredient,
  role: IngredientRole,
  source: SourceRef,
  enrichment: ReadonlyMap<string, NutrientInfo>,
): IngredientRef | null {
  const name = ingredientName(row);
  if (name === undefined) return null;

  const unii = nonEmpty(row.uniiCode);
  const info = enrichment.get(normalizeToken(name));
  const cas = info?.cas ?? [];
  const identifiers: IngredientIdentifiers = {
    ...(unii !== undefined ? { unii } : {}),
    ...(cas.length > 0 ? { cas } : {}),
  };
  const quantities = quantityTexts(row.quantity);
  const summary = ingredientSummary(row, info);

  return {
    name,
    role,
    ...(quantities.length > 0 ? { quantity: quantities.join(" · ") } : {}),
    identifiers,
    source,
    ...(summary !== undefined ? { summary } : {}),
  };
}

/**
 * Maps every active and inactive ingredient row on a label.
 *
 * `nestedRows` are sub-rows under a parent ingredient (for blends); they carry
 * no independent name or UNII, so the parent row is the unit this adapter
 * emits.
 */
async function labelIngredientRefs(
  client: DsldClient,
  label: Label,
  source: SourceRef,
): Promise<IngredientRef[]> {
  const rows: { row: LabelIngredient; role: IngredientRole }[] = [
    ...(label.ingredientRows ?? []).map((row: IngredientRow) => ({
      row,
      role: "active" as const,
    })),
    ...(label.otheringredients?.ingredients ?? []).map(
      (row: OtherIngredient) => ({ row, role: "inactive" as const }),
    ),
  ];

  const missingUnii: string[] = [];
  for (const { row } of rows) {
    if (nonEmpty(row.uniiCode) !== undefined) continue;
    const name = ingredientName(row);
    if (name !== undefined) missingUnii.push(name);
  }
  const enrichment = await nutrientInfoByName(client, missingUnii);

  const items: IngredientRef[] = [];
  for (const { row, role } of rows) {
    const ref = ingredientRefOf(row, role, source, enrichment);
    if (ref !== null) items.push(ref);
  }
  return items;
}

/** The detail sections `getProduct` exposes for a DSLD label. */
export interface DsldLabelDetails {
  productType?: string;
  targetGroups: string[];
  netContents: string[];
  claims: string[];
  offMarket?: boolean;
  entryDate?: string;
}

/** A full DSLD label in the unified vocabulary. */
export interface DsldLabelRecord {
  product: ProductRef;
  details: DsldLabelDetails;
  ingredients: IngredientRef[];
}

/** Maps a full label to its product ref, details, and ingredient rows. */
async function labelRecord(
  client: DsldClient,
  label: Label,
  retrievedAt: string,
): Promise<DsldLabelRecord> {
  const source = labelSourceRef(label.id, retrievedAt);
  const brand = nonEmpty(label.brandName);
  const upc = nonEmpty(label.upcSku);
  const productType = nonEmpty(label.productType?.langualCodeDescription);
  const entryDate = nonEmpty(label.entryDate);
  const summary = labelSummary(label);
  const offMarket =
    typeof label.offMarket === "number" ? label.offMarket === 1 : undefined;

  const product: ProductRef = {
    name: nonEmpty(label.fullName) ?? brand ?? `DSLD label ${label.id}`,
    ...(brand !== undefined ? { brand } : {}),
    category: "supplement",
    identifiers: {
      dsldId: label.id,
      ...(upc !== undefined ? { upc: [upc] } : {}),
    },
    source,
    ...(summary !== undefined ? { summary } : {}),
  };

  return {
    product,
    details: {
      ...(productType !== undefined ? { productType } : {}),
      targetGroups: targetGroupTexts(label),
      netContents: contentsText(label.netContents),
      claims: claimTexts(label.claims),
      ...(offMarket !== undefined ? { offMarket } : {}),
      ...(entryDate !== undefined ? { entryDate } : {}),
    },
    ingredients: await labelIngredientRefs(client, label, source),
  };
}

/** Rejects a value that cannot identify a DSLD label. */
function parseLabelId(id: string): number {
  const trimmed = id.trim();
  const numeric = Number(trimmed);
  if (
    !/^\d+$/.test(trimmed) ||
    !Number.isSafeInteger(numeric) ||
    numeric <= 0
  ) {
    throw new Error(
      `Expected a DSLD label id, but got "${trimmed}". Pass identifiers.dsldId from a DSLD product result.`,
    );
  }
  return numeric;
}

/** The adapter's DSLD-specific surface, narrowed for callers and tests. */
export interface DsldAdapter extends SourceAdapter {
  searchProducts: NonNullable<SourceAdapter["searchProducts"]>;
  getProduct(
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DsldLabelRecord>;
}

/**
 * Builds the DSLD adapter.
 *
 * @param client Optional client override. Tests inject one backed by fixtures;
 *   production falls back to the process-wide shared DSLD client.
 */
export function createDsldAdapter(client?: DsldClient): DsldAdapter {
  const clients = () => client ?? getClients().dsld;
  const productSearchTypes: ProductSearchType[] = [
    "name",
    "brand",
    "ingredient",
    "barcode",
  ];

  return {
    id: "dsld",
    databases: ["DSLD"],
    productSearchTypes,
    ingredientSearchTypes: [],
    productCategories: ["supplement"],

    async searchProducts(
      type: ProductSearchType,
      query: string,
      page: number,
      _signal?: AbortSignal,
    ): Promise<ProductGroup[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [emptyProductGroup(page)];

      const retrievedAt = new Date().toISOString();
      const dsld = clients();

      switch (type) {
        case "name":
          return [
            await searchGroup(
              dsld,
              { product_name: trimmed, status: ON_MARKET },
              page,
              retrievedAt,
              "The product search",
            ),
          ];
        case "brand":
          return [await brandGroup(dsld, trimmed, page, retrievedAt)];
        case "ingredient":
          return [
            await searchGroup(
              dsld,
              {
                ingredient_name: trimmed,
                apply_synonyms: APPLY_SYNONYMS.YES,
                status: ON_MARKET,
              },
              page,
              retrievedAt,
              "The product search",
            ),
          ];
        case "barcode":
          return [await barcodeGroup(dsld, trimmed, page, retrievedAt)];
        default:
          return [emptyProductGroup(page)];
      }
    },

    async getProduct(
      id: string,
      _opts: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<DsldLabelRecord> {
      const labelId = parseLabelId(id);
      const retrievedAt = new Date().toISOString();
      const dsld = clients();

      try {
        const label = await dsld.label.get(labelId);
        return await labelRecord(dsld, label, retrievedAt);
      } catch (error) {
        throw dsldFailure("The label lookup", error);
      }
    },
  };
}

/** The process-wide adapter, backed by the shared DSLD client. */
export const dsldAdapter: DsldAdapter = createDsldAdapter();
