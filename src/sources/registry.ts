import { throwIfAborted } from "../lib/abort.js";
import { SourceRoutingError } from "../lib/errors.js";
import type { DatabaseId } from "../lib/schemas.js";
import {
  CATEGORY_ADAPTERS,
  type IngredientGroup,
  type IngredientSearchOptions,
  type IngredientSearchType,
  type ProductCategory,
  type ProductGroup,
  type ProductSearchOptions,
  type ProductSearchType,
  type Registry,
  type SourceAdapter,
} from "./types.js";

export { SourceRoutingError };

/**
 * The adapter registry.
 *
 * Searches are a fan-out: every enabled adapter that declares the requested
 * search type (and category, when one is given) is called concurrently, and a
 * single adapter's failure is isolated into error groups for its databases so
 * the rest of the results still reach the agent. Lookups run the other way:
 * the caller names a database and the registry finds the one adapter that
 * owns it.
 *
 * Two invariants keep this predictable:
 *
 * - **Adapters own distinct databases.** The first adapter declaring a
 *   database routes lookups for it.
 * - **The registry never invents results.** It forwards adapters' groups
 *   untouched; only failures are synthesized, and zero matches stay ordinary
 *   empty groups.
 */

/** An adapter whose product search method is present. */
type ProductSearchAdapter = SourceAdapter & {
  searchProducts: NonNullable<SourceAdapter["searchProducts"]>;
};

/** An adapter whose ingredient search method is present. */
type IngredientSearchAdapter = SourceAdapter & {
  searchIngredients: NonNullable<SourceAdapter["searchIngredients"]>;
};

/** A group the registry can pass through from either search family. */
type AnyGroup = ProductGroup | IngredientGroup;

/**
 * Creates a registry over the supplied adapters.
 *
 * @param adapters All known adapters. Order determines result order.
 * @param disabled Internal adapter ids switched off for this process (from
 *   `DRUGDATA_DISABLED_SOURCES`). Disabled adapters are not searched and their
 *   databases are not routable.
 */
export function createRegistry(
  adapters: SourceAdapter[],
  disabled: string[],
): Registry {
  const disabledIds = new Set(disabled);

  /** Whether an adapter implements the requested product search. */
  function supportsProductSearch(
    adapter: SourceAdapter,
    type: ProductSearchType,
  ): adapter is ProductSearchAdapter {
    return (
      adapter.searchProducts !== undefined &&
      adapter.productSearchTypes.includes(type)
    );
  }

  /** Whether an adapter implements the requested ingredient search. */
  function supportsIngredientSearch(
    adapter: SourceAdapter,
    type: IngredientSearchType,
  ): adapter is IngredientSearchAdapter {
    return (
      adapter.searchIngredients !== undefined &&
      adapter.ingredientSearchTypes.includes(type)
    );
  }

  /**
   * Whether an adapter belongs in a category-filtered fan-out: it must both
   * declare the category and be one of the sources that category is about.
   */
  function servesCategory(
    adapter: SourceAdapter,
    category: ProductCategory,
  ): boolean {
    return (
      adapter.productCategories.includes(category) &&
      CATEGORY_ADAPTERS[category].includes(adapter.id)
    );
  }

  /** Finds the adapter that can answer a lookup for `database`. */
  function lookupOwner(database: DatabaseId): SourceAdapter {
    const owner = adapters.find((adapter) =>
      adapter.databases.includes(database),
    );
    if (owner === undefined) {
      throw new SourceRoutingError(
        `Unknown source "${database}". ${knownSourcesNote()}`,
      );
    }
    if (disabledIds.has(owner.id)) {
      throw new SourceRoutingError(
        `Source "${database}" is disabled for this process. Its adapter id is listed in DRUGDATA_DISABLED_SOURCES; remove it there to use this source.`,
      );
    }
    return owner;
  }

  /** Lists the registered database labels for an unknown-source message. */
  function knownSourcesNote(): string {
    const sources = uniqueDatabases(adapters);
    return sources.length > 0
      ? `Known sources: ${sources.join(", ")}.`
      : "No sources are registered.";
  }

  /** Lists enabled databases that implement a lookup kind, for an error hint. */
  function lookupSourcesNote(kind: "getProduct" | "getIngredient"): string {
    const enabled = adapters.filter(
      (adapter) => !disabledIds.has(adapter.id) && adapter[kind] !== undefined,
    );
    const sources = uniqueDatabases(enabled);
    return sources.length > 0
      ? ` Available sources: ${sources.join(", ")}.`
      : " No registered source provides this lookup.";
  }

  return {
    async searchProducts(
      type: ProductSearchType,
      query: string,
      options: ProductSearchOptions,
      signal?: AbortSignal,
    ): Promise<ProductGroup[]> {
      const { category, page } = options;
      const capable = adapters.filter(
        (adapter): adapter is ProductSearchAdapter =>
          !disabledIds.has(adapter.id) && supportsProductSearch(adapter, type),
      );
      const selected =
        category === undefined
          ? capable
          : capable.filter((adapter) => servesCategory(adapter, category));

      return fanOut(
        selected,
        (adapter) => adapter.searchProducts(type, query, page, signal),
        page,
        signal,
      );
    },

    async searchIngredients(
      type: IngredientSearchType,
      query: string,
      options: IngredientSearchOptions,
      signal?: AbortSignal,
    ): Promise<IngredientGroup[]> {
      const capable = adapters.filter(
        (adapter): adapter is IngredientSearchAdapter =>
          !disabledIds.has(adapter.id) &&
          supportsIngredientSearch(adapter, type),
      );

      return fanOut(
        capable,
        (adapter) =>
          adapter.searchIngredients(type, query, options.page, signal),
        options.page,
        signal,
      );
    },

    async getProduct(
      database: DatabaseId,
      id: string,
      opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> {
      const owner = lookupOwner(database);
      if (owner.getProduct === undefined) {
        throw new SourceRoutingError(
          `Source "${database}" does not provide product lookups.${lookupSourcesNote("getProduct")}`,
        );
      }
      throwIfAborted(signal);
      return owner.getProduct(id, opts, signal);
    },

    async getIngredient(
      database: DatabaseId,
      id: string,
      opts: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> {
      const owner = lookupOwner(database);
      if (owner.getIngredient === undefined) {
        throw new SourceRoutingError(
          `Source "${database}" does not provide ingredient lookups.${lookupSourcesNote("getIngredient")}`,
        );
      }
      throwIfAborted(signal);
      return owner.getIngredient(id, opts, signal);
    },
  };
}

/**
 * Runs one search across the selected adapters concurrently.
 *
 * Rejected adapters become one error group per database they declared: the
 * adapter cannot say which group failed, and its declared databases are the
 * groups it could have emitted. An empty result from a fulfilled adapter is
 * forwarded as-is, so a zero-match search never reads as a failure.
 */
async function fanOut<TAdapter extends SourceAdapter, TGroup extends AnyGroup>(
  adapters: readonly TAdapter[],
  request: (adapter: TAdapter) => Promise<TGroup[]>,
  page: number,
  signal: AbortSignal | undefined,
): Promise<TGroup[]> {
  throwIfAborted(signal);
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => request(adapter)),
  );
  // A cancelled request is not an upstream failure: surface it as a
  // cancellation rather than synthesizing error groups.
  throwIfAborted(signal);

  const groups: TGroup[] = [];
  settled.forEach((outcome, index) => {
    // allSettled preserves input order, so the index identifies the adapter.
    const adapter = adapters[index] as TAdapter;
    if (outcome.status === "fulfilled") {
      groups.push(...outcome.value);
      return;
    }

    const error = describeError(outcome.reason);
    for (const source of adapter.databases) {
      // A failure group is valid for either search family: its item list is
      // empty, so only the shared group fields are present.
      const group: AnyGroup = {
        source,
        items: [],
        page,
        hasMore: false,
        error,
      };
      groups.push(group as TGroup);
    }
  });
  return groups;
}

/** Turns a rejection reason into model-facing error text. */
function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Collects the distinct database labels the given adapters declare. */
function uniqueDatabases(adapters: readonly SourceAdapter[]): DatabaseId[] {
  return [...new Set(adapters.flatMap((adapter) => adapter.databases))];
}
