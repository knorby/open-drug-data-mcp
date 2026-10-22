import type {
  Ingredient as ClientIngredient,
  IngredientRef as ClientIngredientRef,
  Product as ClientProduct,
  Ref as ClientRef,
  InkeedecoderClient,
  Paginated,
} from "@knorby/inkeedecoder-client";
import { getClients } from "../clients.js";
import { normalizeSlug } from "../lib/ids.js";
import type {
  IngredientIdentifiers,
  IngredientRef,
  ProductRef,
  SourceRef,
} from "../lib/schemas.js";
import type {
  IngredientGroup,
  IngredientSearchType,
  ProductGroup,
  ProductSearchType,
  SourceAdapter,
} from "./types.js";

/**
 * The INKEEDecoder source adapter.
 *
 * INKEEDecoder is a cosmetics database: product pages list a product's INCI
 * ingredients, and ingredient pages describe one ingredient. It contributes
 * **cosmetic products and ingredients only**.
 *
 * **Search strategy**
 *
 * - Product `name` uses the site's combined search and maps the products tab
 *   (one request on page 1, one per tab on later pages).
 * - Product `ingredient` uses the advanced include-ingredient filter. The site
 *   matches the ingredient display name, so a product can be found from an
 *   ingredient name without resolving a slug first.
 * - Ingredient `name` and `inci` use the ingredients tab. The site does not
 *   separate trade and INCI names, so both types search the same tab; the
 *   ref's `matchBasis` says which type found it.
 *
 * Product `brand` is deliberately not a supported product search type: the
 * site has no brand entity in search, and a product-name search already
 * surfaces brand-prefixed names. A caller that filters by `cosmetic` still
 * receives INKEEDecoder results for name and ingredient searches.
 *
 * **Cost.** A search maps only the search page; it never fetches a product or
 * ingredient page per hit. `get_product` fetches one product page and maps its
 * ingredient list from that same page. `get_ingredient` fetches one ingredient
 * page with its CosIng panel, which supplies CAS and EC numbers. The shared
 * client's polite request pacing is preserved because the adapter never
 * constructs a client of its own.
 *
 * **Pagination.** One page per call, from the client's `page` option. The
 * adapter never walks pages.
 *
 * **Signals.** Every client method accepts an `AbortSignal`, so the adapter
 * forwards the caller's signal into the request.
 *
 * **Failures.** The client throws plain `Error`s whose messages carry the
 * request URL. The adapter rewords every upstream failure to name only
 * INKEEDecoder: client package names, URLs (including the query string),
 * upstream HTML, and underlying error text never reach the agent.
 */

/** The site's canonical host, used only for defensive link fallbacks. */
const SITE_URL = "https://inkeedecoder.com";

/** A CAS or EC value list may be comma- or semicolon-separated. */
const IDENTIFIER_SEPARATOR = /[,;]/;

/** A non-blank string, trimmed, or `undefined` when absent or blank. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Deduplicates values without altering their spelling or order. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** An ordinary empty result: a zero match is not an error. */
function emptyProductGroup(page: number): ProductGroup {
  return { source: "INKEEDecoder", items: [], page, hasMore: false };
}

/** An ordinary empty result: a zero match is not an error. */
function emptyIngredientGroup(page: number): IngredientGroup {
  return { source: "INKEEDecoder", items: [], page, hasMore: false };
}

/** Deep link to an INKEEDecoder product page. */
function productUrl(slug: string): string {
  return `${SITE_URL}/products/${slug}`;
}

/** Deep link to an INKEEDecoder ingredient page. */
function ingredientUrl(slug: string): string {
  return `${SITE_URL}/ingredients/${slug}`;
}

/** The source reference every INKEEDecoder ref carries. */
function sourceOf(id: string, url: string, retrievedAt: string): SourceRef {
  return { database: "INKEEDecoder", id, url, retrievedAt };
}

/** Splits a CosIng CAS/EC value into identifier entries. */
function identifierList(value: string | undefined): string[] {
  if (value === undefined) return [];
  const parts = value
    .split(IDENTIFIER_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return unique(parts);
}

/** Maps one product search hit to the unified product vocabulary. */
function productRefOf(ref: ClientRef, retrievedAt: string): ProductRef {
  return {
    name: ref.name,
    category: "cosmetic",
    identifiers: { slug: ref.slug },
    source: sourceOf(ref.slug, ref.url, retrievedAt),
  };
}

/** Maps one ingredient search hit to the unified ingredient vocabulary. */
function ingredientRefOf(
  ref: ClientRef,
  retrievedAt: string,
  matchBasis: string,
): IngredientRef {
  return {
    name: ref.name,
    inciName: ref.name,
    identifiers: { slug: ref.slug },
    source: sourceOf(ref.slug, ref.url, retrievedAt),
    matchBasis,
  };
}

/**
 * A short source-faithful ingredient summary: the site's functions, its
 * editorial rating, safety notes, and the CosIng panel's functions and IUPAC
 * name. Labels are ours; every value is INKEEDecoder's.
 */
function ingredientSummaryOf(item: ClientIngredient): string | undefined {
  const parts: string[] = [];

  const functions = (item.functions ?? []).map((entry) => entry.name);
  if (functions.length > 0) {
    parts.push(`Functions: ${functions.join(", ")}`);
  }
  if (item.ourTake) parts.push(`Our take: ${item.ourTake}`);

  const irritancy = nonEmpty(item.irritancy);
  if (irritancy !== undefined) parts.push(`Irritancy: ${irritancy}`);
  const comedogenicity = nonEmpty(item.comedogenicity);
  if (comedogenicity !== undefined) {
    parts.push(`Comedogenicity: ${comedogenicity}`);
  }

  const cosingFunctions = nonEmpty(item.cosing?.allFunctions);
  if (cosingFunctions !== undefined) {
    parts.push(`CosIng functions: ${cosingFunctions}`);
  }
  const iupacName = nonEmpty(item.cosing?.iupacName);
  if (iupacName !== undefined) parts.push(`IUPAC name: ${iupacName}`);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Details the adapter exposes for one ingredient page. */
export interface IkdIngredientDetails {
  /** The site's ingredient-function names, in page order. */
  functions: string[];
  alsoCalled?: string;
  irritancy?: string;
  comedogenicity?: string;
  /** CosIng's official function wording. */
  cosingFunctions?: string;
  iupacName?: string;
  image?: string;
  details?: string;
  proof: string[];
}

/** A full INKEEDecoder ingredient in the unified vocabulary. */
export interface IkdIngredientRecord {
  ingredient: IngredientRef;
  details: IkdIngredientDetails;
}

/** Maps one ingredient page to its ref and details. */
function ingredientRecordOf(
  item: ClientIngredient,
  requestedSlug: string,
  retrievedAt: string,
): IkdIngredientRecord {
  const slug = nonEmpty(item.slug) ?? requestedSlug;
  const name = nonEmpty(item.name) ?? slug;
  const cas = identifierList(item.cosing?.cas);
  const ec = identifierList(item.cosing?.ec);
  const summary = ingredientSummaryOf(item);
  const alsoCalled = nonEmpty(item.alsoCalled);
  const irritancy = nonEmpty(item.irritancy);
  const comedogenicity = nonEmpty(item.comedogenicity);
  const cosingFunctions = nonEmpty(item.cosing?.allFunctions);
  const iupacName = nonEmpty(item.cosing?.iupacName);
  const image = nonEmpty(item.image);
  const details = nonEmpty(item.details);

  const identifiers: IngredientIdentifiers = {
    slug,
    ...(cas.length > 0 ? { cas } : {}),
    ...(ec.length > 0 ? { ec } : {}),
  };

  return {
    ingredient: {
      name,
      inciName: name,
      identifiers,
      source: sourceOf(
        slug,
        nonEmpty(item.url) ?? ingredientUrl(slug),
        retrievedAt,
      ),
      ...(summary !== undefined ? { summary } : {}),
    },
    details: {
      functions: (item.functions ?? []).map((entry) => entry.name),
      ...(alsoCalled !== undefined ? { alsoCalled } : {}),
      ...(irritancy !== undefined ? { irritancy } : {}),
      ...(comedogenicity !== undefined ? { comedogenicity } : {}),
      ...(cosingFunctions !== undefined ? { cosingFunctions } : {}),
      ...(iupacName !== undefined ? { iupacName } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(details !== undefined ? { details } : {}),
      proof: item.proof ?? [],
    },
  };
}

/** Details the adapter exposes for one product page. */
export interface IkdProductDetails {
  description?: string;
  /** Human labels for the product's claims (for example "Alcohol Free"). */
  hashtags: string[];
  uploadedBy?: string;
  uploadedAt?: string;
  updatedAt?: string;
}

/** A full INKEEDecoder product in the unified vocabulary. */
export interface IkdProductRecord {
  product: ProductRef;
  details: IkdProductDetails;
  ingredients: IngredientRef[];
}

/** Maps one product-page ingredient row to a resolvable ingredient ref. */
function productIngredientRefOf(
  item: ClientIngredientRef,
  retrievedAt: string,
): IngredientRef {
  const percent = nonEmpty(item.percent);
  return {
    name: item.name,
    ...(percent !== undefined ? { quantity: `${percent}%` } : {}),
    identifiers: { slug: item.slug },
    source: sourceOf(
      item.slug,
      nonEmpty(item.url) ?? ingredientUrl(item.slug),
      retrievedAt,
    ),
    ...(item.ourTake !== undefined
      ? { summary: `Our take: ${item.ourTake}` }
      : {}),
  };
}

/** Maps one product page to its ref, details, and ingredient rows. */
function productRecordOf(
  product: ClientProduct,
  requestedSlug: string,
  retrievedAt: string,
): IkdProductRecord {
  const slug = nonEmpty(product.slug) ?? requestedSlug;
  const brand = nonEmpty(product.brand?.name);
  const description = nonEmpty(product.description);
  const uploadedBy = nonEmpty(product.dates?.uploadedBy);
  const uploadedAt = nonEmpty(product.dates?.uploadedAt);
  const updatedAt = nonEmpty(product.dates?.updatedAt);

  return {
    product: {
      name: nonEmpty(product.fullName) ?? nonEmpty(product.name) ?? slug,
      ...(brand !== undefined ? { brand } : {}),
      category: "cosmetic",
      identifiers: { slug },
      source: sourceOf(
        slug,
        nonEmpty(product.url) ?? productUrl(slug),
        retrievedAt,
      ),
    },
    details: {
      ...(description !== undefined ? { description } : {}),
      hashtags: (product.hashtags ?? []).map((hashtag) => hashtag.label),
      ...(uploadedBy !== undefined ? { uploadedBy } : {}),
      ...(uploadedAt !== undefined ? { uploadedAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    },
    ingredients: (product.ingredients ?? []).map((item) =>
      productIngredientRefOf(item, retrievedAt),
    ),
  };
}

/** The HTTP status a client failure carries, when it has one. */
function statusOf(error: unknown): number | undefined {
  const direct = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof direct === "number") return direct;

  const message = error instanceof Error ? error.message : "";
  const match = /\bfailed:\s*(\d{3})\b/.exec(message);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

/**
 * Turns a failed request into model-facing text.
 *
 * The message carries only INKEEDecoder's status and advice: client names,
 * raw URLs (which carry the search query), upstream HTML, and underlying
 * error text are deliberately dropped.
 */
function ikdFailure(context: string, error: unknown): Error {
  const status = statusOf(error);

  if (status === 429) {
    return new Error(
      `${context} was rate limited by INKEEDecoder (HTTP 429). Wait a few seconds, then retry.`,
    );
  }
  if (status === 404) {
    return new Error(
      `${context} failed: INKEEDecoder has no record at that address (HTTP 404). Check identifiers.slug from an INKEEDecoder result.`,
    );
  }
  if (status !== undefined && status >= 500) {
    return new Error(
      `${context} failed: INKEEDecoder returned HTTP ${status} and may be temporarily unavailable. Retry shortly.`,
    );
  }
  if (status !== undefined) {
    return new Error(
      `${context} failed: INKEEDecoder rejected the request (HTTP ${status}). Check the value and try again.`,
    );
  }
  return new Error(
    `${context} failed: INKEEDecoder did not return a usable response. Retry shortly.`,
  );
}

/** Runs one product-name search and maps the products tab. */
async function productNameGroup(
  client: InkeedecoderClient,
  query: string,
  page: number,
  retrievedAt: string,
  signal?: AbortSignal,
): Promise<ProductGroup> {
  try {
    const result = await client.search(query, { page, signal });
    return productGroupOf(result.products, page, retrievedAt);
  } catch (error) {
    throw ikdFailure("The INKEEDecoder product search", error);
  }
}

/** Runs one advanced include-ingredient search. */
async function productIngredientGroup(
  client: InkeedecoderClient,
  query: string,
  page: number,
  retrievedAt: string,
  signal?: AbortSignal,
): Promise<ProductGroup> {
  try {
    const result = await client.searchProducts(
      { query: "", include: [query], includeMode: "all" },
      { page, signal },
    );
    return productGroupOf(result, page, retrievedAt);
  } catch (error) {
    throw ikdFailure("The INKEEDecoder product search", error);
  }
}

/** Maps one product search page to a group. */
function productGroupOf(
  result: Paginated<ClientRef>,
  page: number,
  retrievedAt: string,
): ProductGroup {
  return {
    source: "INKEEDecoder",
    items: result.items.map((ref) => productRefOf(ref, retrievedAt)),
    page,
    hasMore: result.hasMore,
  };
}

/** Runs one ingredient-tab search and maps its hits. */
async function ingredientGroup(
  client: InkeedecoderClient,
  query: string,
  page: number,
  retrievedAt: string,
  matchBasis: string,
  signal?: AbortSignal,
): Promise<IngredientGroup> {
  try {
    const result = await client.search(query, {
      tab: "ingredients",
      page,
      signal,
    });
    return {
      source: "INKEEDecoder",
      items: result.results.items.map((ref) =>
        ingredientRefOf(ref, retrievedAt, matchBasis),
      ),
      page,
      hasMore: result.results.hasMore,
    };
  } catch (error) {
    throw ikdFailure("The INKEEDecoder ingredient search", error);
  }
}

/** The adapter's INKEEDecoder-specific surface, narrowed for callers. */
export interface InkeedecoderAdapter extends SourceAdapter {
  searchProducts: NonNullable<SourceAdapter["searchProducts"]>;
  searchIngredients: NonNullable<SourceAdapter["searchIngredients"]>;
  getProduct(
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<IkdProductRecord>;
  getIngredient(
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<IkdIngredientRecord>;
}

/**
 * Builds the INKEEDecoder adapter.
 *
 * @param client Optional client override. Tests inject one backed by
 *   fixtures; production falls back to the process-wide shared client, which
 *   rates INKEEDecoder requests at one per second.
 */
export function createInkeedecoderAdapter(
  client?: InkeedecoderClient,
): InkeedecoderAdapter {
  const clients = () => client ?? getClients().inkeedecoder;

  const productSearchTypes: ProductSearchType[] = ["name", "ingredient"];
  const ingredientSearchTypes: IngredientSearchType[] = ["name", "inci"];

  return {
    id: "inkeedecoder",
    databases: ["INKEEDecoder"],
    productSearchTypes,
    ingredientSearchTypes,
    productCategories: ["cosmetic"],

    async searchProducts(
      type: ProductSearchType,
      query: string,
      page: number,
      signal?: AbortSignal,
    ): Promise<ProductGroup[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [emptyProductGroup(page)];

      // Resolve the client before the failure boundary: configuration errors
      // are actionable as-is and must not be reworded as a site outage.
      const ikd = clients();
      const retrievedAt = new Date().toISOString();

      switch (type) {
        case "name":
          return [
            await productNameGroup(ikd, trimmed, page, retrievedAt, signal),
          ];
        case "ingredient":
          return [
            await productIngredientGroup(
              ikd,
              trimmed,
              page,
              retrievedAt,
              signal,
            ),
          ];
        default:
          return [emptyProductGroup(page)];
      }
    },

    async searchIngredients(
      type: IngredientSearchType,
      query: string,
      page: number,
      signal?: AbortSignal,
    ): Promise<IngredientGroup[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [emptyIngredientGroup(page)];

      const ikd = clients();
      const retrievedAt = new Date().toISOString();

      switch (type) {
        case "name":
          return [
            await ingredientGroup(
              ikd,
              trimmed,
              page,
              retrievedAt,
              "name match",
              signal,
            ),
          ];
        case "inci":
          return [
            await ingredientGroup(
              ikd,
              trimmed,
              page,
              retrievedAt,
              "INCI name match",
              signal,
            ),
          ];
        default:
          return [emptyIngredientGroup(page)];
      }
    },

    async getProduct(
      id: string,
      _opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<IkdProductRecord> {
      const slug = normalizeSlug(id);
      const ikd = clients();
      const retrievedAt = new Date().toISOString();

      try {
        const product = await ikd.getProduct(slug, {
          brand: true,
          description: true,
          ingredients: true,
          images: "none",
          hashtags: true,
          fullName: true,
          dates: true,
          signal,
        });
        return productRecordOf(product, slug, retrievedAt);
      } catch (error) {
        throw ikdFailure("The INKEEDecoder product lookup", error);
      }
    },

    async getIngredient(
      id: string,
      _opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<IkdIngredientRecord> {
      const slug = normalizeSlug(id);
      const ikd = clients();
      const retrievedAt = new Date().toISOString();

      try {
        const ingredient = await ikd.getIngredient(slug, {
          functions: true,
          safety: true,
          alsoCalled: true,
          image: true,
          cosing: true,
          details: true,
          proof: true,
          signal,
        });
        return ingredientRecordOf(ingredient, slug, retrievedAt);
      } catch (error) {
        throw ikdFailure("The INKEEDecoder ingredient lookup", error);
      }
    },
  };
}

/** Options accepted by {@link IkdBridges.getIngredientBySlug}. */
export interface IkdBridgeOptions {
  /** Include the CosIng panel. Defaults to `true`. */
  cosing?: boolean;
  signal?: AbortSignal;
}

/** The identifier bridges the identity chain consumes. */
export interface IkdBridges {
  /** One ingredient page, including its CosIng CAS/EC/IUPAC panel. */
  getIngredientBySlug(
    slug: string,
    opts?: IkdBridgeOptions,
  ): Promise<ClientIngredient>;
}

/**
 * Builds the chain-facing INKEEDecoder bridges.
 *
 * The bridge always resolves the caller's value as a slug (bare slug, site
 * path, or inkeedecoder.com link), so a stale incidecoder.com link cannot
 * reach another host. Upstream failures are reworded to name only
 * INKEEDecoder.
 *
 * @param client Optional client override, mirroring
 *   {@link createInkeedecoderAdapter}.
 */
export function createInkeedecoderBridges(
  client?: InkeedecoderClient,
): IkdBridges {
  const clients = () => client ?? getClients().inkeedecoder;

  return {
    async getIngredientBySlug(slug, opts) {
      const normalized = normalizeSlug(slug);
      const ikd = clients();
      try {
        return await ikd.getIngredient(normalized, {
          cosing: opts?.cosing ?? true,
          signal: opts?.signal,
        });
      } catch (error) {
        throw ikdFailure("The INKEEDecoder ingredient lookup", error);
      }
    },
  };
}

/** The process-wide adapter, backed by the shared INKEEDecoder client. */
export const inkeedecoderAdapter: InkeedecoderAdapter =
  createInkeedecoderAdapter();

/** The process-wide chain bridge, backed by the shared client. */
export const ikdBridges: IkdBridges = createInkeedecoderBridges();
