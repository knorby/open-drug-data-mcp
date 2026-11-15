import { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import {
  createPubChemAdapter,
  createPubChemBridges,
} from "../src/sources/pubchem.js";
import type {
  IngredientGroup,
  IngredientLookupRecord,
} from "../src/sources/types.js";
import { jsonResponse } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetClients();
});

/**
 * PubChem adapter tests.
 *
 * The adapter is driven with a client whose fetch is stubbed to the PUG REST
 * shapes: name→CID lookup and the properties service. Unknown names and CIDs
 * are 404s upstream, which the adapter reports as normal empty results.
 */

/** Always throws; used where a stubbed fetch must not be reached. */
function unreachable(message: string): never {
  throw new Error(message);
}

/** The first group of a search result, or a thrown error when absent. */
function groups(result: IngredientGroup[]): IngredientGroup {
  const group = result[0];
  if (group === undefined) throw new Error("no group returned");
  return group;
}

/** A PUG REST failure with an HTTP status, the way the client throws it. */
function httpError(status: number): Error {
  return Object.assign(new Error(`PubChem returned HTTP ${status}`), {
    status,
  });
}

function client(handler: (url: URL) => Response): {
  client: NlmDrugsClient;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    client: new NlmDrugsClient({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        seen.push(`${url.pathname}`);
        return handler(url);
      }) as unknown as typeof fetch,
    }),
  };
}

/** The cids response for one compound name. */
function cidsResponse(cids: number[]): Response {
  return jsonResponse({ IdentifierList: { CID: cids } });
}

/** The properties response for one CID. */
function propertiesResponse(cid: number, fields: object): Response {
  return jsonResponse({
    PropertyTable: { Properties: [{ CID: cid, ...fields }] },
  });
}

describe("pubchem adapter — searchIngredients by name", () => {
  it("uses the shared PubChem client for explicit identity resolution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => propertiesResponse(2244, { IUPACName: "aspirin" })),
    );
    resetClients();
    expect(await createPubChemBridges().compoundByCid("2244")).toMatchObject({
      name: "aspirin",
      identifiers: { cid: [2244] },
      source: { database: "PubChem", id: "2244" },
    });
  });

  it("resolves validated chemistry and treats unknown CIDs as empty", async () => {
    const { client: nlm } = client((url) =>
      url.pathname.includes("/2244/")
        ? propertiesResponse(2244, {
            IUPACName: "aspirin",
            InChIKey: "ASPIRIN-KEY",
          })
        : jsonResponse({}, { status: 404 }),
    );
    const bridge = createPubChemBridges(nlm);
    expect(await bridge.compoundByCid("2244")).toMatchObject({
      name: "aspirin",
      identifiers: { cid: [2244], inchiKey: "ASPIRIN-KEY" },
    });
    expect(await bridge.compoundByCid("0")).toBeNull();
    expect(await bridge.compoundByCid("9999")).toBeNull();
    const failed = client(() => jsonResponse({}, { status: 503 }));
    await expect(
      createPubChemBridges(failed.client).compoundByCid("2244"),
    ).rejects.toThrow("PubChem returned HTTP 503");
  });
  it("returns one ref per CID, named by the query, 20 per page", async () => {
    const { client: nlm } = client((url) =>
      url.pathname.endsWith("/cids/JSON")
        ? cidsResponse(Array.from({ length: 25 }, (_, i) => i + 1))
        : unreachable(`unexpected fetch ${url.pathname}`),
    );
    const adapter = createPubChemAdapter(nlm);

    const first = groups(
      (await adapter.searchIngredients?.("name", "aspirin", 1)) ?? [],
    );
    expect(first.source).toBe("PubChem");
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toMatchObject({
      name: "aspirin",
      matchBasis: "PubChem name search",
    });
    expect(first.items[0]?.identifiers.cid).toEqual([1]);
    expect(first.items[0]?.source.url).toBe(
      "https://pubchem.ncbi.nlm.nih.gov/compound/1",
    );

    const second = groups(
      (await adapter.searchIngredients?.("name", "aspirin", 2)) ?? [],
    );
    expect(second.items).toHaveLength(5);
    expect(second.hasMore).toBe(false);
  });

  it("treats an unknown name as an empty group, not an error", async () => {
    const { client: nlm } = client(() => {
      throw httpError(404);
    });
    const adapter = createPubChemAdapter(nlm);

    const group = groups(
      (await adapter.searchIngredients?.("name", "not-a-compound", 1)) ?? [],
    );
    expect(group.items).toEqual([]);
    expect(group.hasMore).toBe(false);
    expect(group.error).toBeUndefined();
  });

  it("rewords a rate limit with the database name", async () => {
    const { client: nlm } = client(() => {
      throw httpError(429);
    });
    const adapter = createPubChemAdapter(nlm);

    await expect(
      adapter.searchIngredients?.("name", "aspirin", 1),
    ).rejects.toThrow(/rate limited by PubChem/);
  });

  it("rewords a server error with the database name", async () => {
    const { client: nlm } = client(() => {
      throw httpError(503);
    });
    const adapter = createPubChemAdapter(nlm);

    await expect(
      adapter.searchIngredients?.("name", "aspirin", 1),
    ).rejects.toThrow(/PubChem returned HTTP 503/);
  });

  it("rewords a plain 4xx rejection with the database name", async () => {
    const { client: nlm } = client(() => {
      throw httpError(400);
    });
    const adapter = createPubChemAdapter(nlm);

    await expect(
      adapter.searchIngredients?.("name", "aspirin", 1),
    ).rejects.toThrow(/PubChem rejected the request \(HTTP 400\)/);
  });

  it("rewords a non-HTTP failure generically", async () => {
    const { client: nlm } = client(() => {
      throw new Error("fetch failed");
    });
    const adapter = createPubChemAdapter(nlm);

    await expect(
      adapter.searchIngredients?.("name", "aspirin", 1),
    ).rejects.toThrow(/did not return a usable response/);
  });

  it("returns nothing for a search type it does not serve", async () => {
    const { seen, client: nlm } = client(() => unreachable("unexpected fetch"));
    const adapter = createPubChemAdapter(nlm);

    const result = await adapter.searchIngredients?.("unii", "R16CO5Y76E", 1);
    expect(result).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("pubchem adapter — searchIngredients by cid", () => {
  it("answers a known CID with its IUPAC name", async () => {
    const { client: nlm } = client((_url) =>
      propertiesResponse(2244, {
        IUPACName: "2-acetyloxybenzoic acid",
        MolecularFormula: "C9H8O4",
        MolecularWeight: "180.16",
        InChIKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
      }),
    );
    const adapter = createPubChemAdapter(nlm);

    const group = groups(
      (await adapter.searchIngredients?.("cid", "2244", 1)) ?? [],
    );
    expect(group.items).toHaveLength(1);
    expect(group.items[0]?.name).toBe("2-acetyloxybenzoic acid");
    expect(group.hasMore).toBe(false);
  });

  it("advises the name search when the CID is not numeric", async () => {
    const { seen, client: nlm } = client(() => unreachable("unexpected fetch"));
    const adapter = createPubChemAdapter(nlm);

    const group = groups(
      (await adapter.searchIngredients?.("cid", "abc", 1)) ?? [],
    );
    expect(group.items).toEqual([]);
    expect(group.error).toContain("PubChem CID");
    expect(seen).toEqual([]);
  });

  it("treats an unknown CID as an empty group", async () => {
    const { client: nlm } = client(() => {
      throw httpError(404);
    });
    const adapter = createPubChemAdapter(nlm);

    const group = groups(
      (await adapter.searchIngredients?.("cid", "999", 1)) ?? [],
    );
    expect(group.items).toEqual([]);
    expect(group.error).toBeUndefined();
  });

  it("rewords a CID-search failure with the database name", async () => {
    const { client: nlm } = client(() => {
      throw httpError(503);
    });
    const adapter = createPubChemAdapter(nlm);

    await expect(adapter.searchIngredients?.("cid", "2244", 1)).rejects.toThrow(
      /PubChem returned HTTP 503/,
    );
  });
});

describe("pubchem adapter — getIngredient", () => {
  it("returns the chemistry block and identifiers", async () => {
    const { client: nlm } = client(() =>
      propertiesResponse(2244, {
        IUPACName: "2-acetyloxybenzoic acid",
        MolecularFormula: "C9H8O4",
        MolecularWeight: "180.16",
        InChIKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
      }),
    );
    const adapter = createPubChemAdapter(nlm);

    const record = (await adapter.getIngredient?.("2244", {})) as
      | IngredientLookupRecord
      | undefined;
    expect(record?.ingredient.name).toBe("2-acetyloxybenzoic acid");
    expect(record?.profile.chemistry).toEqual({
      iupacName: "2-acetyloxybenzoic acid",
      molecularFormula: "C9H8O4",
      molecularWeight: "180.16",
      inChIKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
    });
    expect(record?.ingredient.identifiers.inchiKey).toBe(
      "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
    );
  });

  it("falls back to a CID label when the IUPAC name is blank", async () => {
    const { client: nlm } = client(() =>
      propertiesResponse(2244, {
        IUPACName: "",
        MolecularFormula: "",
      }),
    );
    const adapter = createPubChemAdapter(nlm);

    const record = (await adapter.getIngredient?.("2244", {})) as
      | IngredientLookupRecord
      | undefined;
    expect(record?.ingredient.name).toBe("PubChem CID 2244");
    expect(record?.profile.chemistry).toEqual({});
  });

  it("rejects a non-CID id with the search advice", async () => {
    const { seen, client: nlm } = client(() => unreachable("unexpected fetch"));
    const adapter = createPubChemAdapter(nlm);

    await expect(adapter.getIngredient?.("not-a-cid", {})).rejects.toThrow(
      /PubChem CID/,
    );
    expect(seen).toEqual([]);
  });
});
