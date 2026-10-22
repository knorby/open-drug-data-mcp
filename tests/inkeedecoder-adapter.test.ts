import { readFileSync } from "node:fs";
import {
  createInkeedecoderClient,
  type InkeedecoderClient,
} from "@knorby/inkeedecoder-client";
import { describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import { ingredientRefSchema, productRefSchema } from "../src/lib/schemas.js";
import {
  createInkeedecoderAdapter,
  createInkeedecoderBridges,
  ikdBridges,
  inkeedecoderAdapter,
} from "../src/sources/inkeedecoder.js";

/**
 * The INKEEDecoder adapter is tested through the client's injectable `fetch`.
 *
 * Every fixture under `tests/fixtures/inkeedecoder/` is a raw HTML page
 * captured live from inkeedecoder.com on 2026-10-22: the combined search page
 * for "niacinamide" (both tabs), the advanced ingredient-include search, the
 * niacinamide ingredient page including its CosIng panel, and one product page.
 * Inline pages cover optional sections the live pages do not carry.
 *
 * These tests pin the adapter's mapping only. They also prove the search path
 * never fetches an item page: each search call issues only its search request.
 */

const FIXTURES = new URL("./fixtures/inkeedecoder/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Builds a client whose fetch routes every request through `handler`. */
function clientFor(handler: Handler) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new URL(String(input)), init ?? {}),
  );
  const client = createInkeedecoderClient({
    fetch: fetchMock as unknown as typeof fetch,
    requestIntervalMs: 0,
    timeoutMs: 5_000,
  });
  return { client, fetchMock };
}

/** Answers every request with one HTML fixture. */
function routeTo(body: string): Handler {
  return () => new Response(body, { status: 200 });
}

/** Every request the client's fetch stub saw, with its parsed URL. */
function requests(fetchMock: {
  mock: { calls: [RequestInfo | URL, RequestInit?][] };
}): { url: URL; init: RequestInit }[] {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: new URL(String(input)),
    init: init ?? {},
  }));
}

/** Reads one request, failing the test when the client made too few. */
function requestAt(
  fetchMock: Parameters<typeof requests>[0],
  index = 0,
): { url: URL; init: RequestInit } {
  const request = requests(fetchMock)[index];
  if (request === undefined) {
    throw new Error(`expected a request at index ${index}`);
  }
  return request;
}

/** A minimal product page: only the title and slug sources are present. */
const MINIMAL_PRODUCT = `<!doctype html><html><body>
  <div id="compare-controls">
    <button data-postlinkurl="/products/minimal-product"></button>
  </div>
  <h1 id="product-title">Minimal Product</h1>
</body></html>`;

/** A minimal product page whose title is blank, forcing the slug fallback. */
const UNNAMED_PRODUCT = `<!doctype html><html><body>
  <div id="compare-controls">
    <button data-postlinkurl="/products/blank-product"></button>
  </div>
  <h1 id="product-title">   </h1>
</body></html>`;

/** A product page with upload and update dates. */
const DATED_PRODUCT = `<!doctype html><html><body>
  <div id="compare-controls">
    <button data-postlinkurl="/products/dated-product"></button>
  </div>
  <h1 id="product-title">Dated Product</h1>
  <div class="prodinfobox">
    <div>Uploaded by: Test User on 1 January</div>
    <time datetime="2020-01-01"></time>
    <time datetime="2021-06-15"></time>
  </div>
</body></html>`;

/** An ingredient page with safety fields and a multi-value CosIng panel. */
const EDGE_INGREDIENT = `<!doctype html><html><body>
  <h1>Edge Ingredient</h1>
  <div class="ingredinfobox">
    <div class="itemprop">
      <span class="label">Irritancy</span><span class="value">low</span>
    </div>
    <div class="itemprop">
      <span class="label">Comedogenicity</span>
      <span class="value">medium</span>
    </div>
  </div>
  <div id="cosing-data"><div class="hidden">
    <b>All Functions:</b> smoothing |
    <b>CAS #:</b> 98-92-0, 98-92-0 ; 100-00-0 |
    <b>EC #:</b> ; |
    <b>Chemical/IUPAC Name:</b> Edgeamide
  </div></div>
</body></html>`;

/** An ingredient page with no optional sections at all. */
const MINIMAL_INGREDIENT =
  "<!doctype html><html><body><h1>Bare Ingredient</h1></body></html>";

describe("INKEEDecoder adapter capabilities", () => {
  it("declares cosmetic products and ingredients with the briefed search types", () => {
    expect(inkeedecoderAdapter.id).toBe("inkeedecoder");
    expect(inkeedecoderAdapter.databases).toEqual(["INKEEDecoder"]);
    expect(inkeedecoderAdapter.productSearchTypes).toEqual([
      "name",
      "ingredient",
    ]);
    expect(inkeedecoderAdapter.ingredientSearchTypes).toEqual(["name", "inci"]);
    expect(inkeedecoderAdapter.productCategories).toEqual(["cosmetic"]);
    expect(inkeedecoderAdapter.searchProducts).toBeTypeOf("function");
    expect(inkeedecoderAdapter.searchIngredients).toBeTypeOf("function");
    expect(inkeedecoderAdapter.getProduct).toBeTypeOf("function");
    expect(inkeedecoderAdapter.getIngredient).toBeTypeOf("function");
  });

  it("defaults to the shared INKEEDecoder client", async () => {
    const fetchMock = vi.fn(
      async () => new Response(fixture("search-niacinamide.html")),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      const groups = await inkeedecoderAdapter.searchProducts?.(
        "name",
        "niacinamide",
        1,
      );
      expect(groups?.[0]?.items[0]?.identifiers.slug).toBe(
        "wellwell-niacinamide",
      );
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});

describe("INKEEDecoder product name search", () => {
  it("maps product hits with slug, deep link, category, and source", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const groups = await adapter.searchProducts("name", "niacinamide", 1);

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.source).toBe("INKEEDecoder");
    expect(group?.page).toBe(1);
    expect(group?.hasMore).toBe(true);
    expect(group?.error).toBeUndefined();
    expect(group?.items).toHaveLength(50);

    const first = group?.items[0];
    expect(first?.name).toBe("Wellwell Niacinamide");
    expect(first?.brand).toBeUndefined();
    expect(first?.category).toBe("cosmetic");
    expect(first?.identifiers).toEqual({ slug: "wellwell-niacinamide" });
    expect(first?.source.database).toBe("INKEEDecoder");
    expect(first?.source.id).toBe("wellwell-niacinamide");
    expect(first?.source.url).toBe(
      "https://inkeedecoder.com/products/wellwell-niacinamide",
    );
    expect(first?.source.retrievedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(productRefSchema.parse(first)).toBeDefined();

    // One search request only: no product page is fetched per hit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url } = requestAt(fetchMock);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("query")).toBe("niacinamide");
    expect(url.searchParams.get("activetab")).toBeNull();
    expect(url.searchParams.get("ppage")).toBeNull();
  });

  it("pages the combined search and reports the requested page", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const [group] = await adapter.searchProducts("name", "niacinamide", 2);

    expect(group?.page).toBe(2);
    expect(group?.hasMore).toBe(true);
    // The combined search fetches each tab separately on later pages.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tabs = requests(fetchMock).map(({ url }) => ({
      tab: url.searchParams.get("activetab"),
      page: url.searchParams.get("ppage"),
    }));
    expect(tabs).toEqual([
      { tab: "products", page: "2" },
      { tab: "ingredients", page: "2" },
    ]);
  });

  it("turns a zero-match search into an empty group", async () => {
    const { client } = clientFor(routeTo(fixture("search-zero.html")));
    const adapter = createInkeedecoderAdapter(client);

    expect(await adapter.searchProducts("name", "zzz", 1)).toEqual([
      { source: "INKEEDecoder", items: [], page: 1, hasMore: false },
    ]);
  });

  it("returns an empty group for a blank query without a request", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-zero.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    expect(await adapter.searchProducts("name", "   ", 1)).toEqual([
      { source: "INKEEDecoder", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["brand", "barcode", "ndc"] as const)(
    "returns an empty group for an undeclared %s search without a request",
    async (type) => {
      const { client, fetchMock } = clientFor(() => {
        throw new Error("no request expected");
      });
      const adapter = createInkeedecoderAdapter(client);

      expect(await adapter.searchProducts(type, "query", 1)).toEqual([
        { source: "INKEEDecoder", items: [], page: 1, hasMore: false },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("INKEEDecoder product ingredient search", () => {
  it("uses the advanced include filter and maps product hits", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-products-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const [group] = await adapter.searchProducts(
      "ingredient",
      "Niacinamide",
      1,
    );

    expect(group?.source).toBe("INKEEDecoder");
    expect(group?.items).toHaveLength(50);
    expect(group?.hasMore).toBe(true);
    expect(group?.items[0]?.identifiers.slug).toBe(
      "brixy-balance-shampoo-bar-mint-eucalyptus",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url } = requestAt(fetchMock);
    expect(url.pathname).toBe("/search/product");
    expect(url.searchParams.get("include")).toBe("Niacinamide");
    expect(url.searchParams.get("query")).toBeNull();
    expect(url.searchParams.get("ppage")).toBeNull();
  });

  it("forwards the page to the advanced search", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-products-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const [group] = await adapter.searchProducts(
      "ingredient",
      "Niacinamide",
      3,
    );

    expect(group?.page).toBe(3);
    expect(requestAt(fetchMock).url.searchParams.get("ppage")).toBe("3");
  });

  it("turns a zero-match ingredient filter into an empty group", async () => {
    const { client } = clientFor(routeTo(fixture("search-products-zero.html")));
    const adapter = createInkeedecoderAdapter(client);

    expect(await adapter.searchProducts("ingredient", "nothing", 1)).toEqual([
      { source: "INKEEDecoder", items: [], page: 1, hasMore: false },
    ]);
  });
});

describe("INKEEDecoder ingredient search", () => {
  it("maps ingredient hits with slug, INCI name, and a name-match basis", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const [group] = await adapter.searchIngredients("name", "niacinamide", 1);

    expect(group?.source).toBe("INKEEDecoder");
    expect(group?.items).toHaveLength(5);
    expect(group?.hasMore).toBe(false);
    expect(group?.items[0]).toEqual({
      name: "Niacinamide",
      inciName: "Niacinamide",
      identifiers: { slug: "niacinamide" },
      source: {
        database: "INKEEDecoder",
        id: "niacinamide",
        url: "https://inkeedecoder.com/ingredients/niacinamide",
        retrievedAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
      },
      matchBasis: "name match",
    });
    expect(ingredientRefSchema.parse(group?.items[0])).toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url } = requestAt(fetchMock);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("query")).toBe("niacinamide");
    expect(url.searchParams.get("activetab")).toBe("ingredients");
    expect(url.searchParams.get("ppage")).toBeNull();
  });

  it("labels an INCI search and pages the ingredient tab", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const [group] = await adapter.searchIngredients("inci", "niacinamide", 2);

    expect(group?.page).toBe(2);
    expect(group?.items[0]?.matchBasis).toBe("INCI name match");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url } = requestAt(fetchMock);
    expect(url.searchParams.get("activetab")).toBe("ingredients");
    expect(url.searchParams.get("ppage")).toBe("2");
  });

  it("returns an empty group for a zero-match search", async () => {
    const { client } = clientFor(routeTo(fixture("search-zero.html")));
    const adapter = createInkeedecoderAdapter(client);

    expect(await adapter.searchIngredients("name", "zzz", 1)).toEqual([
      { source: "INKEEDecoder", items: [], page: 1, hasMore: false },
    ]);
  });

  it("returns an empty group for a blank query without a request", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-zero.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    expect(await adapter.searchIngredients("inci", "", 1)).toEqual([
      { source: "INKEEDecoder", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["unii", "cas", "ec", "rxcui"] as const)(
    "returns an empty group for an undeclared %s search without a request",
    async (type) => {
      const { client, fetchMock } = clientFor(() => {
        throw new Error("no request expected");
      });
      const adapter = createInkeedecoderAdapter(client);

      expect(await adapter.searchIngredients(type, "123", 1)).toEqual([
        { source: "INKEEDecoder", items: [], page: 1, hasMore: false },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("INKEEDecoder product lookup", () => {
  it("maps a product page: brand, details, and ingredient rows", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("product-the-inkey-list-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const record = await adapter.getProduct(
      "https://inkeedecoder.com/products/the-inkey-list-niacinamide?utm=x#top",
      {},
    );

    expect(record.product).toMatchObject({
      name: "The Inkey List Niacinamide",
      brand: "The Inkey List",
      category: "cosmetic",
      identifiers: { slug: "the-inkey-list-niacinamide" },
      source: {
        database: "INKEEDecoder",
        id: "the-inkey-list-niacinamide",
        url: "https://inkeedecoder.com/products/the-inkey-list-niacinamide",
      },
    });
    expect(record.product.source.retrievedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(productRefSchema.parse(record.product)).toBeDefined();

    expect(record.details.hashtags).toEqual([
      "Alcohol Free",
      "Fragrance and Essential Oil Free",
      "Niacinamide: 10.0%",
    ]);
    expect(record.details.uploadedBy).toBe("fabienlrch");
    expect(record.details.uploadedAt).toBe("2019-07-06");
    expect(record.details.updatedAt).toBeUndefined();
    expect(record.details.description).toContain("Uniting 10% Niacinamide");

    expect(record.ingredients).toHaveLength(23);
    const first = record.ingredients[0];
    expect(first?.name).toBe("Water (Aqua/Eau)");
    expect(first?.identifiers).toEqual({ slug: "water" });
    expect(first?.source.url).toBe(
      "https://inkeedecoder.com/ingredients/water",
    );
    expect(ingredientRefSchema.parse(first)).toBeDefined();

    const niacinamide = record.ingredients.find(
      (item) => item.identifiers.slug === "niacinamide",
    );
    expect(niacinamide?.quantity).toBe("10.0%");
    expect(niacinamide?.summary).toBe("Our take: superstar");

    // One page fetch only: the ingredient rows come from the product page.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAt(fetchMock).url.pathname).toBe(
      "/products/the-inkey-list-niacinamide",
    );
  });

  it("omits absent optional sections and falls back to the slug for a name", async () => {
    const { client } = clientFor(
      (url) =>
        new Response(
          url.pathname === "/products/blank-product"
            ? UNNAMED_PRODUCT
            : MINIMAL_PRODUCT,
        ),
    );
    const adapter = createInkeedecoderAdapter(client);

    const record = await adapter.getProduct("minimal-product", {});

    expect(record.product.name).toBe("Minimal Product");
    expect(record.product.brand).toBeUndefined();
    expect(record.ingredients).toEqual([]);
    expect(record.details).toEqual({ hashtags: [] });
    expect(record.product.source.url).toBe(
      "https://inkeedecoder.com/products/minimal-product",
    );

    const unnamed = await adapter.getProduct("blank-product", {});
    expect(unnamed.product.name).toBe("blank-product");
  });

  it("surfaces upload and update dates from one page", async () => {
    const { client } = clientFor(routeTo(DATED_PRODUCT));
    const adapter = createInkeedecoderAdapter(client);

    const record = await adapter.getProduct("dated-product", {});

    expect(record.details.uploadedBy).toBe("Test User");
    expect(record.details.uploadedAt).toBe("2020-01-01");
    expect(record.details.updatedAt).toBe("2021-06-15");
  });

  it("fills missing product and ingredient links", async () => {
    const fake = {
      getProduct: vi.fn(async () => ({
        slug: "bare",
        name: "Bare Product",
        ingredients: [{ name: "Water", slug: "water" }],
      })),
    } as unknown as InkeedecoderClient;
    const adapter = createInkeedecoderAdapter(fake);

    const record = await adapter.getProduct("bare", {});

    expect(record.ingredients).toEqual([
      {
        name: "Water",
        identifiers: { slug: "water" },
        source: {
          database: "INKEEDecoder",
          id: "water",
          url: "https://inkeedecoder.com/ingredients/water",
          retrievedAt: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          ),
        },
      },
    ]);
    expect(record.product.name).toBe("Bare Product");
    expect(record.product.source.url).toBe(
      "https://inkeedecoder.com/products/bare",
    );
  });

  it("tolerates a client record with no ingredient list", async () => {
    const fake = {
      getProduct: vi.fn(async () => ({
        slug: "",
        name: "",
        url: "https://inkeedecoder.com/products/bare",
      })),
    } as unknown as InkeedecoderClient;
    const adapter = createInkeedecoderAdapter(fake);

    const record = await adapter.getProduct("bare", {});

    expect(record.ingredients).toEqual([]);
    expect(record.product.identifiers.slug).toBe("bare");
    expect(record.product.name).toBe("bare");
  });
});

describe("INKEEDecoder ingredient lookup", () => {
  it("surfaces the CosIng panel's CAS and EC numbers in identifiers", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("ingredient-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);

    const record = await adapter.getIngredient(
      "https://inkeedecoder.com/ingredients/niacinamide?ref=search",
      {},
    );

    const ingredient = record.ingredient;
    expect(ingredient.name).toBe("Niacinamide");
    expect(ingredient.inciName).toBe("Niacinamide");
    expect(ingredient.identifiers).toEqual({
      slug: "niacinamide",
      cas: ["98-92-0"],
      ec: ["202-713-4"],
    });
    expect(ingredient.source).toMatchObject({
      database: "INKEEDecoder",
      id: "niacinamide",
      url: "https://inkeedecoder.com/ingredients/niacinamide",
    });
    expect(ingredient.summary).toBe(
      "Functions: cell-communicating ingredient, skin brightening, anti-acne, moisturizer/humectant · Our take: superstar · CosIng functions: smoothing · IUPAC name: 3-Pyridinecarboxamide",
    );
    expect(ingredientRefSchema.parse(ingredient)).toBeDefined();

    expect(record.details.functions).toEqual([
      "cell-communicating ingredient",
      "skin brightening",
      "anti-acne",
      "moisturizer/humectant",
    ]);
    expect(record.details.alsoCalled).toBe("vitamin B3, nicotinamide");
    expect(record.details.cosingFunctions).toBe("smoothing");
    expect(record.details.iupacName).toBe("3-Pyridinecarboxamide");
    expect(record.details.image).toContain("niacinamide_original.jpeg");
    expect(record.details.details).toContain("Niacinamide");
    expect(record.details.proof?.length).toBeGreaterThan(0);
    expect(record.details.irritancy).toBeUndefined();
    expect(record.details.comedogenicity).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAt(fetchMock).url.pathname).toBe("/ingredients/niacinamide");
  });

  it("splits, trims, and dedupes CosIng identifiers and adds safety notes", async () => {
    const { client } = clientFor(routeTo(EDGE_INGREDIENT));
    const adapter = createInkeedecoderAdapter(client);

    const record = await adapter.getIngredient("edge-ingredient", {});

    expect(record.ingredient.identifiers).toEqual({
      slug: "edge-ingredient",
      cas: ["98-92-0", "100-00-0"],
    });
    expect(record.ingredient.summary).toBe(
      "Irritancy: low · Comedogenicity: medium · CosIng functions: smoothing · IUPAC name: Edgeamide",
    );
    expect(record.details.irritancy).toBe("low");
    expect(record.details.comedogenicity).toBe("medium");
  });

  it("omits absent sections and never invents identifiers", async () => {
    const { client } = clientFor(routeTo(MINIMAL_INGREDIENT));
    const adapter = createInkeedecoderAdapter(client);

    const record = await adapter.getIngredient("bare-ingredient", {});

    expect(record.ingredient.name).toBe("Bare Ingredient");
    expect(record.ingredient.identifiers).toEqual({ slug: "bare-ingredient" });
    expect(record.ingredient.summary).toBeUndefined();
    expect(record.details).toEqual({ functions: [], proof: [] });
  });

  it("tolerates a client record with no functions or proof", async () => {
    const fake = {
      getIngredient: vi.fn(async () => ({
        slug: "",
        name: "",
        ourTake: null,
      })),
    } as unknown as InkeedecoderClient;
    const adapter = createInkeedecoderAdapter(fake);

    const record = await adapter.getIngredient("bare", {});

    expect(record.details.functions).toEqual([]);
    expect(record.details.proof).toEqual([]);
    expect(record.ingredient.summary).toBeUndefined();
    expect(record.ingredient.name).toBe("bare");
    expect(record.ingredient.identifiers.slug).toBe("bare");
    expect(record.ingredient.source.url).toBe(
      "https://inkeedecoder.com/ingredients/bare",
    );
  });
});

describe("INKEEDecoder bridges", () => {
  it("looks an ingredient up by slug with the CosIng panel", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("ingredient-niacinamide.html")),
    );
    const bridges = createInkeedecoderBridges(client);

    const ingredient = await bridges.getIngredientBySlug(
      "https://inkeedecoder.com/ingredients/niacinamide?ref=x",
      { cosing: true },
    );

    expect(ingredient.slug).toBe("niacinamide");
    expect(ingredient.cosing).toEqual({
      allFunctions: "smoothing",
      cas: "98-92-0",
      ec: "202-713-4",
      iupacName: "3-Pyridinecarboxamide",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAt(fetchMock).url.pathname).toBe("/ingredients/niacinamide");
  });

  it("defaults to the shared client through the process-wide bridge", async () => {
    const fetchMock = vi.fn(
      async () => new Response(fixture("ingredient-niacinamide.html")),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      const ingredient = await ikdBridges.getIngredientBySlug("niacinamide");
      expect(ingredient.cosing?.cas).toBe("98-92-0");
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });

  it("rejects an invalid slug before making a request", async () => {
    const { client, fetchMock } = clientFor(routeTo(MINIMAL_INGREDIENT));
    const bridges = createInkeedecoderBridges(client);

    await expect(
      bridges.getIngredientBySlug("https://example.com/ingredients/x"),
    ).rejects.toThrow(/not an INKEEDecoder link/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes a bridge lookup failure", async () => {
    const { client } = clientFor(() => new Response(null, { status: 503 }));
    const bridges = createInkeedecoderBridges(client);

    await expect(bridges.getIngredientBySlug("niacinamide")).rejects.toThrow(
      "The INKEEDecoder ingredient lookup failed: INKEEDecoder returned HTTP 503 and may be temporarily unavailable. Retry shortly.",
    );
  });
});

describe("INKEEDecoder failures", () => {
  it.each([
    [
      "429 rate limit",
      () => new Response(null, { status: 429 }),
      "The INKEEDecoder product search was rate limited by INKEEDecoder (HTTP 429). Wait a few seconds, then retry.",
    ],
    [
      "5xx outage",
      () => new Response(null, { status: 503 }),
      "The INKEEDecoder product search failed: INKEEDecoder returned HTTP 503 and may be temporarily unavailable. Retry shortly.",
    ],
    [
      "4xx rejection",
      () => new Response(null, { status: 400 }),
      "The INKEEDecoder product search failed: INKEEDecoder rejected the request (HTTP 400). Check the value and try again.",
    ],
    [
      "404 missing record",
      () => new Response(null, { status: 404 }),
      "The INKEEDecoder product search failed: INKEEDecoder has no record at that address (HTTP 404). Check identifiers.slug from an INKEEDecoder result.",
    ],
    [
      "transport failure",
      () => {
        throw new Error(
          "@knorby/inkeedecoder-client failed at https://inkeedecoder.com/search?query=secret <html>",
        );
      },
      "The INKEEDecoder product search failed: INKEEDecoder did not return a usable response. Retry shortly.",
    ],
  ])("sanitizes a %s", async (_label, response, message) => {
    const { client } = clientFor(response);
    const adapter = createInkeedecoderAdapter(client);

    const failure = adapter.searchProducts("name", "niacinamide", 1);

    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.not.toThrow(
      /@knorby|https?:\/\/|query=|secret|<html>/,
    );
  });

  it("sanitizes a failed advanced ingredient search", async () => {
    const { client } = clientFor(() => new Response(null, { status: 503 }));
    const adapter = createInkeedecoderAdapter(client);

    await expect(
      adapter.searchProducts("ingredient", "Niacinamide", 1),
    ).rejects.toThrow(
      "The INKEEDecoder product search failed: INKEEDecoder returned HTTP 503 and may be temporarily unavailable. Retry shortly.",
    );
  });

  it("reads a numeric status carried on the error object", async () => {
    const { client } = clientFor(() => {
      throw Object.assign(new Error("client failure"), { status: 502 });
    });
    const adapter = createInkeedecoderAdapter(client);

    await expect(
      adapter.searchIngredients("name", "niacinamide", 1),
    ).rejects.toThrow(
      "The INKEEDecoder ingredient search failed: INKEEDecoder returned HTTP 502 and may be temporarily unavailable. Retry shortly.",
    );
  });

  it("sanitizes a non-Error rejection", async () => {
    const { client } = clientFor(() => {
      throw "raw upstream text https://inkeedecoder.com/search?query=secret";
    });
    const adapter = createInkeedecoderAdapter(client);

    await expect(
      adapter.searchIngredients("name", "niacinamide", 1),
    ).rejects.toThrow(
      "The INKEEDecoder ingredient search failed: INKEEDecoder did not return a usable response. Retry shortly.",
    );
  });

  it("sanitizes product and ingredient lookup failures", async () => {
    const { client: productClient } = clientFor(
      () => new Response(null, { status: 500 }),
    );
    const productAdapter = createInkeedecoderAdapter(productClient);
    await expect(productAdapter.getProduct("thing", {})).rejects.toThrow(
      "The INKEEDecoder product lookup failed: INKEEDecoder returned HTTP 500 and may be temporarily unavailable. Retry shortly.",
    );

    const { client: ingredientClient } = clientFor(
      () => new Response(null, { status: 429 }),
    );
    const ingredientAdapter = createInkeedecoderAdapter(ingredientClient);
    await expect(ingredientAdapter.getIngredient("thing", {})).rejects.toThrow(
      "The INKEEDecoder ingredient lookup was rate limited by INKEEDecoder (HTTP 429). Wait a few seconds, then retry.",
    );
  });

  it("forwards an abort signal so no request is made", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("search-niacinamide.html")),
    );
    const adapter = createInkeedecoderAdapter(client);
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.searchProducts("name", "niacinamide", 1, controller.signal),
    ).rejects.toThrow(
      "The INKEEDecoder product search failed: INKEEDecoder did not return a usable response. Retry shortly.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not disguise an invalid configuration as an INKEEDecoder outage", async () => {
    vi.stubEnv("DRUGDATA_TIMEOUT_MS", "not-a-number");
    resetClients();
    resetConfig();
    try {
      await expect(
        inkeedecoderAdapter.searchProducts("name", "niacinamide", 1),
      ).rejects.toThrow(/DRUGDATA_TIMEOUT_MS/);
      await expect(
        inkeedecoderAdapter.searchProducts("name", "niacinamide", 1),
      ).rejects.not.toThrow(/INKEEDecoder did not return a usable response/);
    } finally {
      vi.unstubAllEnvs();
      resetClients();
      resetConfig();
    }
  });
});
