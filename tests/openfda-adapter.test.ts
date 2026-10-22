import { readFileSync } from "node:fs";
import {
  type DrugNdc,
  type FetchLike,
  OpenFdaClient,
  type Substance,
} from "@knorby/openfda-client";
import { describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import {
  createOpenFdaAdapter,
  matchSubstanceTier,
  openfdaAdapter,
  rankSubstances,
} from "../src/sources/openfda.js";
import { jsonResponse } from "./helpers.js";

/**
 * The openFDA adapter is tested through the client's injectable `fetch`.
 *
 * Every fixture under `tests/fixtures/openfda/` is a small live response
 * captured from api.fda.gov without a key (2026-10-22), except the synthetic
 * 404 envelope, so the mapping is pinned to the shapes the API really
 * returns. The adapter must never surface client-library names, raw URLs, or
 * API keys, and a zero-match 404 is an ordinary empty group.
 */

const FIXTURES = new URL("./fixtures/openfda/", import.meta.url);

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

type Handler = (url: URL) => Response | Promise<Response>;

/** Builds a client whose fetch routes every request through `handler`. */
function clientFor(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    handler(new URL(String(input))),
  );
  const client = new OpenFdaClient({
    fetch: fetchMock as unknown as FetchLike,
    timeoutMs: 5_000,
  });
  return { client, fetchMock };
}

/** A zero-match openFDA answer: HTTP 404 with a NOT_FOUND body. */
function notFound(): Response {
  return jsonResponse(fixture("ndc-zero-match.json"), { status: 404 });
}

/** The search expression a request carried, with query escaping removed. */
function searchOf(url: URL): string {
  return (url.searchParams.get("search") ?? "").replace(/\\/g, "");
}

/** All request URLs the client's fetch stub saw. */
function requests(fetchMock: {
  mock: { calls: [RequestInfo | URL, RequestInit?][] };
}): URL[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)));
}

function routeTo(path: string, body: unknown): Handler {
  return (url) => (url.pathname === path ? jsonResponse(body) : notFound());
}

describe("openFDA adapter capabilities", () => {
  it("declares the briefed id, database, search types, and category", () => {
    expect(openfdaAdapter.id).toBe("openfda");
    expect(openfdaAdapter.databases).toEqual(["openFDA"]);
    expect(openfdaAdapter.productSearchTypes).toEqual([
      "name",
      "brand",
      "ingredient",
      "barcode",
      "ndc",
    ]);
    expect(openfdaAdapter.ingredientSearchTypes).toEqual([
      "name",
      "inci",
      "unii",
      "cas",
    ]);
    expect(openfdaAdapter.productCategories).toEqual(["medication"]);
    expect(openfdaAdapter.searchProducts).toBeTypeOf("function");
    expect(openfdaAdapter.searchIngredients).toBeTypeOf("function");
  });

  it("defaults to the shared openFDA client", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(fixture("ndc-brand-lipitor.json")),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      const groups = await openfdaAdapter.searchProducts?.(
        "name",
        "Lipitor",
        1,
      );
      expect(groups?.[0]?.items).toHaveLength(2);
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});

describe("openFDA product search", () => {
  it("maps a name hit to a ProductRef with identifiers and a deep link", async () => {
    const { client, fetchMock } = clientFor(
      routeTo("/drug/ndc.json", fixture("ndc-brand-lipitor.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    const groups = await adapter.searchProducts?.("name", "Lipitor", 1);

    expect(groups).toHaveLength(1);
    const group = groups?.[0];
    expect(group?.source).toBe("openFDA");
    expect(group?.page).toBe(1);
    expect(group?.hasMore).toBe(false);
    expect(group?.error).toBeUndefined();
    expect(group?.items).toHaveLength(2);

    const first = group?.items[0];
    expect(first?.name).toBe("Lipitor");
    expect(first?.brand).toBe("Viatris Specialty LLC");
    expect(first?.category).toBe("medication");
    expect(first?.identifiers.ndc).toEqual(["58151-155-77"]);
    expect(first?.identifiers.splSetId).toBe(
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
    );
    expect(first?.identifiers.rxcui).toContain("259255");
    expect(first?.identifiers.applicationNumber).toBe("NDA020702");
    expect(first?.identifiers.upc).toContain("0358151155774");
    expect(first?.summary).toBe("TABLET, FILM COATED · ORAL · 10 mg");
    expect(first?.source.database).toBe("openFDA");
    expect(first?.source.id).toBe("58151-155");
    expect(first?.source.url).toMatch(
      /^https:\/\/api\.fda\.gov\/drug\/ndc\.json\?search=/,
    );
    expect(decodeURIComponent(first?.source.url ?? "")).toContain(
      'product_ndc:"58151-155"',
    );
    expect(first?.source.retrievedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(group?.items[1]?.identifiers.ndc).toEqual(["58151-156-77"]);

    const [url] = requests(fetchMock);
    const search = searchOf(url as URL);
    expect(url?.pathname).toBe("/drug/ndc.json");
    expect(search).toContain("brand_name:Lipitor");
    expect(search).toContain("generic_name:Lipitor");
    expect(search).toContain("brand_name_base:Lipitor");
    expect(search).toContain("finished:true");
    expect(search).toMatch(/NOT listing_expiration_date:\[\* TO \d{8}\]/);
    expect(url?.searchParams.get("limit")).toBe("20");
    expect(url?.searchParams.get("skip")).toBe("0");
  });

  it("uses the brand and ingredient fields the directory supports", async () => {
    const { client, fetchMock } = clientFor(
      routeTo("/drug/ndc.json", fixture("ndc-brand-lipitor.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    await adapter.searchProducts?.("brand", "Lipitor", 1);
    await adapter.searchProducts?.("ingredient", "atorvastatin", 1);

    const [brandUrl, ingredientUrl] = requests(fetchMock);
    const brand = searchOf(brandUrl as URL);
    expect(brand).toContain("brand_name:Lipitor");
    expect(brand).toContain("brand_name_base:Lipitor");
    const ingredient = searchOf(ingredientUrl as URL);
    expect(ingredient).toContain("active_ingredients.name:atorvastatin");
  });

  it("falls back to a generic name and omits absent identifiers", async () => {
    const body = {
      meta: { results: { skip: 0, limit: 20, total: 4 } },
      results: [
        { product_ndc: "12345-678", generic_name: "Test Drug" },
        { product_ndc: "12345-679" },
        { generic_name: "No Identifier" },
        {
          generic_name: "Derived Product",
          packaging: [{ package_ndc: "00069-0015-66" }],
        },
        {
          generic_name: "Broken Package",
          packaging: [{ package_ndc: "not-an-ndc" }],
        },
      ] satisfies DrugNdc[],
    };
    const { client } = clientFor(() => jsonResponse(body));
    const adapter = createOpenFdaAdapter(client);

    const [group] = (await adapter.searchProducts?.("name", "test", 1)) ?? [];

    expect(group?.items).toHaveLength(2);
    const [minimal, derived] = group?.items ?? [];
    expect(minimal?.name).toBe("Test Drug");
    expect(minimal?.brand).toBeUndefined();
    expect(minimal?.summary).toBeUndefined();
    expect(minimal?.identifiers).toEqual({ ndc: ["12345-678"] });
    expect(derived?.name).toBe("Derived Product");
    expect(derived?.source.id).toBe("00069-0015");
    expect(derived?.identifiers.ndc).toEqual(["00069-0015-66"]);
  });

  it("does not collapse OTC package variants", async () => {
    const otc = (productNdc: string): DrugNdc => ({
      product_ndc: productNdc,
      brand_name: "Same Name",
      dosage_form: "TABLET",
      product_type: "HUMAN OTC DRUG",
      active_ingredients: [{ name: "ASPIRIN", strength: "325 mg/1" }],
    });
    const { client } = clientFor(() =>
      jsonResponse({
        meta: { results: { skip: 0, limit: 20, total: 2 } },
        results: [otc("11111-111"), otc("22222-222")],
      }),
    );
    const adapter = createOpenFdaAdapter(client);

    const [group] = (await adapter.searchProducts?.("name", "same", 1)) ?? [];

    expect(group?.items.map((item) => item.source.id)).toEqual([
      "11111-111",
      "22222-222",
    ]);
  });

  it("collapses prescription variants sharing name, form, and strengths", async () => {
    const { client } = clientFor(
      routeTo("/drug/ndc.json", fixture("ndc-duplicate-variants.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    const [group] =
      (await adapter.searchProducts?.("name", "atorvastatin", 1)) ?? [];

    expect(group?.items.map((item) => item.source.id)).toEqual([
      "68071-3912",
      "43063-474",
    ]);
  });

  it("normalizes non-matching strengths and skips missing ones in the key", async () => {
    const variant = (productNdc: string): DrugNdc => ({
      product_ndc: productNdc,
      generic_name: "Compound",
      product_type: "HUMAN PRESCRIPTION DRUG",
      active_ingredients: [
        { name: "A", strength: "q.s." },
        { name: "B" },
        { name: "C", strength: "" },
      ],
    });
    const { client } = clientFor(() =>
      jsonResponse({
        meta: { results: { skip: 0, limit: 20, total: 2 } },
        results: [variant("11111-111"), variant("22222-222")],
      }),
    );
    const adapter = createOpenFdaAdapter(client);

    const [group] =
      (await adapter.searchProducts?.("name", "compound", 1)) ?? [];

    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]?.summary).toBe("q.s.");
  });

  it("queries NDC candidates against package and product spellings", async () => {
    const { client, fetchMock } = clientFor(
      routeTo("/drug/ndc.json", fixture("ndc-brand-lipitor.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    await adapter.searchProducts?.("ndc", "58151-155-77", 1);

    const [url] = requests(fetchMock);
    const search = searchOf(url as URL);
    expect(search).toContain("package_ndc:58151-155-77");
    expect(search).toContain("product_ndc:58151-155");
    expect(search).not.toContain("finished:true");
  });

  it("queries a product-level NDC directly", async () => {
    const { client, fetchMock } = clientFor(
      routeTo("/drug/ndc.json", fixture("ndc-brand-lipitor.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    await adapter.searchProducts?.("ndc", "58151-155", 1);

    const [url] = requests(fetchMock);
    const search = searchOf(url as URL);
    expect(search).toContain("product_ndc:58151-155");
    expect(search).not.toContain("package_ndc:");
  });

  it("extracts NDC candidates from a drug barcode", async () => {
    const { client, fetchMock } = clientFor(
      routeTo("/drug/ndc.json", fixture("ndc-brand-lipitor.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    await adapter.searchProducts?.("barcode", "358151155774", 1);

    const [url] = requests(fetchMock);
    expect(searchOf(url as URL)).toContain("package_ndc:58151-155-77");
  });

  it("returns an empty group without a request for non-drug codes", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createOpenFdaAdapter(client);

    const barcode = await adapter.searchProducts?.(
      "barcode",
      "012345678905",
      1,
    );
    const ndc = await adapter.searchProducts?.("ndc", "not-an-ndc", 1);

    expect(barcode).toEqual([
      { source: "openFDA", items: [], page: 1, hasMore: false },
    ]);
    expect(ndc).toEqual([
      { source: "openFDA", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty group for a blank text query without a request", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createOpenFdaAdapter(client);

    const groups = await adapter.searchProducts?.("name", "   ", 1);

    expect(groups).toEqual([
      { source: "openFDA", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pages with a skip and reports hasMore at the page size", async () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      product_ndc: `0000${index}-000`,
      generic_name: `Drug ${index}`,
    }));
    const { client, fetchMock } = clientFor(() =>
      jsonResponse({
        meta: { results: { skip: 20, limit: 20, total: 40 } },
        results,
      }),
    );
    const adapter = createOpenFdaAdapter(client);

    const [group] = (await adapter.searchProducts?.("name", "drug", 2)) ?? [];

    expect(group?.page).toBe(2);
    expect(group?.items).toHaveLength(20);
    expect(group?.hasMore).toBe(true);
    const [url] = requests(fetchMock);
    expect(url?.searchParams.get("skip")).toBe("20");
    expect(url?.searchParams.get("limit")).toBe("20");
  });

  it("turns a zero-match 404 into an empty group", async () => {
    const { client } = clientFor(notFound);
    const adapter = createOpenFdaAdapter(client);

    const groups = await adapter.searchProducts?.("name", "zzzz", 1);

    expect(groups).toEqual([
      { source: "openFDA", items: [], page: 1, hasMore: false },
    ]);
  });

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
          "@knorby/openfda-client failed at https://api.fda.gov/?api_key=secret",
        );
      },
      /did not return a usable response/,
    ],
  ])("sanitizes a %s", async (_label, response, message) => {
    const { client } = clientFor(response);
    const adapter = createOpenFdaAdapter(client);

    const failure = adapter.searchProducts?.("name", "Lipitor", 1);

    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.not.toThrow(/@knorby|api_key|secret/);
  });
});

describe("openFDA ingredient search", () => {
  it("maps a UNII hit with CAS, INCI, and a deep link", async () => {
    const { client, fetchMock } = clientFor(
      routeTo("/other/substance.json", fixture("substance-unii-glycerin.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    const groups = await adapter.searchIngredients?.("unii", "PDC6A3C0OX", 1);

    expect(groups).toHaveLength(1);
    const group = groups?.[0];
    expect(group?.source).toBe("openFDA");
    expect(group?.hasMore).toBe(false);
    expect(group?.items).toHaveLength(1);
    const item = group?.items[0];
    expect(item?.name).toBe("Glycerin");
    expect(item?.inciName).toBe("Glycerin");
    expect(item?.identifiers.unii).toBe("PDC6A3C0OX");
    expect(item?.identifiers.cas).toEqual(["56-81-5"]);
    expect(item?.matchBasis).toBeUndefined();
    expect(item?.source.database).toBe("openFDA");
    expect(item?.source.id).toBe("PDC6A3C0OX");
    expect(item?.source.url).toMatch(
      /^https:\/\/api\.fda\.gov\/other\/substance\.json\?search=/,
    );
    expect(decodeURIComponent(item?.source.url ?? "")).toContain(
      'unii:"PDC6A3C0OX"',
    );

    const [url] = requests(fetchMock);
    expect(url?.pathname).toBe("/other/substance.json");
    expect(searchOf(url as URL)).toContain("unii:PDC6A3C0OX");
  });

  it("searches CAS numbers through substance codes", async () => {
    const { client, fetchMock } = clientFor(
      routeTo("/other/substance.json", fixture("substance-cas-glycerin.json")),
    );
    const adapter = createOpenFdaAdapter(client);

    const groups = await adapter.searchIngredients?.("cas", "56-81-5", 1);

    expect(groups?.[0]?.items[0]?.identifiers.unii).toBe("PDC6A3C0OX");
    const [url] = requests(fetchMock);
    const search = searchOf(url as URL);
    expect(search).toContain("codes.code:");
    expect(search).toContain("codes.code_system:CAS");
  });

  it.each(["unii", "cas"] as const)(
    "turns a zero-match %s 404 into an empty group",
    async (type) => {
      const { client } = clientFor(notFound);
      const adapter = createOpenFdaAdapter(client);

      const groups = await adapter.searchIngredients?.(type, "NOPE", 1);

      expect(groups).toEqual([
        { source: "openFDA", items: [], page: 1, hasMore: false },
      ]);
    },
  );

  it("maps minimal substance records and skips nameless ones", async () => {
    const body = {
      meta: { results: { skip: 0, limit: 20, total: 3 } },
      results: [
        { unii: "AAAAAAAAAA" },
        { names: [{ name: "No UNII" }] },
        {
          unii: "BBBBBBBBBB",
          names: [{}, { name: "" }],
          codes: [
            { code: "56-81-5" },
            { code_system: "CAS" },
            { code: "999-99-9", code_system: "CAS" },
          ],
        },
      ] satisfies Substance[],
    };
    const { client } = clientFor(() => jsonResponse(body));
    const adapter = createOpenFdaAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("unii", "AAAAAAAAAA", 1)) ?? [];

    expect(group?.items).toHaveLength(2);
    expect(group?.items[0]?.name).toBe("AAAAAAAAAA");
    expect(group?.items[0]?.inciName).toBeUndefined();
    expect(group?.items[0]?.identifiers).toEqual({ unii: "AAAAAAAAAA" });
    expect(group?.items[1]?.name).toBe("BBBBBBBBBB");
    expect(group?.items[1]?.identifiers.cas).toEqual(["999-99-9"]);
  });

  it("returns an empty group for a blank query without a request", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createOpenFdaAdapter(client);

    const groups = await adapter.searchIngredients?.("name", "   ", 1);

    expect(groups).toEqual([
      { source: "openFDA", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ranks name hits by INCI, exact, then prefix match", async () => {
    const crosswalk = fixture("unii-crosswalk-glycerin.json");
    const substances: Record<string, Substance | "empty" | null> = {
      "42ESM1DR47": {
        unii: "42ESM1DR47",
        names: [{ name: "GLYCERIN METHYL ETHER" }],
      },
      "587WKM3S9Q": null,
      N7YC58165T: {
        unii: "N7YC58165T",
        names: [{ name: "Glycerin", name_orgs: [{ name_org: "INCI" }] }],
      },
      "7QQ1EE6RCP": "empty",
      "913VR40115": {
        unii: "913VR40115",
        names: [{ name: "PEG/PPG-60/11 GLYCERIN" }],
      },
    };

    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/other/unii.json") return jsonResponse(crosswalk);
      if (url.pathname !== "/other/substance.json") return notFound();
      const search = searchOf(url);
      const unii = search.replace(/^unii:/, "");
      const record = substances[unii];
      if (record === null) return notFound();
      const results = record === "empty" ? [] : [record];
      return jsonResponse({
        meta: { results: { skip: 0, limit: 1, total: results.length } },
        results,
      });
    });
    const adapter = createOpenFdaAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "GLYCERIN", 2)) ?? [];

    expect(group?.items.map((item) => item.identifiers.unii)).toEqual([
      "N7YC58165T",
      "42ESM1DR47",
      "913VR40115",
    ]);
    expect(group?.items.map((item) => item.matchBasis)).toEqual([
      "INCI name match",
      "name prefix match",
      "name differs from query",
    ]);
    expect(group?.page).toBe(2);
    expect(group?.hasMore).toBe(true);

    const urls = requests(fetchMock);
    expect(urls[0]?.pathname).toBe("/other/unii.json");
    expect(urls[0]?.searchParams.get("skip")).toBe("5");
    expect(urls[0]?.searchParams.get("limit")).toBe("5");
  });

  it("skips crosswalk entries without a UNII and missing substance records", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/other/unii.json") {
        return jsonResponse({
          meta: { results: { skip: 0, limit: 5, total: 3 } },
          results: [
            { substance_name: "NO UNII" },
            { substance_name: "MISSING", unii: "AAAAAAAAAA" },
            { substance_name: "NO NAME", unii: "BBBBBBBBBB" },
          ],
        });
      }
      return notFound();
    });
    const adapter = createOpenFdaAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("inci", "GLYCERIN", 1)) ?? [];

    expect(group?.items).toEqual([]);
    expect(group?.hasMore).toBe(false);
    const urls = requests(fetchMock);
    expect(urls).toHaveLength(3);
    expect(urls[1]?.searchParams.get("search")).toContain("AAAAAAAAAA");
    expect(urls[2]?.searchParams.get("search")).toContain("BBBBBBBBBB");
  });

  it("turns a zero-match crosswalk into an empty group", async () => {
    const { client, fetchMock } = clientFor(notFound);
    const adapter = createOpenFdaAdapter(client);

    const groups = await adapter.searchIngredients?.("name", "nothing", 1);

    expect(groups).toEqual([
      { source: "openFDA", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["direct ingredient", "unii", 503, /temporarily unavailable/],
    ["crosswalk", "name", 400, /rejected the request/],
  ] as const)(
    "sanitizes a %s failure",
    async (_label, type, status, message) => {
      const { client } = clientFor(() => new Response(null, { status }));
      const adapter = createOpenFdaAdapter(client);

      const failure = adapter.searchIngredients?.(type, "GLYCERIN", 1);

      await expect(failure).rejects.toThrow(message);
      await expect(failure).rejects.not.toThrow(/@knorby|api_key/);
    },
  );

  it("sanitizes a per-UNII failure", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/other/unii.json") {
        return jsonResponse({
          meta: { results: { skip: 0, limit: 5, total: 1 } },
          results: [{ substance_name: "GLYCERIN", unii: "AAAAAAAAAA" }],
        });
      }
      return new Response(null, { status: 429 });
    });
    const adapter = createOpenFdaAdapter(client);

    await expect(
      adapter.searchIngredients?.("name", "GLYCERIN", 1),
    ).rejects.toThrow(/rate limited/);
  });
});

describe("openFDA substance ranking", () => {
  const records: Substance[] = [
    { unii: "PREFIX", names: [{ name: "GLYCERIN METHYL ETHER" }] },
    { unii: "EXACT", names: [{ name: "GLYCERIN" }] },
    {
      unii: "INCI",
      names: [{ name: "Glycerin", name_orgs: [{ name_org: "INCI" }] }],
    },
    { unii: "NONE", names: [{ name: "WATER" }] },
    { unii: "EMPTY", names: [{}] },
    { unii: "NO_NAMES" },
  ];

  it("classifies every match tier", () => {
    expect(matchSubstanceTier(records[0] as Substance, "glycerin")).toBe(
      "prefix",
    );
    expect(matchSubstanceTier(records[1] as Substance, "glycerin")).toBe(
      "exact",
    );
    expect(matchSubstanceTier(records[2] as Substance, "glycerin")).toBe(
      "inci",
    );
    expect(matchSubstanceTier(records[3] as Substance, "glycerin")).toBe(
      "none",
    );
    expect(matchSubstanceTier(records[4] as Substance, "glycerin")).toBe(
      "none",
    );
    expect(matchSubstanceTier(records[5] as Substance, "glycerin")).toBe(
      "none",
    );
    expect(matchSubstanceTier(records[4] as Substance, "  ")).toBe("none");
  });

  it("orders matches without dropping unmatched records", () => {
    expect(rankSubstances(records, "glycerin").map((r) => r.unii)).toEqual([
      "INCI",
      "EXACT",
      "PREFIX",
      "NONE",
      "EMPTY",
      "NO_NAMES",
    ]);
  });
});
