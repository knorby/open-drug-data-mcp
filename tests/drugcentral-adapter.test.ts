import { readFileSync } from "node:fs";
import {
  createDrugCentralClient,
  type DrugCentralClient,
  type FetchLike,
  type OmopRelationship,
  type PopulationStampedSignal,
} from "@knorby/drugcentral-client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import { ingredientRefSchema } from "../src/lib/schemas.js";
import {
  createDrugCentralAdapter,
  createDrugCentralBridges,
  dcBridges,
  drugcentralAdapter,
} from "../src/sources/drugcentral.js";
import { jsonResponse } from "./helpers.js";

/**
 * The DrugCentral adapter is tested through the client's injectable `fetch`.
 *
 * Fixtures under `tests/fixtures/drugcentral/` are raw DrugCentral DRS
 * responses captured live on 2026-10-22 for aspirin (struct 74) and timolol
 * (struct 4061), trimmed to the rows each test needs. Two fixtures are
 * hand-authored from the captured shapes to exercise paging and duplicate
 * collapsing: `synonyms-name-paged.json` (21 candidates) and
 * `identifier-unii-many.json` (21 distinct structures).
 *
 * DrugCentral reports a path filter that matches nothing as HTTP 404, so a
 * zero-match search is an ordinary empty group. No fixture or error text may
 * name the client package or a raw API URL.
 */

const FIXTURES = new URL("./fixtures/drugcentral/", import.meta.url);

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

/** A fresh 404 response, matching DrugCentral's no-match behavior. */
function notFound(): Response {
  return jsonResponse({ detail: "not found" }, { status: 404 });
}

/** A fresh HTTP failure response. */
function failure(status: number): Response {
  return jsonResponse({ detail: "upstream failure" }, { status });
}

type Route = unknown | (() => Response);

interface RoutedClient {
  client: DrugCentralClient;
  fetchMock: ReturnType<typeof vi.fn>;
}

/**
 * Builds a client whose fetch answers by decoded pathname. An unmatched path
 * throws, so a test fails loudly when the adapter makes an unexpected request.
 * A fallback may answer wildcard paths (the paging test uses it for every
 * structure fetch).
 */
function clientFor(
  routes: Record<string, Route>,
  fallback?: (path: string) => Response,
): RoutedClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const route = routes[path];
    if (route === undefined) {
      if (fallback !== undefined) return fallback(path);
      throw new Error(`unexpected DrugCentral request: ${path}`);
    }
    if (typeof route === "function") {
      return (route as () => Response)();
    }
    if (route instanceof Response) return route;
    if (typeof route === "string") return jsonResponse(fixture(route));
    return jsonResponse(route);
  });
  const client = createDrugCentralClient({
    fetch: fetchMock as unknown as FetchLike,
    timeoutMs: 5_000,
  });
  return { client, fetchMock };
}

/** The three structures the captured synonym search returns. */
const ASPIRIN_SEARCH = {
  "/structures/name/aspirin": notFound,
  "/synonyms/name/aspirin": "synonyms-name-aspirin.json",
};

/** The structure and ATC routes the identifier paths need for struct 74. */
const ASPIRIN_STRUCTURE = {
  "/structures/id/74": "structures-id-74.json",
  "/struct2atc/struct_id/74": "struct2atc-struct-74.json",
};

/** Answers enrichment lookups with 404 for any structure not routed. */
function emptyEnrichment(path: string): Response {
  if (path.startsWith("/structures/id/")) return notFound();
  if (path.startsWith("/struct2atc/struct_id/")) return notFound();
  throw new Error(`unexpected DrugCentral request: ${path}`);
}

describe("DrugCentral adapter capabilities", () => {
  it("declares ingredient-only capabilities and no NDC-to-structure support", () => {
    expect(drugcentralAdapter.id).toBe("drugcentral");
    expect(drugcentralAdapter.databases).toEqual(["DrugCentral"]);
    expect(drugcentralAdapter.productSearchTypes).toEqual([]);
    expect(drugcentralAdapter.ingredientSearchTypes).toEqual([
      "name",
      "unii",
      "cas",
      "rxcui",
    ]);
    expect(drugcentralAdapter.productCategories).toEqual([]);
    expect(drugcentralAdapter.searchProducts).toBeUndefined();
    expect(drugcentralAdapter.searchIngredients).toBeTypeOf("function");
  });

  it("defaults to the shared DrugCentral client", async () => {
    const fetchMock = vi.fn(async () => notFound());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      const groups = await drugcentralAdapter.searchIngredients?.(
        "name",
        "nobody",
        1,
      );
      expect(groups).toEqual([
        { source: "DrugCentral", items: [], page: 1, hasMore: false },
      ]);
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});

describe("DrugCentral name search", () => {
  it("maps synonym candidates to ingredient refs with a deep link", async () => {
    const { client } = clientFor(
      { ...ASPIRIN_SEARCH, ...ASPIRIN_STRUCTURE },
      emptyEnrichment,
    );
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("name", "  aspirin ", 1);

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.source).toBe("DrugCentral");
    expect(group?.page).toBe(1);
    expect(group?.hasMore).toBe(false);
    expect(group?.items.map((item) => item.identifiers.structId)).toEqual([
      74, 3443, 4387,
    ]);

    const first = group?.items[0];
    expect(first).toBeDefined();
    expect(ingredientRefSchema.parse(first)).toEqual(first);
    expect(first?.name).toBe("aspirin");
    expect(first?.matchBasis).toBe("synonym match");
    expect(first?.identifiers).toEqual({
      structId: 74,
      cas: ["50-78-2"],
      inchiKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
    });
    expect(first?.summary).toContain("Status: OFP");
    expect(first?.summary).toContain("ATC: A01AD05");
    expect(first?.source).toEqual({
      database: "DrugCentral",
      id: "74",
      url: "https://drugcentral.org/drugcard/74",
      retrievedAt: expect.any(String),
    });
    expect(new Date(first?.source.retrievedAt ?? "").toISOString()).toBe(
      first?.source.retrievedAt,
    );
  });

  it("marks a preferred-name match as such", async () => {
    const { client } = clientFor({
      "/structures/name/acetylsalicylic acid":
        "structures-name-acetylsalicylic-acid.json",
      "/synonyms/name/acetylsalicylic acid": notFound,
      ...ASPIRIN_STRUCTURE,
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients(
      "name",
      "acetylsalicylic acid",
      1,
    );

    expect(groups[0]?.items).toHaveLength(1);
    expect(groups[0]?.items[0]?.name).toBe("acetylsalicylic acid");
    expect(groups[0]?.items[0]?.identifiers.structId).toBe(74);
    expect(groups[0]?.items[0]?.matchBasis).toBe("preferred-name match");
    expect(groups[0]?.items[0]?.summary).toContain("ATC: A01AD05");
  });

  it("returns an empty group for a zero-match 404", async () => {
    const { client } = clientFor({
      "/structures/name/unknown": notFound,
      "/synonyms/name/unknown": notFound,
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("name", "unknown", 1);

    expect(groups).toEqual([
      { source: "DrugCentral", items: [], page: 1, hasMore: false },
    ]);
  });

  it("returns an empty group without a request for a blank query", async () => {
    const { client, fetchMock } = clientFor({});
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("name", "   ", 1);

    expect(groups).toEqual([
      { source: "DrugCentral", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pages an unpaged candidate list without auto-walking", async () => {
    const { client, fetchMock } = clientFor(
      { "/synonyms/name/aspirin analog": "synonyms-name-paged.json" },
      (path) => {
        if (path.startsWith("/structures/name/")) return notFound();
        return emptyEnrichment(path);
      },
    );
    const adapter = createDrugCentralAdapter(client);

    const first = await adapter.searchIngredients("name", "aspirin analog", 1);
    expect(first[0]?.items).toHaveLength(20);
    expect(first[0]?.hasMore).toBe(true);
    expect(first[0]?.items[0]?.identifiers.structId).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(42);

    const second = await adapter.searchIngredients("name", "aspirin analog", 2);
    expect(second[0]?.items).toHaveLength(1);
    expect(second[0]?.hasMore).toBe(false);
    expect(second[0]?.items[0]?.identifiers.structId).toBe(1020);
    expect(fetchMock).toHaveBeenCalledTimes(46);

    const third = await adapter.searchIngredients("name", "aspirin analog", 3);
    expect(third[0]?.items).toEqual([]);
    expect(third[0]?.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(48);
  });

  it("summarizes ATC when the structure has no status", async () => {
    const blankStructure = {
      id: 9001,
      name: null,
      cas_reg_no: null,
      status: null,
      cd_id: null,
      inchikey: null,
    };
    const { client } = clientFor({
      "/structures/name/blank": [blankStructure],
      "/synonyms/name/blank": notFound,
      "/structures/id/9001": [blankStructure],
      "/struct2atc/struct_id/9001": [
        { struct_id: 9001, atc_code: "N02BA01", id: 1 },
        { struct_id: 9001, atc_code: null, id: 2 },
      ],
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("name", "blank", 1);

    expect(groups[0]?.items[0]?.name).toBe("9001");
    expect(groups[0]?.items[0]?.identifiers).toEqual({ structId: 9001 });
    expect(groups[0]?.items[0]?.summary).toBe("ATC: N02BA01");
  });

  it("returns an empty group for an unsupported search type", async () => {
    const { client, fetchMock } = clientFor({});
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("inci", "aspirin", 1);

    expect(groups).toEqual([
      { source: "DrugCentral", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DrugCentral identifier search", () => {
  it("maps a UNII crosswalk hit to a ref with structure identity", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": "identifier-unii-aspirin.json",
      ...ASPIRIN_STRUCTURE,
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("unii", " r16co5y76e ", 1);

    expect(groups[0]?.source).toBe("DrugCentral");
    expect(groups[0]?.items).toHaveLength(1);
    const item = groups[0]?.items[0];
    expect(item?.name).toBe("acetylsalicylic acid");
    expect(item?.identifiers).toEqual({
      structId: 74,
      unii: "R16CO5Y76E",
      cas: ["50-78-2"],
      inchiKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
    });
    expect(item?.matchBasis).toBe("UNII identifier match");
    expect(item?.summary).toContain("Status: OFP");
    expect(item?.summary).toContain("ATC: A01AD05");
    expect(item?.source).toEqual({
      database: "DrugCentral",
      id: "74",
      url: "https://drugcentral.org/drugcard/74",
      retrievedAt: expect.any(String),
    });
    expect(ingredientRefSchema.safeParse(item).success).toBe(true);
  });

  it("drops duplicate crosswalk rows by structure id", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": "identifier-unii-duplicate.json",
      "/structures/id/74": "structures-id-74.json",
      "/struct2atc/struct_id/74": notFound,
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("unii", "R16CO5Y76E", 1);

    expect(groups[0]?.items).toHaveLength(1);
    expect(groups[0]?.items[0]?.summary).toBe("Status: OFP");
  });

  it("keeps a match whose structure record is gone", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": "identifier-unii-aspirin.json",
      "/structures/id/74": notFound,
      "/struct2atc/struct_id/74": notFound,
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("unii", "R16CO5Y76E", 1);

    const item = groups[0]?.items[0];
    expect(item?.name).toBe("R16CO5Y76E");
    expect(item?.identifiers).toEqual({
      structId: 74,
      unii: "R16CO5Y76E",
    });
    expect(item?.summary).toBeUndefined();
    expect(item?.matchBasis).toBe("UNII identifier match");
  });

  it("returns an empty group for a zero-match UNII", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": notFound,
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("unii", "R16CO5Y76E", 1);

    expect(groups).toEqual([
      { source: "DrugCentral", items: [], page: 1, hasMore: false },
    ]);
  });

  it("rejects a malformed UNII locally", async () => {
    const { client, fetchMock } = clientFor({});
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("unii", "short", 1);

    expect(groups[0]?.items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an RxCUI crosswalk hit and pages past the first page", async () => {
    const routes = {
      "/identifier/identifier/1191": "identifier-rxcui-1191.json",
      ...ASPIRIN_STRUCTURE,
    };
    const { client } = clientFor(routes);
    const adapter = createDrugCentralAdapter(client);

    const first = await adapter.searchIngredients("rxcui", "1191", 1);
    expect(first[0]?.items).toHaveLength(1);
    expect(first[0]?.items[0]?.name).toBe("acetylsalicylic acid");
    expect(first[0]?.items[0]?.identifiers.rxcui).toEqual(["1191"]);
    expect(first[0]?.items[0]?.matchBasis).toBe("RxCUI identifier match");
    expect(first[0]?.items[0]?.summary).toContain("ATC: A01AD05");

    const second = await adapter.searchIngredients("rxcui", "1191", 2);
    expect(second[0]?.items).toEqual([]);
    expect(second[0]?.hasMore).toBe(false);
  });

  it("drops a substring-only crosswalk false positive", async () => {
    const { client, fetchMock } = clientFor({
      "/identifier/identifier/1191": "identifier-rxcui-substring.json",
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("rxcui", "1191", 1);

    expect(groups).toEqual([
      { source: "DrugCentral", items: [], page: 1, hasMore: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-numeric RxCUI locally", async () => {
    const { client, fetchMock } = clientFor({});
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("rxcui", "12a", 1);

    expect(groups[0]?.items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a secondary CAS hit and keeps the primary CAS too", async () => {
    const { client } = clientFor({
      "/identifier/identifier/91524-16-2": "identifier-secondary-cas.json",
      "/structures/id/4061": "structures-id-4061.json",
      "/struct2atc/struct_id/4061": "struct2atc-struct-4061.json",
    });
    const adapter = createDrugCentralAdapter(client);

    const groups = await adapter.searchIngredients("cas", "91524-16-2", 1);

    const item = groups[0]?.items[0];
    expect(item?.name).toBe("timolol");
    expect(item?.identifiers.cas).toEqual(["91524-16-2", "26839-75-8"]);
    expect(item?.identifiers.structId).toBe(4061);
    expect(item?.matchBasis).toBe("CAS identifier match");
    expect(item?.summary).toContain("Status: OFP");
    expect(item?.summary).toContain("ATC: C07AA06");
  });

  it("rejects a malformed CAS locally and treats a miss as empty", async () => {
    const blank = clientFor({});
    const blankAdapter = createDrugCentralAdapter(blank.client);
    expect(
      (await blankAdapter.searchIngredients("cas", "not-a-cas", 1))[0]?.items,
    ).toEqual([]);
    expect(blank.fetchMock).not.toHaveBeenCalled();

    const miss = clientFor({
      "/identifier/identifier/50-78-2": notFound,
    });
    const missAdapter = createDrugCentralAdapter(miss.client);
    expect(
      (await missAdapter.searchIngredients("cas", "50-78-2", 1))[0]?.items,
    ).toEqual([]);
  });

  it("bounds a multi-structure crosswalk to one page", async () => {
    const { client, fetchMock } = clientFor(
      {
        "/identifier/identifier/A000000001": "identifier-unii-many.json",
      },
      (path) => {
        if (path.startsWith("/structures/id/")) return notFound();
        return emptyEnrichment(path);
      },
    );
    const adapter = createDrugCentralAdapter(client);

    const first = await adapter.searchIngredients("unii", "A000000001", 1);
    expect(first[0]?.items).toHaveLength(20);
    expect(first[0]?.hasMore).toBe(true);
    expect(first[0]?.items[0]?.identifiers.structId).toBe(2000);
    expect(fetchMock).toHaveBeenCalledTimes(41);

    const second = await adapter.searchIngredients("unii", "A000000001", 2);
    expect(second[0]?.items).toHaveLength(1);
    expect(second[0]?.hasMore).toBe(false);
    expect(second[0]?.items[0]?.identifiers.structId).toBe(2020);
  });
});

describe("DrugCentral error sanitation", () => {
  it("rewords a rate-limited name search", async () => {
    const { client } = clientFor({
      "/structures/name/aspirin": () => failure(429),
      "/synonyms/name/aspirin": () => failure(429),
    });
    const adapter = createDrugCentralAdapter(client);

    await expect(
      adapter.searchIngredients("name", "aspirin", 1),
    ).rejects.toThrow(/DrugCentral.*HTTP 429/);
  });

  it("rewords a 5xx identifier failure", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": () => failure(503),
    });
    const adapter = createDrugCentralAdapter(client);

    await expect(
      adapter.searchIngredients("unii", "R16CO5Y76E", 1),
    ).rejects.toThrow(/DrugCentral returned HTTP 503/);
  });

  it("rewords a 4xx identifier failure", async () => {
    const { client } = clientFor({
      "/identifier/identifier/50-78-2": () => failure(400),
    });
    const adapter = createDrugCentralAdapter(client);

    await expect(
      adapter.searchIngredients("cas", "50-78-2", 1),
    ).rejects.toThrow(/DrugCentral rejected the request \(HTTP 400\)/);
  });

  it("rewords a structure enrichment failure", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": "identifier-unii-aspirin.json",
      "/structures/id/74": () => failure(500),
      "/struct2atc/struct_id/74": notFound,
    });
    const adapter = createDrugCentralAdapter(client);

    await expect(
      adapter.searchIngredients("unii", "R16CO5Y76E", 1),
    ).rejects.toThrow(/DrugCentral returned HTTP 500/);
  });

  it("rewords an ATC enrichment failure", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": "identifier-unii-aspirin.json",
      "/structures/id/74": "structures-id-74.json",
      "/struct2atc/struct_id/74": () => failure(500),
    });
    const adapter = createDrugCentralAdapter(client);

    await expect(
      adapter.searchIngredients("unii", "R16CO5Y76E", 1),
    ).rejects.toThrow(/DrugCentral returned HTTP 500/);
  });

  it("hides transport details behind a generic message", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed for https://internal.example");
    });
    const client = createDrugCentralClient({
      fetch: fetchMock as unknown as FetchLike,
      timeoutMs: 5_000,
    });
    const adapter = createDrugCentralAdapter(client);

    let message = "";
    try {
      await adapter.searchIngredients("rxcui", "1191", 1);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("DrugCentral did not return a usable response");
    expect(message).not.toContain("internal.example");
    expect(message).not.toContain("@knorby");
  });
});

describe("DrugCentral bridges", () => {
  it.each([
    { values: [], expected: [] },
    {
      values: ["", " ", "0", "-1", "1.5", "2e3", "9007199254740992", "abc"],
      expected: [],
    },
    { values: [" 2244 ", "2244", "56843331"], expected: [2244, 56843331] },
    { values: ["56843331"], expected: [56843331] },
  ])(
    "uses only valid PubChem crosswalk values: $values",
    async ({ values, expected }) => {
      const structure = fixture<Record<string, unknown>[]>(
        "structures-id-74.json",
      ).map((row) => ({ ...row, cd_id: 5064 }));
      const { client } = clientFor({
        "/structures/id/74": structure,
        "/identifier/struct_id/74": values.map((identifier, id) => ({
          identifier,
          id,
          id_type: "PUBCHEM_CID",
          struct_id: 74,
          parent_match: null,
        })),
        "/synonyms/id/74": [],
        "/struct2obprod/struct_id/74": [],
        "/struct2atc/struct_id/74": [],
      });
      const raw = await createDrugCentralAdapter(client).getIngredient(
        "74",
        {},
      );
      const result = z
        .object({
          ingredient: ingredientRefSchema,
          profile: z.object({ cid: z.number().optional() }),
        })
        .parse(raw);
      expect(result.ingredient.identifiers.cid ?? []).toEqual(expected);
      expect(result.profile?.cid).toBe(expected[0]);
    },
  );

  it("resolves UNIIs and RxCUIs to structure ids", async () => {
    const { client } = clientFor({
      "/identifier/identifier/R16CO5Y76E": "identifier-unii-aspirin.json",
      "/identifier/identifier/1191": "identifier-rxcui-1191.json",
    });
    const bridges = createDrugCentralBridges(client);

    await expect(bridges.structIdsForUnii(" r16co5y76e ")).resolves.toEqual([
      74,
    ]);
    await expect(bridges.structIdsForRxcui("1191")).resolves.toEqual([74]);
    await expect(bridges.structIdsForUnii("short")).resolves.toEqual([]);
    await expect(bridges.structIdsForRxcui("12a")).resolves.toEqual([]);
  });

  it("assembles a structure profile", async () => {
    const { client } = clientFor({
      "/structures/id/74": "structures-id-74.json",
      "/identifier/struct_id/74": "identifier-struct-74.json",
      "/synonyms/id/74": "synonyms-struct-74.json",
      "/struct2obprod/struct_id/74": "struct2obprod-struct-74.json",
      "/struct2atc/struct_id/74": "struct2atc-struct-74.json",
    });
    const bridges = createDrugCentralBridges(client);

    const profile = await bridges.getProfile(74);

    expect(profile.data.structure?.name).toBe("acetylsalicylic acid");
    expect(profile.data.identifiers.length).toBeGreaterThan(0);
    expect(profile.data.synonyms.length).toBeGreaterThan(0);
    expect(profile.data.obprodLinks).toHaveLength(3);
    expect(profile.data.atc).toHaveLength(21);
    expect(profile.provenance.source).toBe("drugcentral");
    expect(profile.provenance.structId).toBe(74);
  });

  it("treats a missing profile as null sections, not an error", async () => {
    const { client } = clientFor({
      "/structures/id/999": notFound,
      "/identifier/struct_id/999": notFound,
      "/synonyms/id/999": notFound,
      "/struct2obprod/struct_id/999": notFound,
      "/struct2atc/struct_id/999": notFound,
    });
    const bridges = createDrugCentralBridges(client);

    const profile = await bridges.getProfile(999);

    expect(profile.data.structure).toBeNull();
    expect(profile.data.identifiers).toEqual([]);
    expect(profile.data.synonyms).toEqual([]);
  });

  it("keeps condition labels verbatim and filters by exact kind", async () => {
    const { client } = clientFor({
      "/omop_relationship/struct_id/74": "omop-relationships-struct-74.json",
      "/omop_relationship/struct_id/5375":
        "omop-relationships-struct-5375.json",
      "/omop_relationship/struct_id/5406":
        "omop-relationships-struct-5406.json",
    });
    const bridges = createDrugCentralBridges(client);

    const indications = await bridges.getIndications(74);
    expect(indications.data).toHaveLength(13);
    expect(
      indications.data.every(
        (row: OmopRelationship) => row.relationship_name === "indication",
      ),
    ).toBe(true);

    const offLabel = await bridges.getOffLabelUses(5375);
    expect(offLabel.data).toHaveLength(1);
    expect(offLabel.data[0]?.relationship_name).toBe("off-label use");

    const contraindications = await bridges.getContraindications(5406);
    expect(contraindications.data).toHaveLength(4);
    expect(
      contraindications.data.every(
        (row: OmopRelationship) => row.relationship_name === "contraindication",
      ),
    ).toBe(true);
  });

  it("stamps FAERS signals with the report population", async () => {
    const { client } = clientFor({
      "/faers/struct_id/74": "faers-struct-74.json",
      "/faers_male/struct_id/74": "faers-male-struct-74.json",
      "/faers_female/struct_id/74": "faers-female-struct-74.json",
    });
    const bridges = createDrugCentralBridges(client);

    const all = await bridges.getFaersSignals(74);
    expect(all.data).toHaveLength(3);
    expect(
      all.data.every(
        (row: PopulationStampedSignal) => row.population === "all",
      ),
    ).toBe(true);

    const male = await bridges.getFaersSignals(74, "male");
    expect(male.data).toHaveLength(2);
    expect(
      male.data.every(
        (row: PopulationStampedSignal) => row.population === "male",
      ),
    ).toBe(true);

    const female = await bridges.getFaersSignals(74, "female");
    expect(female.data).toHaveLength(2);
    expect(
      female.data.every(
        (row: PopulationStampedSignal) => row.population === "female",
      ),
    ).toBe(true);
  });

  it("rejects an invalid structure id before making a request", async () => {
    const { client, fetchMock } = clientFor({});
    const bridges = createDrugCentralBridges(client);

    await expect(bridges.getProfile(0)).rejects.toThrow(
      "Expected a DrugCentral structure id",
    );
    await expect(bridges.getIndications(1.5)).rejects.toThrow(
      "Expected a DrugCentral structure id",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes bridge failures", async () => {
    const rateLimited = createDrugCentralBridges(
      clientFor({
        "/identifier/identifier/R16CO5Y76E": () => failure(429),
      }).client,
    );
    await expect(rateLimited.structIdsForUnii("R16CO5Y76E")).rejects.toThrow(
      /DrugCentral.*HTTP 429/,
    );

    const serverError = createDrugCentralBridges(
      clientFor({
        "/identifier/identifier/1191": () => failure(503),
      }).client,
    );
    await expect(serverError.structIdsForRxcui("1191")).rejects.toThrow(
      /DrugCentral returned HTTP 503/,
    );

    const rejected = createDrugCentralBridges(
      clientFor({
        "/structures/id/74": () => failure(400),
        "/identifier/struct_id/74": () => failure(400),
        "/synonyms/id/74": () => failure(400),
        "/struct2obprod/struct_id/74": () => failure(400),
        "/struct2atc/struct_id/74": () => failure(400),
      }).client,
    );
    await expect(rejected.getProfile(74)).rejects.toThrow(
      /DrugCentral rejected the request \(HTTP 400\)/,
    );

    const offline = createDrugCentralBridges(
      createDrugCentralClient({
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as FetchLike,
        timeoutMs: 5_000,
      }),
    );
    await expect(offline.getFaersSignals(74)).rejects.toThrow(
      /DrugCentral did not return a usable response/,
    );
  });

  it("defaults to the shared DrugCentral client", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(fixture("identifier-unii-aspirin.json")),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    resetClients();
    resetConfig();
    try {
      await expect(dcBridges.structIdsForUnii("R16CO5Y76E")).resolves.toEqual([
        74,
      ]);
    } finally {
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});
