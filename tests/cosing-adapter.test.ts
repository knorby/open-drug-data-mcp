import { readFileSync } from "node:fs";
import { CosingClient, type FetchLike } from "@knorby/eu-cosing-client";
import { describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import { cosingAdapter, createCosingAdapter } from "../src/sources/cosing.js";
import { jsonResponse } from "./helpers.js";

/**
 * The CosIng adapter is tested through the client's injectable `fetch`.
 *
 * Every fixture under `tests/fixtures/cosing/` is a raw EU Search API
 * response captured live from the public CosIng search on 2026-10-22, with a
 * page size of two, so the mapping is pinned to the shapes the API really
 * returns. The adapter never surfaces client-library names, API keys, or raw
 * URLs in errors, and a zero-match search is an ordinary empty group.
 */

const FIXTURES = new URL("./fixtures/cosing/", import.meta.url);

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Builds a client whose fetch routes every request through `handler`. */
function clientFor(handler: Handler) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new URL(String(input)), init ?? {}),
  );
  const client = new CosingClient({
    fetch: fetchMock as unknown as FetchLike,
    timeoutMs: 5_000,
  });
  return { client, fetchMock };
}

/** A handler that answers every request with one fixed body. */
function routeTo(body: unknown): Handler {
  return () => jsonResponse(body);
}

interface SearchQuery {
  bool: {
    must: Array<{
      term?: Record<string, string>;
      text?: { query: string; fields?: string[] };
    }>;
  };
}

/**
 * Extracts the Elasticsearch-style query from a search request's multipart
 * body. The public search transport sends clauses there and the free-text
 * term as a URL parameter.
 */
function searchQuery(init: RequestInit): SearchQuery {
  const body = typeof init.body === "string" ? init.body : "";
  const match =
    /name="query"\r\ncontent-type: application\/json\r\n\r\n([\s\S]*?)\r\n--/.exec(
      body,
    );
  if (match?.[1] === undefined) throw new Error("no query part in request");
  return JSON.parse(match[1]) as SearchQuery;
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

/** A minimal EU Search envelope around hand-authored metadata records. */
function envelope(records: Record<string, unknown>[], page = 1): unknown {
  return {
    apiVersion: "2.157.1",
    terms: "",
    totalResults: records.length,
    pageNumber: page,
    pageSize: 2,
    results: records.map((metadata) => ({ metadata })),
  };
}

describe("CosIng adapter capabilities", () => {
  it("declares the briefed id, database, ingredient search types, and no products", () => {
    expect(cosingAdapter.id).toBe("cosing");
    expect(cosingAdapter.databases).toEqual(["CosIng"]);
    expect(cosingAdapter.productSearchTypes).toEqual([]);
    expect(cosingAdapter.ingredientSearchTypes).toEqual([
      "name",
      "inci",
      "cas",
      "ec",
    ]);
    expect(cosingAdapter.productCategories).toEqual([]);
    expect(cosingAdapter.searchProducts).toBeUndefined();
    expect(cosingAdapter.searchIngredients).toBeTypeOf("function");
  });

  it("defaults to the shared CosIng client", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(fixture("ingredient-inci-niacinamide.json")),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      const groups = await cosingAdapter.searchIngredients?.(
        "inci",
        "NIACINAMIDE",
        1,
      );
      expect(groups?.[0]?.items[0]?.source.id).toBe("35499");
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});

describe("CosIng INCI search", () => {
  it("maps an exact INCI hit with CAS, EC, status, and a deep link", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("ingredient-inci-niacinamide.json")),
    );
    const adapter = createCosingAdapter(client);

    const groups = await adapter.searchIngredients?.("inci", "niacinamide", 1);

    expect(groups).toHaveLength(1);
    const group = groups?.[0];
    expect(group?.source).toBe("CosIng");
    expect(group?.page).toBe(1);
    expect(group?.hasMore).toBe(false);
    expect(group?.error).toBeUndefined();
    expect(group?.items).toHaveLength(1);

    const item = group?.items[0];
    expect(item?.name).toBe("NIACINAMIDE");
    expect(item?.inciName).toBe("NIACINAMIDE");
    expect(item?.identifiers).toEqual({
      cas: ["98-92-0"],
      ec: ["202-713-4"],
    });
    expect(item?.matchBasis).toBe("INCI name match");
    expect(item?.summary).toBe("Functions: SMOOTHING · Status: Active");
    expect(item?.source.database).toBe("CosIng");
    expect(item?.source.id).toBe("35499");
    expect(item?.source.url).toBe(
      "https://ec.europa.eu/growth/tools-databases/cosing/details/35499",
    );
    expect(item?.source.retrievedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const [{ url, init }] = requests(fetchMock);
    expect(url?.pathname).toBe("/es/search-api/rest/search");
    expect(url?.searchParams.get("text")).toBe("");
    expect(url?.searchParams.get("pageSize")).toBe("20");
    expect(url?.searchParams.get("pageNumber")).toBe("1");
    expect(searchQuery(init as RequestInit)).toEqual({
      bool: {
        must: [
          { term: { itemType: "ingredient" } },
          { term: { inciName: "NIACINAMIDE" } },
        ],
      },
    });
  });

  it("falls back to the fuzzy text search when the exact INCI misses", async () => {
    const { client, fetchMock } = clientFor((_url, init) => {
      const must = searchQuery(init).bool.must;
      return jsonResponse(
        must.some((clause) => clause.term?.inciName !== undefined)
          ? fixture("ingredient-zero.json")
          : fixture("ingredient-text-niacinamide.json"),
      );
    });
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("inci", "niacinamide", 1)) ?? [];

    expect(group?.items.map((item) => item.source.id)).toEqual([
      "83218",
      "92270",
    ]);
    expect(group?.hasMore).toBe(true);
    expect(group?.items[0]?.matchBasis).toBe("fuzzy name match");

    const [{ url, init }, fallback] = requests(fetchMock);
    expect(url?.searchParams.get("text")).toBe("");
    expect(searchQuery(init as RequestInit).bool.must).toContainEqual({
      term: { inciName: "NIACINAMIDE" },
    });
    expect(fallback?.url.searchParams.get("text")).toBe("niacinamide");
    expect(searchQuery(fallback?.init as RequestInit)).toEqual({
      bool: { must: [{ term: { itemType: "ingredient" } }] },
    });
  });

  it("returns an empty group when both the exact and fuzzy searches miss", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("ingredient-zero.json")),
    );
    const adapter = createCosingAdapter(client);

    const groups = await adapter.searchIngredients?.("inci", "nothing", 1);

    expect(groups).toEqual([
      { source: "CosIng", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("CosIng name search", () => {
  it("maps fuzzy text hits to ingredient refs", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("ingredient-text-niacinamide.json")),
    );
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "niacinamide", 1)) ?? [];

    expect(group?.items).toHaveLength(2);
    expect(group?.source).toBe("CosIng");
    expect(group?.items.map((item) => item.name)).toEqual([
      "NIACINAMIDE/YEAST POLYPEPTIDE",
      "SACCHAROMYCES/NIACINAMIDE FERMENT LYSATE FILTRATE",
    ]);
    expect(group?.items.map((item) => item.identifiers)).toEqual([{}, {}]);
    expect(group?.items.map((item) => item.summary)).toEqual([
      "Functions: SKIN CONDITIONING · Status: Active",
      "Functions: ANTIOXIDANT, SKIN PROTECTING · Status: Active",
    ]);
    expect(group?.items.map((item) => item.matchBasis)).toEqual([
      "fuzzy name match",
      "fuzzy name match",
    ]);

    const [{ url, init }] = requests(fetchMock);
    expect(url?.searchParams.get("text")).toBe("niacinamide");
    expect(url?.searchParams.get("pageSize")).toBe("20");
    expect(url?.searchParams.get("pageNumber")).toBe("1");
    expect(searchQuery(init as RequestInit)).toEqual({
      bool: { must: [{ term: { itemType: "ingredient" } }] },
    });
  });

  it("pages through upstream results", async () => {
    const pageTwo = {
      ...fixture<Record<string, unknown>>("ingredient-text-niacinamide.json"),
      pageNumber: 2,
    };
    const { client, fetchMock } = clientFor(routeTo(pageTwo));
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "niacinamide", 2)) ?? [];

    expect(group?.page).toBe(2);
    expect(group?.hasMore).toBe(true);
    const [{ url }] = requests(fetchMock);
    expect(url?.searchParams.get("pageNumber")).toBe("2");
    expect(url?.searchParams.get("pageSize")).toBe("20");
  });

  it("returns an empty group for a blank query without a request", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createCosingAdapter(client);

    const name = await adapter.searchIngredients?.("name", "   ", 1);
    const inci = await adapter.searchIngredients?.("inci", "", 1);

    expect(name).toEqual([
      { source: "CosIng", items: [], page: 1, hasMore: false },
    ]);
    expect(inci).toEqual([
      { source: "CosIng", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["unii", "rxcui"] as const)(
    "returns an empty group for undeclared %s searches without a request",
    async (type) => {
      const { client, fetchMock } = clientFor(() => jsonResponse({}));
      const adapter = createCosingAdapter(client);

      const groups = await adapter.searchIngredients?.(type, "123", 1);

      expect(groups).toEqual([
        { source: "CosIng", items: [], page: 1, hasMore: false },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("CosIng CAS and EC search", () => {
  it("queries CAS as a scoped identifier substring and labels the basis", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("ingredient-cas-98-92-0.json")),
    );
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("cas", "98-92-0", 1)) ?? [];

    expect(group?.items[0]?.identifiers.cas).toEqual(["98-92-0"]);
    expect(group?.items[0]?.identifiers.ec).toEqual(["202-713-4"]);
    expect(group?.items[0]?.matchBasis).toBe("cas-substring");

    const [{ url, init }] = requests(fetchMock);
    expect(url?.searchParams.get("text")).toBe("");
    const clause = searchQuery(init as RequestInit).bool.must[1]?.text;
    expect(clause?.fields).toEqual(["casNo", "ecNo"]);
    expect(clause?.query.replace(/\\/g, "")).toBe("*98-92-0*");
  });

  it("queries EC as a scoped identifier substring and labels the basis", async () => {
    const { client, fetchMock } = clientFor(
      routeTo(fixture("ingredient-ec-202-713-4.json")),
    );
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("ec", "202-713-4", 1)) ?? [];

    expect(group?.items[0]?.name).toBe("NIACINAMIDE");
    expect(group?.items[0]?.matchBasis).toBe("ec-substring");

    const [{ init }] = requests(fetchMock);
    const clause = searchQuery(init as RequestInit).bool.must[1]?.text;
    expect(clause?.fields).toEqual(["casNo", "ecNo"]);
    expect(clause?.query.replace(/\\/g, "")).toBe("*202-713-4*");
  });

  it.each(["cas", "ec"] as const)(
    "turns a zero-match %s search into an empty group",
    async (type) => {
      const { client } = clientFor(routeTo(fixture("ingredient-zero.json")));
      const adapter = createCosingAdapter(client);

      const groups = await adapter.searchIngredients?.(type, "000-00-0", 1);

      expect(groups).toEqual([
        { source: "CosIng", items: [], page: 1, hasMore: false },
      ]);
    },
  );

  it("keeps verbatim regulatory restriction text in the summary", async () => {
    const { client } = clientFor(
      routeTo(fixture("ingredient-inci-salicylic-acid.json")),
    );
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("inci", "salicylic acid", 1)) ?? [];

    const item = group?.items[0];
    expect(item?.name).toBe("SALICYLIC ACID");
    expect(item?.identifiers).toEqual({
      cas: ["69-72-7"],
      ec: ["200-712-3"],
    });
    expect(item?.summary).toBe(
      "Functions: ANTI-SEBORRHEIC, HAIR CONDITIONING, KERATOLYTIC, FRAGRANCE, PRESERVATIVE, SKIN CONDITIONING · Status: Active · Restriction: III/98 V/3",
    );
  });
});

describe("CosIng ingredient mapping", () => {
  it("skips records without an id and trims and dedupes identifiers", async () => {
    const { client } = clientFor(
      routeTo(
        envelope([
          { inciName: ["NO ID"] },
          {
            substanceId: [" 42 "],
            nameOfCommonIngredientsGlossary: ["  GLOSS  "],
            inciName: ["  INCI  "],
            casNo: [" 98-92-0 / 98-92-0 "],
            ecNo: [" 202-713-4 "],
            functionName: ["SMOOTHING"],
            status: [" Active "],
          },
        ]),
      ),
    );
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "gloss", 1)) ?? [];

    expect(group?.items).toHaveLength(1);
    const item = group?.items[0];
    expect(item?.name).toBe("GLOSS");
    expect(item?.inciName).toBe("INCI");
    expect(item?.identifiers).toEqual({
      cas: ["98-92-0"],
      ec: ["202-713-4"],
    });
    expect(item?.source.id).toBe("42");
    expect(item?.source.url).toBe(
      "https://ec.europa.eu/growth/tools-databases/cosing/details/42",
    );
    expect(item?.summary).toBe("Functions: SMOOTHING · Status: Active");
  });

  it("falls back to the id for an unnamed record and omits empty fields", async () => {
    const { client } = clientFor(
      routeTo(envelope([{ substanceId: ["12345"] }])),
    );
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "12345", 1)) ?? [];

    const item = group?.items[0];
    expect(item?.name).toBe("12345");
    expect(item?.inciName).toBeUndefined();
    expect(item?.identifiers).toEqual({});
    expect(item?.summary).toBeUndefined();
    expect(item?.matchBasis).toBe("fuzzy name match");
    expect(item?.source.url).toBe(
      "https://ec.europa.eu/growth/tools-databases/cosing/details/12345",
    );
  });

  it("includes annex numbers in the summary", async () => {
    const { client } = clientFor(
      routeTo(envelope([{ substanceId: ["999"], annexNo: ["III", "IV"] }])),
    );
    const adapter = createCosingAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "annexed", 1)) ?? [];

    expect(group?.items[0]?.summary).toBe("Annex: III, IV");
  });
});

describe("CosIng failures", () => {
  it.each([
    [
      "429 rate limit",
      () => new Response(null, { status: 429 }),
      /rate limited/,
    ],
    [
      "5xx outage",
      () => new Response(null, { status: 503 }),
      /temporarily unavailable/,
    ],
    [
      "4xx rejection",
      () => new Response(null, { status: 400 }),
      /rejected the request/,
    ],
    [
      "transport failure",
      () => {
        throw new Error(
          "@knorby/eu-cosing-client failed at https://webgate.ec.europa.eu/?apiKey=secret",
        );
      },
      /did not return a usable response/,
    ],
  ])("sanitizes a %s", async (_label, response, message) => {
    const { client } = clientFor(response);
    const adapter = createCosingAdapter(client);

    const failure = adapter.searchIngredients?.("cas", "98-92-0", 1);

    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.not.toThrow(
      /@knorby|apiKey|api_key|secret|webgate/,
    );
  });

  it("sanitizes a fuzzy fallback failure", async () => {
    const { client } = clientFor((_url, init) =>
      searchQuery(init).bool.must.some(
        (clause) => clause.term?.inciName !== undefined,
      )
        ? jsonResponse(fixture("ingredient-zero.json"))
        : new Response(null, { status: 400 }),
    );
    const adapter = createCosingAdapter(client);

    await expect(
      adapter.searchIngredients?.("inci", "niacinamide", 1),
    ).rejects.toThrow(/rejected the request/);
  });
});
