import { describe, expect, it, vi } from "vitest";
import { SourceRoutingError } from "../src/lib/errors.js";
import type {
  DatabaseId,
  IngredientRef,
  ProductRef,
} from "../src/lib/schemas.js";
import { createRegistry } from "../src/sources/registry.js";
import {
  CATEGORY_ADAPTERS,
  type IngredientGroup,
  type IngredientSearchType,
  type ProductGroup,
  type ProductSearchType,
  type SourceAdapter,
} from "../src/sources/types.js";

/**
 * The registry is the seam between tools and adapters: it decides which
 * adapters a search reaches, converts one adapter's failure into an isolated
 * error group, and routes lookups by the database the agent named.
 *
 * These tests use fake adapters so the contract is pinned independently of any
 * client package or upstream fixture.
 */

const RETRIEVED_AT = "2026-10-21T12:00:00.000Z";

function productRef(database: DatabaseId, name: string): ProductRef {
  return {
    name,
    identifiers: { ndc: ["00000000001"] },
    source: {
      database,
      id: name,
      url: `https://example.test/${database}/${name}`,
      retrievedAt: RETRIEVED_AT,
    },
  };
}

function ingredientRef(database: DatabaseId, name: string): IngredientRef {
  return {
    name,
    identifiers: { unii: "ABCDEFGHIJ" },
    source: {
      database,
      id: name,
      url: `https://example.test/${database}/${name}`,
      retrievedAt: RETRIEVED_AT,
    },
  };
}

function productGroup(
  source: DatabaseId,
  page = 1,
  items: ProductRef[] = [],
): ProductGroup {
  return { source, items, page, hasMore: false };
}

function ingredientGroup(
  source: DatabaseId,
  page = 1,
  items: IngredientRef[] = [],
): IngredientGroup {
  return { source, items, page, hasMore: false };
}

/** Builds an adapter with empty capabilities unless a test overrides them. */
function makeAdapter(
  overrides: Partial<SourceAdapter> & Pick<SourceAdapter, "id" | "databases">,
): SourceAdapter {
  return {
    productSearchTypes: [],
    ingredientSearchTypes: [],
    productCategories: [],
    ...overrides,
  };
}

/**
 * The two adapters the brief names.
 *
 * `fakeA` is a working medication adapter. `fakeB` answers `name` and `ndc`
 * but always rejects, and its adapter id is deliberately absent from the
 * category map so category-filter tests do not accidentally call it.
 */
function createFakes() {
  const groupA = productGroup("openFDA", 1, [productRef("openFDA", "aspirin")]);
  const ingredientA = ingredientGroup("openFDA", 1, [
    ingredientRef("openFDA", "aspirin"),
  ]);

  const searchProductsA = vi.fn(
    async (
      _type: ProductSearchType,
      _query: string,
      _page: number,
      _signal?: AbortSignal,
    ): Promise<ProductGroup[]> => [groupA],
  );
  const searchIngredientsA = vi.fn(
    async (
      _type: IngredientSearchType,
      _query: string,
      page: number,
      _signal?: AbortSignal,
    ): Promise<IngredientGroup[]> => [
      ingredientGroup("openFDA", page, ingredientA.items),
    ],
  );
  const fakeA = makeAdapter({
    id: "openfda",
    databases: ["openFDA"],
    productSearchTypes: ["name"],
    ingredientSearchTypes: ["name"],
    productCategories: ["medication"],
    searchProducts: searchProductsA,
    searchIngredients: searchIngredientsA,
  });

  const searchProductsB = vi.fn(
    async (
      _type: ProductSearchType,
      _query: string,
      _page: number,
      _signal?: AbortSignal,
    ): Promise<ProductGroup[]> => {
      throw new Error("boom");
    },
  );
  const fakeB = makeAdapter({
    id: "fakeB",
    databases: ["DSLD"],
    productSearchTypes: ["name", "ndc"],
    productCategories: ["medication"],
    searchProducts: searchProductsB,
  });

  return {
    fakeA,
    fakeB,
    groupA,
    ingredientA,
    searchProductsA,
    searchIngredientsA,
    searchProductsB,
  };
}

describe("CATEGORY_ADAPTERS", () => {
  it("maps each category to the adapter ids that serve it", () => {
    expect(CATEGORY_ADAPTERS).toEqual({
      medication: ["openfda", "nlm", "drugcentral"],
      supplement: ["dsld"],
      cosmetic: ["inkeedecoder"],
    });
  });
});

describe("registry.searchProducts", () => {
  it("fans out to every capable adapter and isolates a rejection per database", async () => {
    const { fakeA, fakeB, groupA, searchProductsA, searchProductsB } =
      createFakes();
    const registry = createRegistry([fakeA, fakeB], []);

    const groups = await registry.searchProducts("name", "aspirin", {
      page: 1,
    });

    expect(searchProductsA).toHaveBeenCalledWith(
      "name",
      "aspirin",
      1,
      undefined,
    );
    expect(searchProductsB).toHaveBeenCalledWith(
      "name",
      "aspirin",
      1,
      undefined,
    );
    expect(groups).toEqual([
      groupA,
      {
        source: "DSLD",
        items: [],
        page: 1,
        hasMore: false,
        error: "boom",
      },
    ]);
  });

  it("forwards the page number and caller's abort signal", async () => {
    const { fakeA, searchProductsA } = createFakes();
    const controller = new AbortController();
    const registry = createRegistry([fakeA], []);

    await registry.searchProducts(
      "name",
      "aspirin",
      { page: 3 },
      controller.signal,
    );

    expect(searchProductsA).toHaveBeenCalledWith(
      "name",
      "aspirin",
      3,
      controller.signal,
    );
  });

  it("emits one error group per database an adapter declares", async () => {
    const nlm = makeAdapter({
      id: "nlm",
      databases: ["RxNorm", "DailyMed"],
      productSearchTypes: ["name"],
      productCategories: ["medication"],
      searchProducts: vi.fn(async () => {
        throw new Error("upstream down");
      }),
    });

    const groups = await createRegistry([nlm], []).searchProducts(
      "name",
      "aspirin",
      { page: 2 },
    );

    expect(groups).toEqual([
      {
        source: "RxNorm",
        items: [],
        page: 2,
        hasMore: false,
        error: "upstream down",
      },
      {
        source: "DailyMed",
        items: [],
        page: 2,
        hasMore: false,
        error: "upstream down",
      },
    ]);
  });

  it("reports a non-Error rejection as text", async () => {
    const adapter = makeAdapter({
      id: "fakeB",
      databases: ["DSLD"],
      productSearchTypes: ["name"],
      searchProducts: vi.fn(async () => {
        throw "offline";
      }),
    });

    const groups = await createRegistry([adapter], []).searchProducts(
      "name",
      "aspirin",
      { page: 1 },
    );

    expect(groups).toEqual([
      {
        source: "DSLD",
        items: [],
        page: 1,
        hasMore: false,
        error: "offline",
      },
    ]);
  });

  it("calls only adapters that declare the requested type", async () => {
    const { fakeA, fakeB, searchProductsA, searchProductsB } = createFakes();

    const groups = await createRegistry([fakeA, fakeB], []).searchProducts(
      "ndc",
      "00000000001",
      { page: 1 },
    );

    expect(searchProductsA).not.toHaveBeenCalled();
    expect(searchProductsB).toHaveBeenCalledTimes(1);
    expect(groups.map((group) => group.source)).toEqual(["DSLD"]);
  });

  it("returns no groups when no adapter declares the type", async () => {
    const { fakeA, fakeB, searchProductsA, searchProductsB } = createFakes();

    const groups = await createRegistry([fakeA, fakeB], []).searchProducts(
      "barcode",
      "012345678901",
      { page: 1 },
    );

    expect(groups).toEqual([]);
    expect(searchProductsA).not.toHaveBeenCalled();
    expect(searchProductsB).not.toHaveBeenCalled();
  });

  it("skips an adapter that declares a type without implementing search", async () => {
    const adapter = makeAdapter({
      id: "cosing",
      databases: ["CosIng"],
      productSearchTypes: ["name"],
    });

    const groups = await createRegistry([adapter], []).searchProducts(
      "name",
      "aspirin",
      { page: 1 },
    );

    expect(groups).toEqual([]);
  });

  it("restricts a category search to the adapters the category maps to", async () => {
    const { fakeA, fakeB, searchProductsA, searchProductsB } = createFakes();

    const groups = await createRegistry([fakeA, fakeB], []).searchProducts(
      "name",
      "aspirin",
      { category: "medication", page: 1 },
    );

    expect(searchProductsA).toHaveBeenCalledTimes(1);
    expect(searchProductsB).not.toHaveBeenCalled();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.source).toBe("openFDA");
  });

  it("returns nothing when no capable adapter serves the category", async () => {
    const { fakeA, fakeB, searchProductsA, searchProductsB } = createFakes();

    const groups = await createRegistry([fakeA, fakeB], []).searchProducts(
      "name",
      "aspirin",
      { category: "supplement", page: 1 },
    );

    expect(groups).toEqual([]);
    expect(searchProductsA).not.toHaveBeenCalled();
    expect(searchProductsB).not.toHaveBeenCalled();
  });

  it("requires the adapter to declare the category, not just appear in the map", async () => {
    const adapter = makeAdapter({
      id: "nlm",
      databases: ["RxNorm"],
      productSearchTypes: ["name"],
      productCategories: [],
    });

    const groups = await createRegistry([adapter], []).searchProducts(
      "name",
      "aspirin",
      { category: "medication", page: 1 },
    );

    expect(groups).toEqual([]);
  });

  it("skips disabled adapters", async () => {
    const { fakeA, fakeB, groupA, searchProductsA, searchProductsB } =
      createFakes();

    const groups = await createRegistry(
      [fakeA, fakeB],
      ["fakeB"],
    ).searchProducts("name", "aspirin", { page: 1 });

    expect(groups).toEqual([groupA]);
    expect(searchProductsA).toHaveBeenCalledTimes(1);
    expect(searchProductsB).not.toHaveBeenCalled();
  });

  it("keeps a zero-match group free of error text", async () => {
    const adapter = makeAdapter({
      id: "dsld",
      databases: ["DSLD"],
      productSearchTypes: ["name"],
      productCategories: ["supplement"],
      searchProducts: vi.fn(
        async (
          _type: ProductSearchType,
          _query: string,
          page: number,
        ): Promise<ProductGroup[]> => [productGroup("DSLD", page)],
      ),
    });

    const groups = await createRegistry([adapter], []).searchProducts(
      "name",
      "no such product",
      { page: 2 },
    );

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 2, hasMore: false },
    ]);
    expect(groups[0]).not.toHaveProperty("error");
  });
});

describe("registry.searchIngredients", () => {
  it("fans out to ingredient-capable adapters", async () => {
    const { fakeA, fakeB, ingredientA, searchIngredientsA } = createFakes();

    const groups = await createRegistry([fakeA, fakeB], []).searchIngredients(
      "name",
      "aspirin",
      { page: 1 },
    );

    expect(searchIngredientsA).toHaveBeenCalledWith(
      "name",
      "aspirin",
      1,
      undefined,
    );
    expect(groups).toEqual([ingredientGroup("openFDA", 1, ingredientA.items)]);
  });

  it("labels an ingredient rejection with the adapter's databases", async () => {
    const cosing = makeAdapter({
      id: "cosing",
      databases: ["CosIng"],
      ingredientSearchTypes: ["name", "unii"],
      searchIngredients: vi.fn(async () => {
        throw new Error("cosing down");
      }),
    });
    const { fakeA, searchIngredientsA } = createFakes();

    const groups = await createRegistry([fakeA, cosing], []).searchIngredients(
      "unii",
      "ABCDEFGHIJ",
      { page: 2 },
    );

    expect(searchIngredientsA).not.toHaveBeenCalled();
    expect(groups).toEqual([
      {
        source: "CosIng",
        items: [],
        page: 2,
        hasMore: false,
        error: "cosing down",
      },
    ]);
  });

  it("skips an adapter that declares a type without implementing search", async () => {
    const adapter = makeAdapter({
      id: "cosing",
      databases: ["CosIng"],
      ingredientSearchTypes: ["name"],
    });

    const groups = await createRegistry([adapter], []).searchIngredients(
      "name",
      "niacinamide",
      { page: 1 },
    );

    expect(groups).toEqual([]);
  });

  it("returns no groups when no adapter declares the type", async () => {
    const { fakeA, searchIngredientsA } = createFakes();

    const groups = await createRegistry([fakeA], []).searchIngredients(
      "rxcui",
      "1191",
      { page: 1 },
    );

    expect(groups).toEqual([]);
    expect(searchIngredientsA).not.toHaveBeenCalled();
  });

  it("skips disabled adapters", async () => {
    const { fakeA, searchIngredientsA } = createFakes();

    const groups = await createRegistry([fakeA], ["openfda"]).searchIngredients(
      "name",
      "aspirin",
      { page: 1 },
    );

    expect(groups).toEqual([]);
    expect(searchIngredientsA).not.toHaveBeenCalled();
  });
});

describe("registry lookups", () => {
  function lookupAdapter() {
    const getProduct = vi.fn(
      async (id: string, opts: Record<string, unknown>) => ({ id, opts }),
    );
    const getIngredient = vi.fn(
      async (id: string, opts: Record<string, unknown>) => ({ id, opts }),
    );
    const adapter = makeAdapter({
      id: "nlm",
      databases: ["RxNorm", "DailyMed"],
      getProduct,
      getIngredient,
    });
    return { adapter, getProduct, getIngredient };
  }

  it("routes a product lookup to the adapter owning the database", async () => {
    const { adapter, getProduct } = lookupAdapter();
    const controller = new AbortController();

    const result = await createRegistry([adapter], []).getProduct(
      "DailyMed",
      "setid-1",
      { include_label_sections: true },
      controller.signal,
    );

    expect(getProduct).toHaveBeenCalledWith(
      "setid-1",
      { include_label_sections: true },
      controller.signal,
    );
    expect(result).toEqual({
      id: "setid-1",
      opts: { include_label_sections: true },
    });
  });

  it("routes an ingredient lookup to the adapter owning the database", async () => {
    const { adapter, getIngredient } = lookupAdapter();

    const result = await createRegistry([adapter], []).getIngredient(
      "RxNorm",
      "1191",
      { include_clinical: true },
    );

    expect(getIngredient).toHaveBeenCalledWith(
      "1191",
      { include_clinical: true },
      undefined,
    );
    expect(result).toEqual({ id: "1191", opts: { include_clinical: true } });
  });

  it("throws SourceRoutingError for a source no adapter serves", async () => {
    const { adapter } = lookupAdapter();
    const registry = createRegistry([adapter], []);

    const error = await registry
      .getProduct("CosIng", "x", {})
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SourceRoutingError);
    expect(error).toMatchObject({ name: "SourceRoutingError" });
    expect((error as Error).message).toContain('Unknown source "CosIng"');
    expect((error as Error).message).toContain("RxNorm");
  });

  it("throws SourceRoutingError when the source has no product lookup", async () => {
    const { fakeA, fakeB } = createFakes();
    const registry = createRegistry([fakeA, fakeB], []);

    await expect(registry.getProduct("openFDA", "x", {})).rejects.toThrow(
      /does not provide product lookups/,
    );
  });

  it("throws SourceRoutingError when the source has no ingredient lookup", async () => {
    const { fakeA, fakeB } = createFakes();
    const registry = createRegistry([fakeA, fakeB], []);

    await expect(registry.getIngredient("DSLD", "x", {})).rejects.toThrow(
      /does not provide ingredient lookups/,
    );
  });

  it("names the enabled sources that support the missing lookup kind", async () => {
    const { fakeA } = createFakes();
    const { adapter } = lookupAdapter();
    const registry = createRegistry([fakeA, adapter], []);

    await expect(registry.getProduct("openFDA", "x", {})).rejects.toThrow(
      /Available sources: RxNorm, DailyMed/,
    );
  });

  it("reports when no enabled source provides the missing lookup kind", async () => {
    const { fakeA } = createFakes();
    const { adapter } = lookupAdapter();
    const registry = createRegistry([fakeA, adapter], ["nlm"]);

    await expect(registry.getProduct("openFDA", "x", {})).rejects.toThrow(
      /No registered source provides this lookup/,
    );
  });

  it("reports no known sources for an unknown source in an empty registry", async () => {
    const registry = createRegistry([], []);

    await expect(registry.getIngredient("RxNorm", "x", {})).rejects.toThrow(
      /No sources are registered/,
    );
  });

  it("throws SourceRoutingError when the owning adapter is disabled", async () => {
    const { adapter } = lookupAdapter();
    const registry = createRegistry([adapter], ["nlm"]);

    await expect(registry.getProduct("DailyMed", "x", {})).rejects.toThrow(
      /disabled/,
    );
  });
});
