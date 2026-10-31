import type {
  DatabaseId,
  IngredientProfile,
  IngredientRef,
  ProductCategory,
  ProductRef,
  RegulatoryNotice,
} from "../lib/schemas.js";

/**
 * The source-adapter contract.
 *
 * An adapter wraps one upstream *source module* (openFDA, CosIng, NLM, …) and
 * speaks only in the unified result vocabulary from `lib/schemas.ts`: it never
 * exposes client-library types or names. The registry fans searches out over
 * adapters by declared capability and routes lookups back by database.
 *
 * Two vocabularies meet here:
 *
 * - **Adapter ids** (`"openfda"`, `"nlm"`, …) are internal and match
 *   `DRUGDATA_DISABLED_SOURCES`. They are never returned in tool output.
 * - **Database ids** (`"openFDA"`, `"RxNorm"`, `"DailyMed"`, …) are the
 *   agent-visible source labels. One adapter may emit several databases: the
 *   NLM adapter serves both RxNorm and DailyMed.
 */

/** Search styles accepted by `drugdata_search_products`. */
export const PRODUCT_SEARCH_TYPES = [
  "name",
  "brand",
  "ingredient",
  "barcode",
  "ndc",
] as const;

/** Search styles accepted by `drugdata_search_products`. */
export type ProductSearchType = (typeof PRODUCT_SEARCH_TYPES)[number];

/** Search styles accepted by `drugdata_search_ingredients`. */
export const INGREDIENT_SEARCH_TYPES = [
  "name",
  "inci",
  "unii",
  "cas",
  "ec",
  "rxcui",
  "cid",
] as const;

/** Search styles accepted by `drugdata_search_ingredients`. */
export type IngredientSearchType = (typeof INGREDIENT_SEARCH_TYPES)[number];

export type {
  DatabaseId,
  IngredientRef,
  ProductCategory,
  ProductRef,
} from "../lib/schemas.js";

/**
 * Which adapter ids serve each product category.
 *
 * Category filtering is deliberately a registry concern, not an adapter
 * concern: the map names the sources a category is *about*, and an adapter
 * must also declare the category and the search type before it is called.
 * CosIng is absent because it serves ingredients only.
 */
export const CATEGORY_ADAPTERS: Readonly<
  Record<ProductCategory, readonly string[]>
> = {
  medication: ["openfda", "nlm", "drugcentral"],
  supplement: ["dsld"],
  cosmetic: ["inkeedecoder"],
};

/** Products found in one upstream database, with that group's pagination. */
export interface ProductGroup {
  source: DatabaseId;
  items: ProductRef[];
  page: number;
  hasMore: boolean;
  error?: string;
}

/** Ingredients found in one upstream database, with that group's pagination. */
export interface IngredientGroup {
  source: DatabaseId;
  items: IngredientRef[];
  page: number;
  hasMore: boolean;
  error?: string;
}

/** One ingredient lookup's unified record, before the tool renders it. */
export interface IngredientLookupRecord {
  ingredient: IngredientRef;
  profile: IngredientProfile;
  regulatory?: { notices: RegulatoryNotice[] };
}

/**
 * One adapter's declaration of what it can do and the methods behind it.
 *
 * `databases` lists every database the adapter can emit a group for. The
 * registry uses it to label error groups when the adapter rejects before it
 * can name a group itself (for example NLM failing produces separate RxNorm
 * and DailyMed error groups).
 *
 * Search and lookup methods are optional because adapters are asymmetric:
 * CosIng has no product records, and only some sources implement full lookups.
 */
export interface SourceAdapter {
  readonly ingredientDatabases?: DatabaseId[];
  /** Internal adapter id, matching `DRUGDATA_DISABLED_SOURCES`. */
  readonly id: string;
  /** Every database this adapter can report results under. */
  readonly databases: DatabaseId[];
  /** Product search types this adapter implements. */
  readonly productSearchTypes: ProductSearchType[];
  /** Ingredient search types this adapter implements. */
  readonly ingredientSearchTypes: IngredientSearchType[];
  /** Product categories this adapter serves. */
  readonly productCategories: ProductCategory[];

  /**
   * Searches products, returning one group per database it found records in.
   * An adapter that finds nothing returns an empty group, not an error.
   */
  searchProducts?(
    type: ProductSearchType,
    query: string,
    page: number,
    signal?: AbortSignal,
    onGroups?: GroupListener<ProductGroup>,
  ): Promise<ProductGroup[]>;

  /** Searches ingredients; same grouping and zero-match rules as products. */
  searchIngredients?(
    type: IngredientSearchType,
    query: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<IngredientGroup[]>;

  /** Fetches one product record by source-specific id. */
  getProduct?(
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;

  /** Fetches one ingredient record by source-specific id. */
  getIngredient?(
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Options shared by product searches. One page applies to every source. */
export interface ProductSearchOptions {
  category?: ProductCategory;
  page: number;
}

/** Options shared by ingredient searches. */
export interface IngredientSearchOptions {
  page: number;
}

/** The fan-out and lookup surface the tools consume. */
export interface Registry {
  searchSources?(
    kind: "product" | "ingredient",
    type: ProductSearchType | IngredientSearchType,
    category?: ProductCategory,
  ): DatabaseId[];
  /**
   * Searches every enabled adapter that declares `type` and, when a category
   * is given, serves that category. A failed adapter contributes error groups
   * instead of failing the whole search.
   */
  searchProducts(
    type: ProductSearchType,
    query: string,
    options: ProductSearchOptions,
    signal?: AbortSignal,
    onGroups?: GroupListener<ProductGroup>,
  ): Promise<ProductGroup[]>;

  /** Ingredient counterpart of {@link Registry.searchProducts}. */
  searchIngredients(
    type: IngredientSearchType,
    query: string,
    options: IngredientSearchOptions,
    signal?: AbortSignal,
    onGroups?: GroupListener<IngredientGroup>,
  ): Promise<IngredientGroup[]>;

  /**
   * Fetches a product from the database the caller names.
   *
   * @throws {SourceRoutingError} When the database is unknown, disabled, or
   *   its adapter does not implement product lookups.
   */
  getProduct(
    database: DatabaseId,
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;

  /** Ingredient counterpart of {@link Registry.getProduct}. */
  getIngredient(
    database: DatabaseId,
    id: string,
    opts: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export type GroupListener<G> = (groups: readonly G[]) => void;
