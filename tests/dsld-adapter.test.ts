import { readFileSync } from "node:fs";
import { DsldClient, type FetchLike } from "@knorby/nih-dsld-client";
import { describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import { ingredientRefSchema, productRefSchema } from "../src/lib/schemas.js";
import {
  createDsldAdapter,
  createDsldBridges,
  dsldAdapter,
} from "../src/sources/dsld.js";
import { jsonResponse } from "./helpers.js";

/**
 * The DSLD adapter is tested through the client's injectable `fetch`.
 *
 * Every fixture under `tests/fixtures/dsld/` is **hand-authored** from
 * `@knorby/nih-dsld-client`'s documented v9 types (2026-10-22): the live API
 * needs a data.gov key in practice and none was available. Each fixture
 * carries its provenance in a `_note` field.
 *
 * Two invariants are pinned throughout: search results never fetch full
 * labels (one search request per page), and no adapter failure text may name
 * the client package, a raw API URL, or an API key.
 */

const FIXTURES = new URL("./fixtures/dsld/", import.meta.url);

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

/** A search-filter page with two vitamin labels. */
function searchPage(): unknown {
  return fixture("search-labels-vitamin.json");
}

/** The full label matching the first search hit. */
function labelPage(): unknown {
  return fixture("label-82118.json");
}

/** The nutrient-info response for a calcium label row. */
function calciumGroups(): unknown {
  return fixture("ingredient-groups-calcium.json");
}

/** An empty DSLD list response. */
function emptyList(): unknown {
  return { total: { value: 0, relation: "eq" }, max_score: null, hits: [] };
}

/** A fresh HTTP failure response, optionally with Retry-After seconds. */
function failure(status: number, retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: "upstream failure" }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
  });
}

type Handler = (url: URL) => Response | Promise<Response>;

interface RoutedClient {
  client: DsldClient;
  fetchMock: ReturnType<typeof vi.fn>;
}

/** Builds a client whose fetch routes through `handler`. */
function clientFor(handler: Handler): RoutedClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    handler(new URL(String(input))),
  );
  const client = new DsldClient({
    fetch: fetchMock as unknown as FetchLike,
    timeoutMs: 5_000,
  });
  return { client, fetchMock };
}

/** Every request URL the fetch stub saw. */
function requests(fetchMock: { mock: { calls: unknown[][] } }): URL[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)));
}

/** The search-filter requests among the fetch calls. */
function searchRequests(fetchMock: { mock: { calls: unknown[][] } }): URL[] {
  return requests(fetchMock).filter((url) =>
    url.pathname.endsWith("/v9/search-filter"),
  );
}

/** The ingredient-group requests among the fetch calls. */
function groupRequests(fetchMock: { mock: { calls: unknown[][] } }): URL[] {
  return requests(fetchMock).filter((url) =>
    url.pathname.endsWith("/v9/ingredient-groups"),
  );
}

/** A handler that answers search-filter from one page and rejects the rest. */
function searchOnly(page: unknown): Handler {
  return (url) => {
    if (url.pathname.endsWith("/v9/search-filter")) {
      return jsonResponse(page);
    }
    throw new Error(`unexpected DSLD request: ${url.pathname}`);
  };
}

/** A handler for the brand-search pair: browse-brands, then search-filter. */
function brandOnly(browse: unknown, search: () => Response): Handler {
  return (url) => {
    if (url.pathname.endsWith("/v9/browse-brands")) {
      return jsonResponse(browse);
    }
    if (url.pathname.endsWith("/v9/search-filter")) return search();
    throw new Error(`unexpected DSLD request: ${url.pathname}`);
  };
}

/** The adapter's model-facing error text for a rejected call. */
async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** Asserts error text names only DSLD and never a client or raw URL. */
function expectSanitized(message: string): void {
  expect(message).toContain("DSLD");
  expect(message).not.toContain("@knorby");
  expect(message).not.toContain("-client");
  expect(message).not.toContain("api_key");
  expect(message).not.toContain("https://");
}

/** A 20-hit page generated from the first fixture hit, with one duplicate. */
function fullSearchPage(): unknown {
  const base = (searchPage() as { hits: { _source: object }[] }).hits[0]
    ?._source;
  const hits = Array.from({ length: 20 }, (_, index) => ({
    _id: String(1000 + index),
    _source: { ...base, id: 1000 + index },
  }));
  // Duplicate the last label id: the same label can arrive for two variants.
  (hits[19] as { _source: object })._source = {
    ...(hits[18] as { _source: object })._source,
  };
  return { hits };
}

describe("DSLD adapter capabilities", () => {
  it("declares supplement product search types and no ingredient search", () => {
    expect(dsldAdapter.id).toBe("dsld");
    expect(dsldAdapter.databases).toEqual(["DSLD"]);
    expect(dsldAdapter.productSearchTypes).toEqual([
      "name",
      "brand",
      "ingredient",
      "barcode",
    ]);
    expect(dsldAdapter.ingredientSearchTypes).toEqual([]);
    expect(dsldAdapter.productCategories).toEqual(["supplement"]);
    expect(dsldAdapter.searchProducts).toBeTypeOf("function");
    expect(dsldAdapter.getProduct).toBeTypeOf("function");
    expect(dsldAdapter.searchIngredients).toBeUndefined();
  });

  it("defaults to the shared DSLD client", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchPage()));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      const groups = await dsldAdapter.searchProducts("name", "Vitamin D", 1);
      expect(groups[0]?.items).toHaveLength(2);
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});

describe("DSLD product name search", () => {
  it("maps search hits to product refs without fetching labels", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("name", "  Vitamin D ", 1);

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.source).toBe("DSLD");
    expect(group?.page).toBe(1);
    expect(group?.hasMore).toBe(false);
    expect(group?.items.map((item) => item.identifiers.dsldId)).toEqual([
      82118, 90001,
    ]);

    const first = group?.items[0];
    expect(first).toBeDefined();
    expect(productRefSchema.parse(first)).toEqual(first);
    expect(first?.name).toBe("Vitamin D3 1000 IU Softgels");
    expect(first?.brand).toBe("Nature's Best");
    expect(first?.category).toBe("supplement");
    expect(first?.identifiers).toEqual({
      dsldId: 82118,
      upc: ["0 33674 13941 7"],
    });
    expect(first?.identifiers.ndc).toBeUndefined();
    expect(first?.summary).toBe(
      "Vitamin · 90 Softgel(s) · Ingredients: Vitamin D3, Calcium, Magnesium, Zinc, Boron (+1 more)",
    );
    expect(first?.source).toEqual({
      database: "DSLD",
      id: "82118",
      url: "https://dsld.od.nih.gov/label/82118",
      retrievedAt: expect.any(String),
    });
    expect(new Date(first?.source.retrievedAt ?? "").toISOString()).toBe(
      first?.source.retrievedAt,
    );

    const second = group?.items[1];
    expect(second?.identifiers).toEqual({ dsldId: 90001 });
    expect(second?.summary).toBe("Ingredients: Vitamin C");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request] = searchRequests(fetchMock);
    expect(request?.searchParams.get("product_name")).toBe("Vitamin D");
    expect(request?.searchParams.get("status")).toBe("1");
    expect(request?.searchParams.get("from")).toBe("0");
    expect(request?.searchParams.get("size")).toBe("20");
    // The client's field-only search sends "*" as the catch-all, never the
    // product name: the query must stay in product_name.
    expect(request?.searchParams.get("q")).toBe("*");
    expect(
      requests(fetchMock).some((url) => url.pathname.includes("/v9/label/")),
    ).toBe(false);
  });

  it("asks for the requested page without walking pages", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    await adapter.searchProducts("name", "Vitamin D", 2);

    const [request] = searchRequests(fetchMock);
    expect(request?.searchParams.get("from")).toBe("20");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports more when a full page comes back and collapses duplicate ids", async () => {
    const { client } = clientFor(searchOnly(fullSearchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("name", "Vitamin D", 1);

    expect(groups[0]?.items).toHaveLength(19);
    expect(groups[0]?.hasMore).toBe(true);
  });

  it("skips hits without an id and falls back to a label name", async () => {
    const { client } = clientFor(
      searchOnly({
        hits: [
          {},
          { _source: { id: 42 } },
          { _source: { id: 0, fullName: "Zero" } },
        ],
      }),
    );
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("name", "anything", 1);

    expect(groups[0]?.items).toHaveLength(1);
    expect(groups[0]?.items[0]?.name).toBe("DSLD label 42");
    expect(groups[0]?.items[0]?.summary).toBeUndefined();
    expect(groups[0]?.hasMore).toBe(false);
  });

  it("returns an empty group when a search page has no hits field", async () => {
    const { client } = clientFor(searchOnly({}));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("name", "Vitamin D", 1);

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 1, hasMore: false },
    ]);
  });

  it("returns an empty group without a request for a blank query", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("name", "   ", 1);

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty group for an unsupported product search type", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("ndc", "00093-1046-01", 1);

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DSLD brand search", () => {
  it("resolves an exact brand through brand browse, then filters by brand", async () => {
    const { client, fetchMock } = clientFor(
      brandOnly(fixture("browse-brands.json"), () =>
        jsonResponse(searchPage()),
      ),
    );
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("brand", "natures best", 1);

    expect(groups[0]?.items).toHaveLength(2);
    const [browse] = requests(fetchMock);
    expect(browse?.pathname).toContain("/v9/browse-brands");
    expect(browse?.searchParams.get("method")).toBe("by_keyword");
    expect(browse?.searchParams.get("q")).toBe("natures best");
    expect(browse?.searchParams.get("from")).toBe("0");
    expect(browse?.searchParams.get("size")).toBe("20");

    const [search] = searchRequests(fetchMock);
    expect(search?.searchParams.get("brand")).toBe("Nature's Best");
    expect(search?.searchParams.get("status")).toBe("1");
    expect(search?.searchParams.get("q")).toBe("*");
  });

  it("uses the browsed brand names when none is an exact match", async () => {
    const { client, fetchMock } = clientFor(
      brandOnly(fixture("browse-brands.json"), () =>
        jsonResponse(searchPage()),
      ),
    );
    const adapter = createDsldAdapter(client);

    await adapter.searchProducts("brand", "Vitamin", 1);

    const [search] = searchRequests(fetchMock);
    expect(search?.searchParams.get("brand")).toBe(
      "Example Labs,Nature's Best",
    );
  });

  it("falls back to the typed brand when browse returns no usable names", async () => {
    const { client, fetchMock } = clientFor(
      brandOnly({ hits: [{}, { _source: {} }] }, () =>
        jsonResponse(emptyList()),
      ),
    );
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("brand", "Unknown Brand", 1);

    expect(groups[0]?.items).toEqual([]);
    const [search] = searchRequests(fetchMock);
    expect(search?.searchParams.get("brand")).toBe("Unknown Brand");
  });

  it("falls back to the typed brand when browse omits its hits field", async () => {
    const { client, fetchMock } = clientFor(
      brandOnly({}, () => jsonResponse(searchPage())),
    );
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("brand", "Typed Brand", 1);

    expect(groups[0]?.items).toHaveLength(2);
    const [search] = searchRequests(fetchMock);
    expect(search?.searchParams.get("brand")).toBe("Typed Brand");
  });

  it("preserves Retry-After advice on a rate-limited brand browse", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/browse-brands")) {
        return failure(429, "5");
      }
      return jsonResponse(searchPage());
    });
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(
      adapter.searchProducts("brand", "Nature's Best", 1),
    );

    expect(message).toContain("DSLD");
    expect(message).toContain("HTTP 429");
    expect(message).toContain("Wait 5 seconds");
    expectSanitized(message);
  });

  it("rewords a rate-limited brand filter", async () => {
    const { client } = clientFor(
      brandOnly(emptyList(), () => failure(429, "5")),
    );
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(
      adapter.searchProducts("brand", "Nature's Best", 1),
    );

    expect(message).toContain("HTTP 429");
    expect(message).toContain("Wait 5 seconds");
    expectSanitized(message);
  });

  it("falls back to the typed brand when browse fails for another reason", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/browse-brands")) {
        return failure(503);
      }
      if (url.pathname.endsWith("/v9/search-filter")) {
        return jsonResponse(searchPage());
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("brand", "Nature's Best", 1);

    expect(groups[0]?.items).toHaveLength(2);
    const [search] = searchRequests(fetchMock);
    expect(search?.searchParams.get("brand")).toBe("Nature's Best");
    expect(search?.searchParams.get("q")).toBe("*");
  });

  it("returns an empty group without a request for a blank brand", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("brand", "  ", 1);

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DSLD ingredient product search", () => {
  it("filters search-filter by ingredient name and synonyms", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts(
      "ingredient",
      " vitamin d3 ",
      1,
    );

    expect(groups[0]?.items).toHaveLength(2);
    const [request] = searchRequests(fetchMock);
    expect(request?.searchParams.get("ingredient_name")).toBe("vitamin d3");
    expect(request?.searchParams.get("apply_synonyms")).toBe("Yes");
    expect(request?.searchParams.get("status")).toBe("1");
    expect(request?.searchParams.get("q")).toBe("*");
  });

  it("returns an empty group without a request for a blank ingredient", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("ingredient", "   ", 1);

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DSLD barcode search", () => {
  it("probes the parser's UPC variants and collapses duplicate labels", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts(
      "barcode",
      "0 33674 13941 7",
      1,
    );

    expect(groups[0]?.items.map((item) => item.identifiers.dsldId)).toEqual([
      82118, 90001,
    ]);
    const queries = searchRequests(fetchMock).map((url) =>
      url.searchParams.get("q"),
    );
    expect(queries).toEqual(['"033674139417"', '"0 33674 13941 7"']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies the requested page to each barcode variant", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    await adapter.searchProducts("barcode", "033674139417", 3);

    const search = searchRequests(fetchMock);
    expect(search.length).toBeGreaterThan(0);
    for (const url of search) {
      expect(url.searchParams.get("from")).toBe("40");
      expect(url.searchParams.get("size")).toBe("20");
    }
  });

  it("reports more when a barcode page is full", async () => {
    const { client } = clientFor(searchOnly(fullSearchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("barcode", "033674139417", 1);

    expect(groups[0]?.items).toHaveLength(19);
    expect(groups[0]?.hasMore).toBe(true);
  });

  it("returns an empty group without a request for an unknown code", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("barcode", "not-a-code", 1);

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not probe DSLD with an NDC-shaped drug code", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("barcode", "00093-1046-01", 1);

    expect(groups).toEqual([
      { source: "DSLD", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rewords a rate-limited barcode search", async () => {
    const { client } = clientFor(() => failure(429));
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(
      adapter.searchProducts("barcode", "033674139417", 1),
    );

    expect(message).toContain("HTTP 429");
    expect(message).toContain("Wait a few seconds");
    expectSanitized(message);
  });

  it("sanitizes an empty 2xx barcode page", async () => {
    const { client } = clientFor(() => new Response("", { status: 200 }));
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(
      adapter.searchProducts("barcode", "033674139417", 1),
    );

    expect(message).toContain("did not return a usable response");
    expect(message).not.toContain("Cannot read");
    expectSanitized(message);
  });

  it("skips malformed barcode hits instead of throwing", async () => {
    const { client, fetchMock } = clientFor(
      searchOnly({
        hits: [
          { _source: null },
          { _source: "not-an-object" },
          { _source: { id: 82118 } },
        ],
      }),
    );
    const adapter = createDsldAdapter(client);

    const groups = await adapter.searchProducts("barcode", "033674139417", 1);

    expect(groups[0]?.items).toHaveLength(1);
    expect(groups[0]?.items[0]?.identifiers.dsldId).toBe(82118);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("DSLD label lookup", () => {
  it("maps label rows to ingredient refs with UNII, roles, and quantities", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/82118")) {
        return jsonResponse(labelPage());
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        const term = url.searchParams.get("term");
        if (term === "Vitamin D3") {
          return jsonResponse(fixture("ingredient-groups-vitamin-d3.json"));
        }
        return jsonResponse(term === "Calcium" ? calciumGroups() : emptyList());
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("82118", {});

    expect(record.product.name).toBe("Vitamin D3 1000 IU Softgels");
    expect(record.product.brand).toBe("Nature's Best");
    expect(record.product.category).toBe("supplement");
    expect(record.product.identifiers).toEqual({
      dsldId: 82118,
      upc: ["0 33674 13941 7"],
    });
    expect(record.product.summary).toBe(
      "Vitamin · 90 Softgel(s) · 3 ingredients",
    );
    expect(record.product.source).toEqual({
      database: "DSLD",
      id: "82118",
      url: "https://dsld.od.nih.gov/label/82118",
      retrievedAt: expect.any(String),
    });
    expect(productRefSchema.parse(record.product)).toEqual(record.product);

    expect(record.details).toEqual({
      productType: "Vitamin",
      targetGroups: ["Adult (18 - 50 Years)", "Adult (51 - 70 Years)"],
      netContents: ["90 Softgel(s)"],
      claims: ["Nutrient"],
      offMarket: false,
      entryDate: "2023-05-01",
    });

    expect(record.ingredients).toHaveLength(3);
    for (const item of record.ingredients) {
      expect(ingredientRefSchema.parse(item)).toEqual(item);
    }

    const [vitaminD, calcium, gelatin] = record.ingredients;
    expect(vitaminD?.name).toBe("Vitamin D3");
    expect(vitaminD?.role).toBe("active");
    expect(vitaminD?.quantity).toBe("25 mcg");
    expect(vitaminD?.identifiers).toEqual({
      unii: "1C6V77Q43H",
      cas: ["67-97-0"],
    });
    expect(vitaminD?.summary).toBe("Category: vitamin · Group: Vitamin D");
    expect(vitaminD?.source).toEqual(record.product.source);

    expect(calcium?.name).toBe("Calcium");
    expect(calcium?.role).toBe("active");
    expect(calcium?.quantity).toBe("200 mg");
    expect(calcium?.identifiers).toEqual({ cas: ["471-34-1"] });
    expect(calcium?.summary).toBe("Category: mineral · Group: Calcium");

    expect(gelatin?.name).toBe("Gelatin");
    expect(gelatin?.role).toBe("inactive");
    expect(gelatin?.quantity).toBeUndefined();
    expect(gelatin?.identifiers).toEqual({});
    expect(gelatin?.summary).toBe("Category: other · Group: Gelatin");

    const terms = groupRequests(fetchMock).map((url) =>
      url.searchParams.get("term"),
    );
    expect(terms).toEqual(["Vitamin D3", "Calcium", "Gelatin"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      requests(fetchMock).some((url) =>
        url.pathname.endsWith("/v9/search-filter"),
      ),
    ).toBe(false);
  });

  it("maps a minimal label without inventing optional details", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/777")) {
        return jsonResponse({ id: 777 });
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("777", {});

    expect(record.product).toEqual({
      name: "DSLD label 777",
      category: "supplement",
      identifiers: { dsldId: 777 },
      source: {
        database: "DSLD",
        id: "777",
        url: "https://dsld.od.nih.gov/label/777",
        retrievedAt: expect.any(String),
      },
    });
    expect(record.details).toEqual({
      targetGroups: [],
      netContents: [],
      claims: [],
    });
    expect(record.ingredients).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps rows with thin quantity data and skips rows without a name", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/555")) {
        return jsonResponse({
          id: 555,
          netContents: [
            { order: 1, quantity: 2, unit: "Capsule(s)" },
            { order: 2, unit: "Capsule(s)" },
            { order: 3, quantity: 2 },
            { order: 4 },
          ],
          claims: [
            { langualCode: "P0065" },
            { langualCodeDescription: "Nutrient" },
          ],
          targetGroups: ["Adult", "   "],
          ingredientRows: [
            { order: 1, quantity: [{ quantity: 10, unit: "mg" }] },
            {
              order: 2,
              description: "Unit Only",
              uniiCode: "ABCDEFGHIJ",
              quantity: [{}, { unit: "IU" }, { quantity: 5 }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        return jsonResponse(emptyList());
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("555", {});

    expect(record.details).toEqual({
      targetGroups: ["Adult"],
      netContents: ["2 Capsule(s)", "Capsule(s)", "2"],
      claims: ["Nutrient"],
    });
    expect(record.ingredients).toHaveLength(1);
    expect(record.ingredients[0]?.name).toBe("Unit Only");
    expect(record.ingredients[0]?.quantity).toBe("IU · 5");
    expect(record.ingredients[0]?.identifiers).toEqual({
      unii: "ABCDEFGHIJ",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves rows unenriched when nutrient info has no confident match", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/889")) {
        return jsonResponse({
          id: 889,
          ingredientRows: [
            { order: 1, name: "Other" },
            { order: 2, name: "Plain" },
            { order: 3, name: "Mystery" },
            { order: 4, name: "Mystery" },
            { order: 5, name: "No Hits" },
            { order: 6, name: "!!!" },
          ],
        });
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        const term = url.searchParams.get("term");
        if (term === "Other") {
          // Matched by synonym, with no groupName or nutrient rows.
          return jsonResponse({
            hits: [{ _source: { synonyms: ["Other"], category: ["misc"] } }],
          });
        }
        if (term === "Plain") {
          return jsonResponse({ hits: [{ _source: { groupName: "Plain" } }] });
        }
        if (term === "No Hits") return jsonResponse({});
        if (term === "!!!") return jsonResponse({});
        return jsonResponse({
          hits: [{}, { _source: { groupName: "Different", synonyms: ["x"] } }],
        });
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("889", {});

    const [other, plain, mystery, duplicate, unmatched, bangs] =
      record.ingredients;
    expect(other?.identifiers).toEqual({});
    expect(other?.summary).toBe("Category: misc");
    expect(plain?.identifiers).toEqual({});
    expect(plain?.summary).toBe("Group: Plain");
    expect(mystery?.identifiers).toEqual({});
    expect(mystery?.summary).toBeUndefined();
    expect(duplicate?.summary).toBeUndefined();
    expect(unmatched?.summary).toBeUndefined();
    expect(bangs?.summary).toBeUndefined();

    const terms = groupRequests(fetchMock).map((url) =>
      url.searchParams.get("term"),
    );
    expect(terms).toEqual(["Other", "Plain", "Mystery", "No Hits"]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("stops enrichment at the first failure and keeps the label", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/888")) {
        return jsonResponse({
          id: 888,
          ingredientRows: [
            { order: 1, name: "Mystery One" },
            { order: 2, name: "Mystery Two" },
          ],
        });
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        return failure(500);
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("888", {});

    expect(record.product.summary).toBe("2 ingredients");
    expect(record.ingredients).toHaveLength(2);
    expect(record.ingredients[0]?.identifiers).toEqual({});
    expect(record.ingredients[0]?.summary).toBeUndefined();
    expect(record.ingredients[1]?.identifiers).toEqual({});
    const terms = groupRequests(fetchMock).map((url) =>
      url.searchParams.get("term"),
    );
    expect(terms).toEqual(["Mystery One"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("attaches only the salt form named on the label", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/890")) {
        return jsonResponse({
          id: 890,
          ingredientRows: [
            {
              order: 1,
              name: "Calcium",
              description: "Calcium (as calcium citrate)",
            },
            { order: 2, name: "Calcium", notes: "Calcium citrate" },
            { order: 3, name: "Calcium", description: "Calcium" },
          ],
        });
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        return jsonResponse(calciumGroups());
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("890", {});

    expect(record.ingredients[0]?.identifiers).toEqual({ cas: ["813-94-5"] });
    expect(record.ingredients[1]?.identifiers).toEqual({ cas: ["813-94-5"] });
    // Three rows share one name; the lookup is deduplicated, and a row with
    // no form name cannot pick between the group's two salts.
    expect(record.ingredients[2]?.identifiers).toEqual({});
    expect(groupRequests(fetchMock)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a single group CAS when the label names no form", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/891")) {
        return jsonResponse({
          id: 891,
          ingredientRows: [{ order: 1, name: "Magnesium" }],
        });
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        return jsonResponse({
          hits: [
            {
              _source: {
                groupName: "Magnesium",
                category: ["mineral"],
                nutrientInfo: [
                  { nutrient: "Magnesium oxide", cas: "1309-48-4" },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("891", {});

    expect(record.product.summary).toBe("1 ingredient");
    expect(record.ingredients[0]?.identifiers).toEqual({
      cas: ["1309-48-4"],
    });
    expect(record.ingredients[0]?.summary).toBe(
      "Category: mineral · Group: Magnesium",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps nutrient-info enrichment per label", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/892")) {
        return jsonResponse({
          id: 892,
          ingredientRows: Array.from({ length: 21 }, (_, index) => ({
            order: index + 1,
            name: `Ingredient ${index + 1}`,
          })),
        });
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        return jsonResponse(emptyList());
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const adapter = createDsldAdapter(client);

    const record = await adapter.getProduct("892", {});

    expect(record.ingredients).toHaveLength(21);
    const terms = groupRequests(fetchMock).map((url) =>
      url.searchParams.get("term"),
    );
    expect(terms).toHaveLength(20);
    expect(terms[0]).toBe("Ingredient 1");
    expect(terms[19]).toBe("Ingredient 20");
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  it("rejects an invalid label id before making a request", async () => {
    const { client, fetchMock } = clientFor(searchOnly(searchPage()));
    const adapter = createDsldAdapter(client);

    for (const id of ["", "abc", "0", "1.5", "-3"]) {
      await expect(adapter.getProduct(id, {})).rejects.toThrow(
        "Expected a DSLD label id",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rewords a missing label, a 5xx, and a transport failure", async () => {
    const missing = createDsldAdapter(
      clientFor((url) =>
        failure(url.pathname.endsWith("/v9/label/404") ? 404 : 500),
      ).client,
    );
    const missingMessage = await errorMessage(missing.getProduct("404", {}));
    expect(missingMessage).toContain("HTTP 404");
    expectSanitized(missingMessage);

    const unavailable = createDsldAdapter(clientFor(() => failure(503)).client);
    const unavailableMessage = await errorMessage(
      unavailable.getProduct("82118", {}),
    );
    expect(unavailableMessage).toContain("HTTP 503");
    expectSanitized(unavailableMessage);

    const offline = createDsldAdapter(
      clientFor(() => {
        throw new TypeError("fetch failed for https://internal.example/key");
      }).client,
    );
    const offlineMessage = await errorMessage(offline.getProduct("82118", {}));
    expect(offlineMessage).toContain("did not return a usable response");
    expectSanitized(offlineMessage);
    expect(offlineMessage).not.toContain("internal.example");
  });

  it("preserves Retry-After advice on a rate-limited label lookup", async () => {
    const { client } = clientFor(() => failure(429, "7"));
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(adapter.getProduct("82118", {}));

    expect(message).toContain("HTTP 429");
    expect(message).toContain("Wait 7 seconds");
    expectSanitized(message);
  });
});

describe("DSLD failure sanitation", () => {
  it("rewords a rate-limited name search without headers", async () => {
    const { client } = clientFor(() => failure(429));
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(
      adapter.searchProducts("name", "Vitamin D", 1),
    );

    expect(message).toContain("HTTP 429");
    expect(message).toContain("Wait a few seconds");
    expectSanitized(message);
  });

  it("rewords a rejected ingredient search", async () => {
    const { client } = clientFor(() => failure(400));
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(
      adapter.searchProducts("ingredient", "Vitamin D", 1),
    );

    expect(message).toContain("HTTP 400");
    expectSanitized(message);
  });

  it("hides transport details behind a generic search message", async () => {
    const { client } = clientFor(() => {
      throw new TypeError("fetch failed for https://internal.example/key");
    });
    const adapter = createDsldAdapter(client);

    const message = await errorMessage(
      adapter.searchProducts("name", "Vitamin D", 1),
    );

    expect(message).toContain("did not return a usable response");
    expectSanitized(message);
    expect(message).not.toContain("internal.example");
  });
});

describe("DSLD identity bridges", () => {
  it("maps ingredient-group hits with CAS, a source id, and a deep link", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        return jsonResponse(fixture("ingredient-groups-vitamin-d3.json"));
      }
      throw new Error(`unexpected DSLD request: ${url.pathname}`);
    });
    const refs =
      await createDsldBridges(client).ingredientGroupsByName("vitamin d3");

    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("Vitamin D3");
    expect(refs[0]?.identifiers.cas).toEqual(["67-97-0"]);
    expect(refs[0]?.source).toMatchObject({
      database: "DSLD",
      id: "vitamin-d3",
      url: "https://dsld.od.nih.gov/ingredient/Vitamin%20D3",
    });
    expect(refs[0]?.matchBasis).toBe("ingredient name match");
    expect(requests(fetchMock)[0]?.searchParams.get("method")).toBe(
      "by_keyword",
    );
    expect(
      await createDsldBridges(client).ingredientGroupsByName("  "),
    ).toEqual([]);
  });

  it("drops incomplete ingredient-group hits", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        return jsonResponse({
          hits: [
            { _index: "ingredient-groups" },
            { _source: { groupId: "nameless" } },
            {
              _source: {
                groupId: "no-cas",
                groupName: "No CAS",
                nutrientInfo: [{ cas: "   " }],
              },
            },
          ],
        });
      }
      return jsonResponse(emptyList());
    });
    const refs = await createDsldBridges(client).ingredientGroupsByName("x");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("No CAS");
    expect(refs[0]?.identifiers.cas).toBeUndefined();
    expect(refs[0]?.source.id).toBe("no-cas");

    const { client: missingHits } = clientFor(() =>
      jsonResponse({ total: { value: 0, relation: "eq" } }),
    );
    expect(
      await createDsldBridges(missingHits).ingredientGroupsByName("x"),
    ).toEqual([]);

    const { client: missingId } = clientFor(() =>
      jsonResponse({ hits: [{ _source: { groupName: "No Id" } }] }),
    );
    const noId = await createDsldBridges(missingId).ingredientGroupsByName("x");
    expect(noId[0]?.source.id).toBe("No Id");
  });

  it("rewords ingredient-group failures without naming the client", async () => {
    const { client } = clientFor((url) =>
      url.pathname.endsWith("/v9/ingredient-groups")
        ? failure(500)
        : jsonResponse(emptyList()),
    );
    const message = await errorMessage(
      createDsldBridges(client).ingredientGroupsByName("x"),
    );
    expect(message).toContain("DSLD");
    expectSanitized(message);
  });

  it("maps one label to its product ref and ingredient rows", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname.endsWith("/v9/label/82118")) {
        return jsonResponse(labelPage());
      }
      if (url.pathname.endsWith("/v9/ingredient-groups")) {
        const term = url.searchParams.get("term");
        if (term === "Vitamin D3") {
          return jsonResponse(fixture("ingredient-groups-vitamin-d3.json"));
        }
        return jsonResponse(term === "Calcium" ? calciumGroups() : emptyList());
      }
      return jsonResponse(emptyList());
    });
    const record = await createDsldBridges(client).label(82118);
    expect(record?.product.identifiers.dsldId).toBe(82118);
    expect(record?.ingredients.length).toBeGreaterThan(0);
  });

  it("rewords a label failure without naming the client", async () => {
    const { client } = clientFor(() => failure(500));
    const message = await errorMessage(createDsldBridges(client).label(82118));
    expect(message).toContain("DSLD");
    expectSanitized(message);
  });
});
