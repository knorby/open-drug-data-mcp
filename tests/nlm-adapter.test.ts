import { readFileSync } from "node:fs";
import { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import { describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import {
  createNlmAdapter,
  createNlmBridges,
  failedProductGroup,
  ndcSearchCandidates,
  nlmAdapter,
  nlmBridges,
} from "../src/sources/nlm.js";
import { jsonResponse } from "./helpers.js";

/**
 * The NLM adapter is tested through the client's injectable `fetch`.
 *
 * Every fixture under `tests/fixtures/nlm/` is a live response captured from
 * RxNav/RxNorm and DailyMed on 2026-10-22, including a small SPL document.
 * The adapter must never surface client-library names, URLs, or keys, and a
 * zero-match lookup is an ordinary empty group in either database.
 */

const FIXTURES = new URL("./fixtures/nlm/", import.meta.url);

/** Reads a JSON fixture. */
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

/** Reads a text fixture. */
function textFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Builds a client whose fetch routes every request through `handler`. */
function clientFor(handler: Handler) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new URL(String(input)), init),
  );
  const client = new NlmDrugsClient({
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

/** All request URLs the client's fetch stub saw. */
function requests(fetchMock: {
  mock: { calls: [RequestInfo | URL, RequestInit?][] };
}): URL[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)));
}

/** A JSON response for a captured fixture. */
function fixtureResponse(name: string): Response {
  return jsonResponse(fixture(name));
}

/** The ISO timestamp shape every source ref must carry. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The RxNorm concept fixture most tests resolve to. */
const CONCEPT_83367 = "rxnorm-concept-83367.json";

describe("NLM adapter capabilities", () => {
  it("surfaces an internal subgroup observer failure", async () => {
    const adapter = createNlmAdapter(clientFor(() => jsonResponse({})).client);
    const error = new Error("observer failed");
    await expect(
      adapter.searchProducts?.("name", "aspirin", 1, undefined, () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
  it("validates direct concepts with RxNorm and preserves missing/error distinctions", async () => {
    const found = createNlmBridges(
      clientFor(() => fixtureResponse(CONCEPT_83367)).client,
    );
    expect(await found.conceptByRxcui("83367")).toMatchObject({
      name: "atorvastatin",
      identifiers: { rxcui: ["83367"] },
    });
    expect(await found.conceptByRxcui("bad")).toBeNull();
    const missing = createNlmBridges(clientFor(() => jsonResponse({})).client);
    expect(await missing.conceptByRxcui("999999999")).toBeNull();
    const broken = createNlmBridges(
      clientFor(() => new Response(null, { status: 503 })).client,
    );
    await expect(broken.conceptByRxcui("83367")).rejects.toThrow(/RxNorm/);
  });
  it("declares the briefed id, databases, search types, and category", () => {
    expect(nlmAdapter.id).toBe("nlm");
    expect(nlmAdapter.databases).toEqual(["RxNorm", "DailyMed"]);
    expect(nlmAdapter.productSearchTypes).toEqual(["name", "ndc"]);
    expect(nlmAdapter.ingredientSearchTypes).toEqual(["name", "unii", "rxcui"]);
    expect(nlmAdapter.productCategories).toEqual(["medication"]);
    expect(nlmAdapter.searchProducts).toBeTypeOf("function");
    expect(nlmAdapter.searchIngredients).toBeTypeOf("function");
  });

  it("defaults to the shared NLM client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/153165/properties.json") {
        return fixtureResponse("rxnorm-concept-153165.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse("dailymed-spls-rxcui-lipitor.json");
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      const groups = await nlmAdapter.searchProducts?.("name", "Lipitor", 1);

      expect(groups).toHaveLength(2);
      expect(groups?.[0]?.items).toHaveLength(1);
      expect(groups?.[1]?.items).toHaveLength(2);
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});

describe("NLM product search by name", () => {
  it("maps RxNorm and DailyMed groups with identifiers and deep links", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/153165/properties.json") {
        return fixtureResponse("rxnorm-concept-153165.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse("dailymed-spls-rxcui-lipitor.json");
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("name", "Lipitor", 1);

    expect(groups).toHaveLength(2);
    const [rxnorm, dailymed] = groups ?? [];
    expect(rxnorm?.source).toBe("RxNorm");
    expect(rxnorm?.page).toBe(1);
    expect(rxnorm?.hasMore).toBe(false);
    expect(rxnorm?.error).toBeUndefined();
    expect(rxnorm?.items).toHaveLength(1);
    const product = rxnorm?.items[0];
    expect(product?.name).toBe("Lipitor");
    expect(product?.category).toBe("medication");
    expect(product?.identifiers).toEqual({ rxcui: ["153165"] });
    expect(product?.source.database).toBe("RxNorm");
    expect(product?.source.id).toBe("153165");
    expect(product?.source.url).toBe(
      "https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=153165",
    );
    expect(product?.source.retrievedAt).toMatch(ISO);

    expect(dailymed?.source).toBe("DailyMed");
    expect(dailymed?.page).toBe(1);
    expect(dailymed?.hasMore).toBe(true);
    expect(dailymed?.items).toHaveLength(2);
    const first = dailymed?.items[0];
    expect(first?.name).toBe(
      "LIPITOR (ATORVASTATIN CALCIUM) TABLET, FILM COATED [VIATRIS SPECIALTY LLC]",
    );
    expect(first?.category).toBe("medication");
    expect(first?.identifiers).toEqual({
      splSetId: "a60cc18b-0631-4cf0-b021-9f52224ece65",
    });
    expect(first?.summary).toBe("SPL version 8 · published Jul 15, 2026");
    expect(first?.source.database).toBe("DailyMed");
    expect(first?.source.id).toBe("a60cc18b-0631-4cf0-b021-9f52224ece65");
    expect(first?.source.url).toBe(
      "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=a60cc18b-0631-4cf0-b021-9f52224ece65",
    );
    expect(first?.source.retrievedAt).toMatch(ISO);
    expect(dailymed?.items[1]?.source.id).toBe(
      "10a7ba02-42d6-4cae-8904-b256e2da5496",
    );

    const urls = requests(fetchMock);
    const rxName = urls.find((url) => url.pathname === "/REST/rxcui.json");
    expect(rxName?.searchParams.get("name")).toBe("Lipitor");
    const dm = urls.find(
      (url) => url.pathname === "/dailymed/services/v2/spls.json",
    );
    expect(dm?.searchParams.get("drug_name")).toBe("Lipitor");
    expect(dm?.searchParams.get("page")).toBe("1");
    expect(dm?.searchParams.get("pagesize")).toBe("20");
    expect(JSON.stringify(groups)).not.toMatch(
      /@knorby|nlm-drugs-client|client library/i,
    );
  });

  it("returns both empty groups for a blank query without a request", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("name", "   ", 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
      { source: "DailyMed", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns both empty groups when neither database matches", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-unknown.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse("dailymed-spls-empty.json");
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("name", "zzzznotadrug", 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
      { source: "DailyMed", items: [], page: 1, hasMore: false },
    ]);
  });

  it("pages RxNorm concepts and reports DailyMed hasMore", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => String(100 + index));
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return jsonResponse({ idGroup: { rxnormId: ids } });
      }
      const concept = /^\/REST\/rxcui\/(\d+)\/properties\.json$/.exec(
        url.pathname,
      );
      if (concept !== null) {
        const rxcui = concept[1] as string;
        return jsonResponse({
          properties: { rxcui, name: `Concept ${rxcui}`, tty: "IN" },
        });
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse("dailymed-spls-empty.json");
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("name", "anything", 2);

    const [rxnorm, dailymed] = groups ?? [];
    expect(rxnorm?.page).toBe(2);
    expect(rxnorm?.items).toHaveLength(1);
    expect(rxnorm?.items[0]?.name).toBe("Concept 120");
    expect(rxnorm?.hasMore).toBe(false);
    expect(dailymed?.page).toBe(2);
    expect(dailymed?.items).toEqual([]);

    const conceptRequests = requests(fetchMock).filter((url) =>
      url.pathname.endsWith("/properties.json"),
    );
    expect(conceptRequests).toHaveLength(1);
    expect(conceptRequests[0]?.pathname).toBe(
      "/REST/rxcui/120/properties.json",
    );
  });

  it("pages both databases independently on page two", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/153165/properties.json") {
        return fixtureResponse("rxnorm-concept-153165.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse(
          url.searchParams.get("page") === "2"
            ? "dailymed-spls-rxcui-lipitor-page2.json"
            : "dailymed-spls-rxcui-lipitor.json",
        );
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("name", "Lipitor", 2);

    const [rxnorm, dailymed] = groups ?? [];
    expect(rxnorm?.items).toEqual([]);
    expect(rxnorm?.hasMore).toBe(false);
    expect(dailymed?.page).toBe(2);
    expect(dailymed?.items).toHaveLength(1);
    expect(dailymed?.items[0]?.source.id).toBe(
      "a3c08a6d-f986-4efc-9f96-3f0e652704dc",
    );
    expect(dailymed?.hasMore).toBe(false);
  });

  it("drops malformed concepts and falls back to the RxCUI as a name", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return jsonResponse({ idGroup: { rxnormId: ["111", "222"] } });
      }
      if (url.pathname === "/REST/rxcui/111/properties.json") {
        return jsonResponse({
          properties: { rxcui: "", name: "Ghost", tty: "IN" },
        });
      }
      if (url.pathname === "/REST/rxcui/222/properties.json") {
        return jsonResponse({
          properties: { rxcui: "222", name: "", tty: "IN" },
        });
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse("dailymed-spls-empty.json");
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const [rxnorm] = (await adapter.searchProducts?.("name", "x", 1)) ?? [];

    expect(rxnorm?.items).toHaveLength(1);
    expect(rxnorm?.items[0]?.name).toBe("222");
    expect(rxnorm?.items[0]?.identifiers.rxcui).toEqual(["222"]);
  });

  it("drops DailyMed entries without a set id and deduplicates repeats", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-unknown.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return jsonResponse({
          data: [
            { setid: "", title: "No id", spl_version: 1 },
            {
              setid: "duplicate",
              title: "First",
              spl_version: 2,
              published_date: "Jan 1, 2020",
            },
            { setid: "duplicate", title: "Second", spl_version: 3 },
            { setid: "untitled", title: "", spl_version: 4 },
          ],
          metadata: {
            current_page: 1,
            total_pages: 1,
            next_page: "null",
          },
        });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const [, dailymed] = (await adapter.searchProducts?.("name", "x", 1)) ?? [];

    expect(dailymed?.items).toHaveLength(2);
    expect(dailymed?.items[0]?.name).toBe("First");
    expect(dailymed?.items[0]?.summary).toBe(
      "SPL version 2 · published Jan 1, 2020",
    );
    expect(dailymed?.items[1]?.name).toBe("untitled");
    expect(dailymed?.items[1]?.summary).toBe("SPL version 4");
  });
});

describe("NLM product search by NDC", () => {
  it("uses 21 RxNorm requests for 20 concepts and retains only the anchor NDC", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => String(100 + index));
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return jsonResponse({ idGroup: { rxnormId: ids } });
      }
      const concept = /^\/REST\/rxcui\/(\d+)\/properties\.json$/.exec(
        url.pathname,
      );
      if (concept) {
        return jsonResponse({
          properties: {
            rxcui: concept[1],
            name: `Concept ${concept[1]}`,
            tty: "SCD",
          },
        });
      }
      if (url.pathname.endsWith("/ndcs.json")) {
        return fixtureResponse("rxnorm-ndcs-617314.json");
      }
      return fixtureResponse("dailymed-spls-empty.json");
    });
    const [group] =
      (await createNlmAdapter(client).searchProducts?.(
        "ndc",
        "58151-155-77",
        1,
      )) ?? [];
    expect(group?.items).toHaveLength(20);
    for (const item of group?.items ?? []) {
      expect(item.identifiers.ndc).toEqual(["58151015577"]);
    }
    const rxRequests = requests(fetchMock).filter((url) =>
      url.pathname.startsWith("/REST/"),
    );
    expect(rxRequests).toHaveLength(21);
    expect(rxRequests.some((url) => url.pathname.endsWith("/ndcs.json"))).toBe(
      false,
    );
  });

  it("resolves both databases and probes labeler spellings", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-ndc-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/617314/properties.json") {
        return fixtureResponse("rxnorm-concept-617314.json");
      }
      if (url.pathname === "/REST/rxcui/617314/ndcs.json") {
        return fixtureResponse("rxnorm-ndcs-617314.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse(
          url.searchParams.get("ndc") === "58151-155-77"
            ? "dailymed-spls-ndc-lipitor.json"
            : "dailymed-spls-empty.json",
        );
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("ndc", "58151-155-77", 1);

    const [rxnorm, dailymed] = groups ?? [];
    expect(rxnorm?.items).toHaveLength(1);
    const product = rxnorm?.items[0];
    expect(product?.name).toBe("atorvastatin 10 MG Oral Tablet [Lipitor]");
    expect(product?.identifiers.rxcui).toEqual(["617314"]);
    expect(product?.identifiers.ndc).toEqual(["58151015577"]);
    expect(dailymed?.items).toHaveLength(1);
    expect(dailymed?.items[0]?.identifiers.splSetId).toBe(
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
    );

    const urls = requests(fetchMock);
    const rx = urls.find((url) => url.pathname === "/REST/rxcui.json");
    expect(rx?.searchParams.get("idtype")).toBe("NDC");
    expect(rx?.searchParams.get("id")).toBe("58151015577");
    const dmNdcs = urls
      .filter(
        (url) =>
          url.pathname === "/dailymed/services/v2/spls.json" &&
          url.searchParams.has("ndc"),
      )
      .map((url) => url.searchParams.get("ndc"));
    expect(dmNdcs).toContain("58151-0155-77");
    expect(dmNdcs).toContain("58151-155-77");
  });

  it("returns empty groups for an unusable NDC without a request", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("ndc", "not-an-ndc", 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
      { source: "DailyMed", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty groups past the last page", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-ndc-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/617314/properties.json") {
        return fixtureResponse("rxnorm-concept-617314.json");
      }
      if (url.pathname === "/REST/rxcui/617314/ndcs.json") {
        return fixtureResponse("rxnorm-ndcs-617314.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse(
          url.searchParams.get("ndc") === "58151-155-77"
            ? "dailymed-spls-ndc-page2.json"
            : "dailymed-spls-empty.json",
        );
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("ndc", "58151-155-77", 2);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 2, hasMore: false },
      { source: "DailyMed", items: [], page: 2, hasMore: false },
    ]);
  });

  it("returns an empty DailyMed group when no NDC spelling matches", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-ndc-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/617314/properties.json") {
        return fixtureResponse("rxnorm-concept-617314.json");
      }
      if (url.pathname === "/REST/rxcui/617314/ndcs.json") {
        return fixtureResponse("rxnorm-ndcs-617314.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse("dailymed-spls-empty.json");
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const [rxnorm, dailymed] =
      (await adapter.searchProducts?.("ndc", "58151-155-77", 1)) ?? [];

    expect(rxnorm?.items).toHaveLength(1);
    expect(dailymed).toEqual({
      source: "DailyMed",
      items: [],
      page: 1,
      hasMore: false,
    });
  });

  it("sanitizes an RxNorm failure during an NDC search", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/REST/rxcui.json"
        ? new Response(null, { status: 503 })
        : fixtureResponse("dailymed-spls-empty.json"),
    );
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("ndc", "58151-155-77", 1);

    expect(groups?.[0]?.source).toBe("RxNorm");
    expect(groups?.[0]?.error).toMatch(/RxNorm returned HTTP 503/);
    expect(groups?.[1]?.source).toBe("DailyMed");
    expect(groups?.[1]?.error).toBeUndefined();
  });

  it("sanitizes a DailyMed failure during an NDC search", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-ndc-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/617314/properties.json") {
        return fixtureResponse("rxnorm-concept-617314.json");
      }
      if (url.pathname === "/REST/rxcui/617314/ndcs.json") {
        return fixtureResponse("rxnorm-ndcs-617314.json");
      }
      return new Response(null, { status: 503 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("ndc", "58151-155-77", 1);

    expect(groups?.[0]?.source).toBe("RxNorm");
    expect(groups?.[0]?.error).toBeUndefined();
    expect(groups?.[1]?.source).toBe("DailyMed");
    expect(groups?.[1]?.error).toMatch(/DailyMed returned HTTP 503/);
  });

  it("returns empty groups for an unsupported product search type", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("brand", "Lipitor", 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
      { source: "DailyMed", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("NLM ingredient search", () => {
  it("maps an exact name match with a match basis", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-atorvastatin.json");
      }
      if (url.pathname === "/REST/rxcui/83367/properties.json") {
        return fixtureResponse(CONCEPT_83367);
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("name", "atorvastatin", 1);

    expect(groups).toHaveLength(1);
    const group = groups?.[0];
    expect(group?.source).toBe("RxNorm");
    expect(group?.page).toBe(1);
    expect(group?.hasMore).toBe(false);
    expect(group?.items).toHaveLength(1);
    const item = group?.items[0];
    expect(item?.name).toBe("atorvastatin");
    expect(item?.identifiers).toEqual({ rxcui: ["83367"] });
    expect(item?.matchBasis).toBe("name match");
    expect(item?.source.database).toBe("RxNorm");
    expect(item?.source.id).toBe("83367");
    expect(item?.source.url).toBe(
      "https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=83367",
    );
    expect(item?.source.retrievedAt).toMatch(ISO);

    const [url] = requests(fetchMock);
    expect(url?.searchParams.get("name")).toBe("atorvastatin");
  });

  it("drops malformed ingredient concepts and falls back to the RxCUI name", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return jsonResponse({ idGroup: { rxnormId: ["111", "222", "333"] } });
      }
      if (url.pathname === "/REST/rxcui/111/properties.json") {
        return jsonResponse({});
      }
      if (url.pathname === "/REST/rxcui/222/properties.json") {
        return jsonResponse({
          properties: { rxcui: "", name: "Ghost", tty: "IN" },
        });
      }
      if (url.pathname === "/REST/rxcui/333/properties.json") {
        return jsonResponse({
          properties: { rxcui: "333", name: "", tty: "IN" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const [group] = (await adapter.searchIngredients?.("name", "x", 1)) ?? [];

    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]?.name).toBe("333");
    expect(group?.items[0]?.identifiers.rxcui).toEqual(["333"]);
  });

  it("falls back to approximate matches and deduplicates by RxCUI", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (
        url.pathname === "/REST/rxcui.json" &&
        url.searchParams.get("name") === "atorvastatn"
      ) {
        return fixtureResponse("rxnorm-name-unknown.json");
      }
      if (url.pathname === "/REST/approximateTerm.json") {
        return fixtureResponse("rxnorm-approximate-atorvastatin.json");
      }
      if (url.pathname === "/REST/rxcui/83367/properties.json") {
        return fixtureResponse(CONCEPT_83367);
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("name", "atorvastatn", 1);

    const group = groups?.[0];
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]?.name).toBe("ATORVASTATIN");
    expect(group?.items[0]?.identifiers.rxcui).toEqual(["83367"]);
    expect(group?.items[0]?.matchBasis).toBe("approximate name match");
    const conceptRequests = requests(fetchMock).filter((url) =>
      url.pathname.endsWith("/properties.json"),
    );
    expect(conceptRequests).toHaveLength(0);
    expect(requests(fetchMock)).toHaveLength(2);
  });

  it("uses two requests for ten approximate candidates without concept hydration", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      rxcui: String(100 + index),
      name: `Candidate ${index}`,
      rxaui: String(index),
      score: "1",
      rank: "1",
    }));
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json")
        return fixtureResponse("rxnorm-name-unknown.json");
      if (url.pathname === "/REST/approximateTerm.json")
        return jsonResponse({ approximateGroup: { candidate: candidates } });
      const id = url.pathname.split("/")[3];
      return jsonResponse({
        properties: { rxcui: id, name: `Hydrated ${id}`, tty: "IN" },
      });
    });
    const [group] =
      (await createNlmAdapter(client).searchIngredients?.(
        "name",
        "candidate",
        1,
      )) ?? [];
    expect(group?.items.map((item) => item.name)).toEqual(
      candidates.map((item) => item.name),
    );
    expect(
      group?.items.every(
        (item) =>
          item.source.database === "RxNorm" &&
          item.matchBasis === "approximate name match",
      ),
    ).toBe(true);
    expect(requests(fetchMock)).toHaveLength(2);
  });

  it("uses an approximate match name without needing a concept", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-unknown.json");
      }
      if (url.pathname === "/REST/approximateTerm.json") {
        return fixtureResponse("rxnorm-approximate-atorvastatin.json");
      }
      if (url.pathname === "/REST/rxcui/83367/properties.json") {
        return jsonResponse({});
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "atorvastatn", 1)) ?? [];

    expect(group?.items[0]?.name).toBe("ATORVASTATIN");
    expect(group?.items[0]?.identifiers.rxcui).toEqual(["83367"]);
  });

  it("drops empty approximate ids and retains named and unnamed candidates", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-unknown.json");
      }
      if (url.pathname === "/REST/approximateTerm.json") {
        return jsonResponse({
          approximateGroup: {
            candidate: [
              { rxcui: "", rxaui: "1", score: "1", rank: "1", name: "Bad" },
              {
                rxcui: "83367",
                rxaui: "2",
                score: "1",
                rank: "1",
                name: "ATV",
              },
              {
                rxcui: "999",
                rxaui: "3",
                score: "0.5",
                rank: "2",
                name: "Ghost",
              },
              { rxcui: "888", rxaui: "4", score: "0.5", rank: "3" },
            ],
          },
        });
      }
      if (url.pathname === "/REST/rxcui/83367/properties.json") {
        return jsonResponse({});
      }
      if (url.pathname === "/REST/rxcui/999/properties.json") {
        return jsonResponse({
          properties: { rxcui: "", name: "Ghost", tty: "IN" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const [group] =
      (await adapter.searchIngredients?.("name", "atorvastatn", 1)) ?? [];

    expect(group?.items).toHaveLength(3);
    expect(group?.items[0]?.name).toBe("ATV");
    expect(group?.items[0]?.identifiers.rxcui).toEqual(["83367"]);
    expect(group?.items[1]?.identifiers.rxcui).toEqual(["999"]);
    expect(group?.items[2]?.name).toBe("888");
  });

  it("maps a UNII lookup and uppercases the identifier", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-unii-atorvastatin.json");
      }
      if (url.pathname === "/REST/rxcui/83367/properties.json") {
        return fixtureResponse(CONCEPT_83367);
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("unii", "a0jwa85v8f", 1);

    const group = groups?.[0];
    expect(group?.items[0]?.identifiers).toEqual({
      unii: "A0JWA85V8F",
      rxcui: ["83367"],
    });
    expect(group?.items[0]?.matchBasis).toBe("UNII match");
    const [url] = requests(fetchMock);
    expect(url?.searchParams.get("idtype")).toBe("UNII_CODE");
    expect(url?.searchParams.get("id")).toBe("A0JWA85V8F");
  });

  it("drops malformed concepts from a UNII lookup", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return jsonResponse({ idGroup: { rxnormId: ["111", "222"] } });
      }
      if (url.pathname === "/REST/rxcui/111/properties.json") {
        return jsonResponse({});
      }
      if (url.pathname === "/REST/rxcui/222/properties.json") {
        return jsonResponse({
          properties: { rxcui: "", name: "Ghost", tty: "IN" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("unii", "A0JWA85V8F", 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
    ]);
  });

  it("returns an empty group for an invalid UNII without a request", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("unii", "not-a-unii", 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a direct RxCUI lookup and ignores later pages", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui/83367/properties.json") {
        return fixtureResponse(CONCEPT_83367);
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const first = await adapter.searchIngredients?.("rxcui", "83367", 1);
    const second = await adapter.searchIngredients?.("rxcui", "83367", 2);

    expect(first?.[0]?.items).toHaveLength(1);
    expect(first?.[0]?.items[0]?.name).toBe("atorvastatin");
    expect(first?.[0]?.items[0]?.matchBasis).toBeUndefined();
    expect(second?.[0]).toEqual({
      source: "RxNorm",
      items: [],
      page: 2,
      hasMore: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a non-numeric RxCUI", "abc"],
    ["an unknown RxCUI", "999999999"],
  ])("returns an empty group for %s", async (_label, query) => {
    const { client } = clientFor((url) =>
      url.pathname.endsWith("/properties.json")
        ? jsonResponse({})
        : new Response(null, { status: 404 }),
    );
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("rxcui", query, 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
    ]);
  });

  it("returns an empty group when name and approximate searches miss", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-unknown.json");
      }
      if (url.pathname === "/REST/approximateTerm.json") {
        return fixtureResponse("rxnorm-approximate-empty.json");
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("name", "zzzznotadrug", 1);

    expect(groups).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
    ]);
  });

  it("pages exact concepts", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => String(200 + index));
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        return jsonResponse({ idGroup: { rxnormId: ids } });
      }
      const concept = /^\/REST\/rxcui\/(\d+)\/properties\.json$/.exec(
        url.pathname,
      );
      if (concept !== null) {
        const rxcui = concept[1] as string;
        return jsonResponse({
          properties: { rxcui, name: `Ingredient ${rxcui}`, tty: "IN" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchIngredients?.("name", "anything", 2);

    const group = groups?.[0];
    expect(group?.page).toBe(2);
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]?.name).toBe("Ingredient 220");
    expect(group?.hasMore).toBe(false);
  });

  it("returns an empty group for a blank query or unsupported type", async () => {
    const { client, fetchMock } = clientFor(() => jsonResponse({}));
    const adapter = createNlmAdapter(client);

    const blank = await adapter.searchIngredients?.("name", "   ", 1);
    const unsupported = await adapter.searchIngredients?.("cas", "64-17-5", 1);

    expect(blank).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
    ]);
    expect(unsupported).toEqual([
      { source: "RxNorm", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("NLM failure handling", () => {
  it("renders a non-Error rejection reason as text", () => {
    expect(failedProductGroup("RxNorm", 1, "raw failure")).toMatchObject({
      source: "RxNorm",
      error: "raw failure",
    });
  });

  it.each([
    ["429 rate limit", 429, /rate limited by RxNorm/],
    ["5xx outage", 503, /RxNorm returned HTTP 503/],
    ["4xx rejection", 404, /RxNorm rejected the request/],
  ])(
    "sanitizes a %s without failing the other group",
    async (_label, status, message) => {
      const { client } = clientFor((url) =>
        url.pathname === "/REST/rxcui.json"
          ? new Response(null, { status })
          : fixtureResponse("dailymed-spls-empty.json"),
      );
      const adapter = createNlmAdapter(client);

      const groups = await adapter.searchProducts?.("name", "Lipitor", 1);

      expect(groups?.[0]?.source).toBe("RxNorm");
      expect(groups?.[0]?.error).toMatch(message);
      expect(groups?.[0]?.error).not.toMatch(/@knorby|secret|api_key/);
      expect(groups?.[1]?.source).toBe("DailyMed");
      expect(groups?.[1]?.error).toBeUndefined();
    },
  );

  it("sanitizes a transport failure without naming the client", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        throw new Error(
          "@knorby/nlm-drugs-client failed at https://rxnav.nlm.nih.gov/?key=secret",
        );
      }
      return fixtureResponse("dailymed-spls-empty.json");
    });
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("name", "Lipitor", 1);

    expect(groups?.[0]?.error).toMatch(
      /The product search failed: RxNorm did not return a usable response/,
    );
    expect(groups?.[0]?.error).not.toMatch(/@knorby|secret/);
    expect(groups?.[1]?.source).toBe("DailyMed");
    expect(groups?.[1]?.error).toBeUndefined();
  });

  it("names DailyMed when only its request fails", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/dailymed/services/v2/spls.json"
        ? new Response(null, { status: 503 })
        : fixtureResponse("rxnorm-name-lipitor.json"),
    );
    const adapter = createNlmAdapter(client);

    const groups = await adapter.searchProducts?.("name", "Lipitor", 1);

    expect(groups?.[0]?.source).toBe("RxNorm");
    expect(groups?.[0]?.error).toBeUndefined();
    expect(groups?.[1]?.error).toMatch(
      /The product search failed: DailyMed returned HTTP 503/,
    );
  });

  it("sanitizes ingredient search failures", async () => {
    const { client } = clientFor(() => new Response(null, { status: 429 }));
    const adapter = createNlmAdapter(client);

    const failure = adapter.searchIngredients?.("name", "atorvastatin", 1);

    await expect(failure).rejects.toThrow(
      /The ingredient search was rate limited by RxNorm/,
    );
  });
});

describe("NLM abort signal", () => {
  it("forwards the signal to every request", async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const { client } = clientFor((url, init) => {
      signals.push(init?.signal);
      if (url.pathname === "/REST/rxcui.json") {
        return fixtureResponse("rxnorm-name-lipitor.json");
      }
      if (url.pathname === "/REST/rxcui/153165/properties.json") {
        return fixtureResponse("rxnorm-concept-153165.json");
      }
      if (url.pathname === "/dailymed/services/v2/spls.json") {
        return fixtureResponse("dailymed-spls-rxcui-lipitor.json");
      }
      return new Response(null, { status: 404 });
    });
    const adapter = createNlmAdapter(client);

    await adapter.searchProducts?.("name", "Lipitor", 1, controller.signal);

    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });
});

describe("NLM NDC candidate derivation", () => {
  it("builds the labeler spellings DailyMed may have indexed", () => {
    expect(ndcSearchCandidates("58151-155-77")).toEqual([
      "58151-0155-77",
      "58151-155-77",
    ]);
    expect(ndcSearchCandidates("0071-0157-23")).toEqual([
      "00071-0157-23",
      "00071-157-23",
      "0071-0157-23",
    ]);
    expect(ndcSearchCandidates("58151-155-07")).toEqual([
      "58151-0155-07",
      "58151-155-07",
      "58151-0155-7",
    ]);
    expect(ndcSearchCandidates("12345-6789-12")).toEqual(["12345-6789-12"]);
  });

  it("returns no candidates for an unusable NDC", () => {
    expect(ndcSearchCandidates("not-an-ndc")).toEqual([]);
  });
});

describe("NLM identifier bridges", () => {
  it("resolves RxCUIs for a UNII and an NDC", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.searchParams.get("idtype") === "UNII_CODE") {
        return fixtureResponse("rxnorm-unii-atorvastatin.json");
      }
      if (url.searchParams.get("idtype") === "NDC") {
        return fixtureResponse("rxnorm-ndc-lipitor.json");
      }
      return new Response(null, { status: 404 });
    });
    const bridges = createNlmBridges(client);

    await expect(bridges.rxcuisForUnii("a0jwa85v8f")).resolves.toEqual([
      "83367",
    ]);
    await expect(bridges.rxcuisForNdc("58151-155-77")).resolves.toEqual([
      "617314",
    ]);
    await expect(bridges.rxcuisForNdc("not-an-ndc")).resolves.toEqual([]);
    await expect(bridges.rxcuisForUnii("not-a-unii")).resolves.toEqual([]);

    const ndcQuery = requests(fetchMock).find(
      (url) => url.searchParams.get("idtype") === "NDC",
    );
    expect(ndcQuery?.searchParams.get("id")).toBe("58151015577");
  });

  it("resolves SPL set ids by NDC and RxCUI", async () => {
    const { client, fetchMock } = clientFor((url) => {
      if (url.searchParams.get("ndc") === "58151-0155-77") {
        return fixtureResponse("dailymed-spls-empty.json");
      }
      if (url.searchParams.get("ndc") === "58151-155-77") {
        return fixtureResponse("dailymed-spls-ndc-lipitor.json");
      }
      if (url.searchParams.get("rxcui") === "153165") {
        return fixtureResponse("dailymed-spls-rxcui-lipitor.json");
      }
      return jsonResponse({ data: [], metadata: {} });
    });
    const bridges = createNlmBridges(client);

    await expect(bridges.splsForNdc("58151-155-77")).resolves.toEqual([
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
    ]);
    await expect(bridges.splsForRxcui("153165")).resolves.toEqual([
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
      "10a7ba02-42d6-4cae-8904-b256e2da5496",
    ]);
    await expect(bridges.splsForRxcui("abc")).resolves.toEqual([]);
    await expect(bridges.splsForRxcui("  ")).resolves.toEqual([]);

    const ndcs = requests(fetchMock)
      .filter((url) => url.searchParams.has("ndc"))
      .map((url) => url.searchParams.get("ndc"));
    expect(ndcs).toEqual(["58151-0155-77", "58151-155-77"]);
  });

  it("returns no set ids when no NDC spelling matches", async () => {
    const { client } = clientFor(() =>
      jsonResponse({ data: [], metadata: {} }),
    );
    const bridges = createNlmBridges(client);

    await expect(bridges.splsForNdc("58151-155-77")).resolves.toEqual([]);
    await expect(bridges.splsForNdc("not-an-ndc")).resolves.toEqual([]);
  });

  it("parses raw identifier payloads defensively", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/REST/rxcui.json") {
        const id = url.searchParams.get("id");
        if (id === "AAAAAAAAAA") {
          return jsonResponse({ idGroup: { rxnormId: "83367" } });
        }
        if (id === "BBBBBBBBBB") {
          return jsonResponse([]);
        }
        if (id === "CCCCCCCCCC") {
          return jsonResponse({ idGroup: { rxnormId: ["83367", 7, ""] } });
        }
        return jsonResponse({});
      }
      if (url.searchParams.get("rxcui") === "153165") {
        return jsonResponse({
          data: [{ setid: "ok" }, {}, { setid: 7 }, { setid: "" }],
          metadata: {},
        });
      }
      if (url.searchParams.get("rxcui") === "999") {
        return jsonResponse({ data: "not-a-list" });
      }
      return jsonResponse({});
    });
    const bridges = createNlmBridges(client);

    await expect(bridges.rxcuisForUnii("AAAAAAAAAA")).resolves.toEqual([]);
    await expect(bridges.rxcuisForUnii("BBBBBBBBBB")).resolves.toEqual([]);
    await expect(bridges.rxcuisForUnii("CCCCCCCCCC")).resolves.toEqual([
      "83367",
    ]);
    await expect(bridges.rxcuisForUnii("ZZZZZZZZZZ")).resolves.toEqual([]);
    await expect(bridges.splsForRxcui("153165")).resolves.toEqual(["ok"]);
    await expect(bridges.splsForRxcui("999")).resolves.toEqual([]);
  });

  it("fetches one SPL document and sanitizes DailyMed failures", async () => {
    const xml = textFixture("dailymed-spl-a1e07d5c.xml");
    const { client } = clientFor((url) => {
      if (url.pathname.includes("a1e07d5c")) {
        return new Response(xml, {
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response(null, { status: 503 });
    });
    const bridges = createNlmBridges(client);

    const document = await bridges.getSplXml(
      "a1e07d5c-2056-46f3-8737-f03ed0b4bae8",
    );
    expect(document).toContain("<document");
    await expect(bridges.getSplXml(" ")).rejects.toThrow(
      /Expected a DailyMed SPL set id/,
    );
    await expect(bridges.getSplXml("missing")).rejects.toThrow(
      /The DailyMed SPL lookup failed: DailyMed returned HTTP 503/,
    );
  });

  it("sanitizes upstream failures for every bridge", async () => {
    const { client } = clientFor(() => new Response(null, { status: 503 }));
    const bridges = createNlmBridges(client);

    await expect(bridges.rxcuisForUnii("A0JWA85V8F")).rejects.toThrow(
      /The RxNorm identifier lookup failed: RxNorm returned HTTP 503/,
    );
    await expect(bridges.rxcuisForNdc("58151-155-77")).rejects.toThrow(
      /The RxNorm identifier lookup failed: RxNorm returned HTTP 503/,
    );
    await expect(bridges.splsForNdc("58151-155-77")).rejects.toThrow(
      /The DailyMed identifier lookup failed: DailyMed returned HTTP 503/,
    );
    await expect(bridges.splsForRxcui("153165")).rejects.toThrow(
      /The DailyMed identifier lookup failed: DailyMed returned HTTP 503/,
    );
  });

  it("defaults to the shared NLM client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("idtype") === "NDC") {
        return fixtureResponse("rxnorm-ndc-lipitor.json");
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      await expect(nlmBridges.rxcuisForNdc("58151-155-77")).resolves.toEqual([
        "617314",
      ]);
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});
