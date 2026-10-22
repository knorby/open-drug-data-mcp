import { readFileSync } from "node:fs";
import type { Ingredient as ClientIngredient } from "@knorby/inkeedecoder-client";
import { describe, expect, it, vi } from "vitest";
import type { IngredientRef, ProductRef } from "../src/lib/schemas.js";
import type { CosingBridgeHit } from "../src/sources/cosing.js";
import type { DrugCentralBridges } from "../src/sources/drugcentral.js";
import {
  createIdentityResolver,
  createInkeedecoderIngredientDep,
  type IdentityDeps,
  type IdentityGraph,
  resolveIdentity,
} from "../src/sources/identity/chain.js";
import { effectiveUnii } from "../src/sources/identity/unii.js";
import type { IkdBridges } from "../src/sources/inkeedecoder.js";
import type {
  OpenFdaProductRecord,
  OpenFdaSubstanceHit,
} from "../src/sources/openfda.js";

/**
 * The identity chain is exercised through injected, fixture-backed bridges.
 *
 * Each fake returns unified refs shaped from captured responses in
 * `tests/fixtures/`; no request reaches the network. The tests pin the fixed
 * step order, confident-only linking, candidate reasons, the two-pass
 * invalidation rule, product ingredient extraction, and the weak terminals.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** Reads a JSON fixture. */
function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;
}

/** Reads a text fixture. */
function textFixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

const ISO = "2026-10-22T12:00:00.000Z";

/** Builds an ingredient ref with a source default. */
function ingredient(
  name: string,
  partial: Partial<IngredientRef> = {},
): IngredientRef {
  return {
    name,
    identifiers: {},
    source: {
      database: "openFDA",
      id: name.toLowerCase().replace(/\s+/g, "-"),
      url: `https://example.test/openfda/${encodeURIComponent(name)}`,
      retrievedAt: ISO,
    },
    ...partial,
  };
}

/** Builds a CosIng bridge hit. */
function cosingHit(
  name: string,
  matchedOn: CosingBridgeHit["matchedOn"] = "inciName",
  exact = true,
): CosingBridgeHit {
  return {
    ingredient: ingredient(name, {
      inciName: name,
      identifiers: { cas: ["50-78-2"], ec: ["200-064-1"] },
      source: {
        database: "CosIng",
        id: `cosing-${name}`,
        url: `https://example.test/cosing/${encodeURIComponent(name)}`,
        retrievedAt: ISO,
      },
    }),
    matchedOn,
    exact,
  };
}

/** A minimal DrugCentral profile envelope. */
type ProfileResult = Awaited<ReturnType<DrugCentralBridges["getProfile"]>>;

/** Builds the required DrugStructure fields with nulls. */
function structure(name: string | null, casRegNo: string | null = null) {
  return {
    id: 74,
    name,
    cas_reg_no: casRegNo,
    mrdef: null,
    status: null,
    stem: null,
    no_formulations: null,
    fda_labels: null,
    cd_id: null,
    cd_formula: null,
    cd_molweight: null,
    smiles: null,
    inchi: null,
    inchikey: null,
    molfile: null,
    clogp: null,
    alogs: null,
    tpsa: null,
    rotb: null,
    sp_c: null,
    sp2_c: null,
    sp3_c: null,
    hetero_sp2_c: null,
    o_n: null,
    oh_nh: null,
    halogen: null,
    arom_c: null,
    lipinski: null,
    enhanced_stereo: null,
    rgb: null,
  } as NonNullable<ProfileResult["data"]["structure"]>;
}

/** Builds a guided profile result. */
function profile(
  identifiers: ProfileResult["data"]["identifiers"],
  name: string | null = "aspirin",
  casRegNo: string | null = null,
): ProfileResult {
  return {
    data: {
      structure: structure(name, casRegNo),
      identifiers,
      synonyms: [],
      obprodLinks: [],
      atc: [],
    },
    provenance: {
      source: "drugcentral",
      endpoint: "/structures/74",
      structId: 74,
      retrievedAt: ISO,
      sourceVersion: null,
    },
  };
}

/** Builds one identifier row. */
function idRow(
  idType: string,
  value: string,
  structId = 74,
): ProfileResult["data"]["identifiers"][number] {
  return {
    id: 1,
    identifier: value,
    id_type: idType,
    struct_id: structId,
    parent_match: null,
  };
}

/** An INKEEDecoder ingredient page from the fixture's shape. */
function ikdIngredient(
  partial: Partial<ClientIngredient> = {},
): ClientIngredient {
  return {
    slug: "niacinamide",
    name: "Niacinamide",
    path: "/ingredients/niacinamide",
    url: "https://inkeedecoder.com/ingredients/niacinamide",
    ourTake: null,
    ...partial,
  };
}

/** A product ref plus its ingredient rows. */
function productRecord(
  product: ProductRef,
  ingredients: IngredientRef[],
): OpenFdaProductRecord {
  return {
    product,
    ingredients,
    details: { source: "ndc" },
    labelIngredientsIncluded: false,
  };
}

/** Builds the default, all-empty bridges. */
function baseDeps(): IdentityDeps {
  return {
    openfda: {
      substanceByUnii: async () => null,
      substanceByCas: async () => null,
      substancesByName: async () => [],
      productByNdc: async () => null,
      productBySetId: async () => null,
    },
    cosing: {
      byInci: async () => [],
      byCas: async () => [],
    },
    nlm: {
      rxcuisForUnii: async () => [],
      rxcuisForNdc: async () => [],
      splsForNdc: async () => [],
      getSplXml: async () => "",
    },
    drugcentral: {
      structIdsForUnii: async () => [],
      structIdsForRxcui: async () => [],
      getProfile: async () => profile([]),
    },
    dsld: {
      ingredientGroupsByName: async () => [],
      label: async () => null,
    },
    inkeedecoder: {
      getIngredient: async () => null,
    },
  };
}

type DepOverrides = {
  [K in keyof IdentityDeps]?: Partial<IdentityDeps[K]>;
};

/** Builds deps with per-bridge overrides. */
function deps(overrides: DepOverrides = {}): IdentityDeps {
  const base = baseDeps();
  return {
    openfda: { ...base.openfda, ...overrides.openfda },
    cosing: { ...base.cosing, ...overrides.cosing },
    nlm: { ...base.nlm, ...overrides.nlm },
    drugcentral: { ...base.drugcentral, ...overrides.drugcentral },
    dsld: { ...base.dsld, ...overrides.dsld },
    inkeedecoder: { ...base.inkeedecoder, ...overrides.inkeedecoder },
  };
}

/** Resolves one ingredient-level input through the injected deps. */
async function resolveIngredient(
  input: Parameters<typeof resolveIdentity>[0],
  overrides: DepOverrides = {},
  opts: Parameters<typeof resolveIdentity>[1] = {},
): Promise<IdentityGraph> {
  const result = await createIdentityResolver(deps(overrides)).resolve(
    input,
    opts,
  );
  if (result.kind !== "ingredient") throw new Error("expected an ingredient");
  return result.graph;
}

/** The loaded ingredient-group fixture, exposed as refs by the bridge. */
const DSLD_GROUPS: IngredientRef[] = [
  ingredient("Vitamin D3", {
    identifiers: { cas: ["67-97-0"] },
    source: {
      database: "DSLD",
      id: "vitamin-d3",
      url: "https://dsld.od.nih.gov/ingredient/Vitamin%20D3",
      retrievedAt: ISO,
    },
  }),
  ingredient("Cholecalciferol", {
    identifiers: {},
    source: {
      database: "DSLD",
      id: "cholecalciferol",
      url: "https://dsld.od.nih.gov/ingredient/Cholecalciferol",
      retrievedAt: ISO,
    },
  }),
];

describe("effectiveUnii", () => {
  it("prefers an openFDA link, then DSLD, then the caller's UNII", () => {
    expect(
      effectiveUnii({
        openfda: { unii: "openfda-unii" },
        dsldUnii: "dsld-unii",
        unii: "input-unii",
      }),
    ).toBe("OPENFDA-UNII");
    expect(effectiveUnii({ dsldUnii: " dsld-unii ", unii: "input" })).toBe(
      "DSLD-UNII",
    );
    expect(effectiveUnii({ unii: " input " })).toBe("INPUT");
  });

  it("ignores blank and missing values", () => {
    expect(
      effectiveUnii({ openfda: { unii: "  " }, unii: "" }),
    ).toBeUndefined();
    expect(effectiveUnii({})).toBeUndefined();
  });
});

describe("identity chain (a): confident cross-source links", () => {
  it("links openFDA, CosIng, RxNorm, and DrugCentral for a UNII", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () =>
            ingredient("ASPIRIN", {
              inciName: "SALICYLIC ACID",
              identifiers: { unii: "R16CO5Y76E", cas: ["50-78-2"] },
            }),
        },
        cosing: { byInci: async () => [cosingHit("SALICYLIC ACID")] },
        nlm: { rxcuisForUnii: async () => ["1191"] },
        drugcentral: {
          structIdsForUnii: async () => [74],
          getProfile: async () =>
            profile([
              idRow("UNII", "R16CO5Y76E"),
              idRow("RXNORM", "1191"),
              idRow("CAS", "50-78-2"),
            ]),
        },
      },
    );

    expect(graph.subject).toEqual({
      name: "ASPIRIN",
      inciName: "SALICYLIC ACID",
    });
    expect(graph.links.map((link) => link.database)).toEqual([
      "openFDA",
      "CosIng",
      "RxNorm",
      "DrugCentral",
    ]);
    expect(graph.links.map((link) => link.confidence)).toEqual([
      "direct",
      "derived",
      "direct",
      "direct",
    ]);
    expect(graph.links[1]?.matchedVia).toBe("inci");
    expect(graph.identifiers).toEqual({
      unii: "R16CO5Y76E",
      cas: ["50-78-2"],
      ec: ["200-064-1"],
      rxcui: ["1191"],
      structId: 74,
    });
    expect(graph.candidates).toEqual([]);
  });

  it("links a CAS input directly through openFDA and CosIng", async () => {
    const graph = await resolveIngredient(
      { cas: "50-78-2" },
      {
        openfda: {
          substanceByCas: async () =>
            ingredient("ASPIRIN", {
              identifiers: { unii: "R16CO5Y76E", cas: ["50-78-2"] },
            }),
        },
        cosing: { byCas: async () => [cosingHit("SALICYLIC ACID", "casNo")] },
      },
    );

    expect(graph.links.map((link) => link.matchedVia)).toEqual(["cas", "cas"]);
    expect(graph.links.every((link) => link.confidence === "direct")).toBe(
      true,
    );
    expect(graph.identifiers.unii).toBe("R16CO5Y76E");
  });

  it("links an RxCUI input directly through RxNorm and DrugCentral", async () => {
    const graph = await resolveIngredient(
      { rxcui: "1191" },
      {
        drugcentral: {
          structIdsForRxcui: async () => [74],
          getProfile: async () => profile([idRow("RXNORM", "1191")]),
        },
      },
    );

    expect(graph.links.map((link) => [link.database, link.confidence])).toEqual(
      [
        ["RxNorm", "direct"],
        ["DrugCentral", "direct"],
      ],
    );
    expect(graph.identifiers.rxcui).toEqual(["1191"]);
    expect(graph.identifiers.structId).toBe(74);
  });
});

describe("identity chain (b): ambiguity stays a candidate set", () => {
  it("returns name candidates and no openFDA link for a multi-match", async () => {
    const graph = await resolveIngredient(
      { substanceName: "glycerin" },
      {
        openfda: {
          substancesByName: async (): Promise<OpenFdaSubstanceHit[]> => [
            {
              ingredient: ingredient("GLYCERIN METHYL ETHER", {
                identifiers: { unii: "AAA" },
              }),
              tier: "prefix",
            },
            {
              ingredient: ingredient("GLYCERIN", {
                identifiers: { unii: "PDC6A3C0OX" },
              }),
              tier: "none",
            },
          ],
        },
        cosing: { byInci: async () => [cosingHit("GLYCERIN")] },
      },
    );

    expect(graph.links.filter((link) => link.database === "openFDA")).toEqual(
      [],
    );
    const openfda = graph.candidates.find(
      (candidate) => candidate.database === "openFDA",
    );
    expect(openfda?.reason).toBe("multiple-substance-matches");
    expect(openfda?.options.map((option) => option.name)).toEqual([
      "GLYCERIN METHYL ETHER",
      "GLYCERIN",
    ]);
    // CosIng's single exact INCI hit is still a confident link.
    expect(graph.links.some((link) => link.database === "CosIng")).toBe(true);
  });

  it("keeps ambiguous CosIng, RxNorm, and DrugCentral results as candidates", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () =>
            ingredient("ASPIRIN", {
              identifiers: { unii: "R16CO5Y76E" },
            }),
        },
        cosing: {
          byInci: async () => [
            cosingHit("SALICYLIC ACID", "text", false),
            cosingHit("SALICYLIC ACID 2", "text", false),
          ],
        },
        nlm: { rxcuisForUnii: async () => ["1191", "1192"] },
        drugcentral: { structIdsForUnii: async () => [74, 5375] },
      },
    );

    expect(graph.links.map((link) => link.database)).toEqual(["openFDA"]);
    expect(graph.candidates.map((candidate) => candidate.database)).toEqual([
      "CosIng",
      "RxNorm",
      "DrugCentral",
    ]);
    expect(graph.candidates.map((candidate) => candidate.reason)).toEqual([
      "multiple-inci-matches",
      "multiple-rxcui-matches",
      "multiple-structure-matches",
    ]);
  });
});

describe("identity chain (c): product resolution", () => {
  it("returns product links and role-annotated ingredient refs for an NDC", async () => {
    const record = productRecord(
      {
        name: "Lipitor",
        category: "medication",
        identifiers: {
          ndc: ["00093-1046"],
          rxcui: ["617314"],
          applicationNumber: "NDA020702",
          splSetId: "a1e07d5c-2056-46f3-8737-f03ed0b4bae8",
        },
        source: {
          database: "openFDA",
          id: "00093-1046",
          url: "https://api.fda.gov/drug/ndc.json?search=product_ndc",
          retrievedAt: ISO,
        },
      },
      [
        ingredient("atorvastatin calcium", {
          role: "active",
          quantity: "10 mg",
          identifiers: { unii: "A0JWA85V8F" },
          source: {
            database: "openFDA",
            id: "00093-1046",
            url: "https://api.fda.gov/drug/ndc.json?search=product_ndc",
            retrievedAt: ISO,
          },
        }),
      ],
    );

    const result = await createIdentityResolver(
      deps({
        openfda: { productByNdc: async () => record },
        nlm: {
          rxcuisForNdc: async () => ["617314"],
          splsForNdc: async () => ["a1e07d5c-2056-46f3-8737-f03ed0b4bae8"],
        },
      }),
    ).resolve({ ndc: "00093-1046" }, { resolveIngredients: true });

    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.links.map((link) => link.database)).toEqual([
      "openFDA",
      "openFDA",
      "RxNorm",
      "DailyMed",
    ]);
    expect(result.links.map((link) => link.id)).toEqual([
      "00093-1046",
      "NDA020702",
      "617314",
      "a1e07d5c-2056-46f3-8737-f03ed0b4bae8",
    ]);
    expect(result.links.find((link) => link.database === "RxNorm")?.id).toBe(
      "617314",
    );
    expect(result.ingredients[0]?.role).toBe("active");
    expect(result.ingredients[0]?.quantity).toBe("10 mg");
    expect(result.graphs).toHaveLength(1);
    expect(result.graphs?.[0]?.identifiers.unii).toBe("A0JWA85V8F");
  });

  it("omits graphs unless resolveIngredients is requested", async () => {
    const result = await createIdentityResolver(
      deps({
        openfda: {
          productByNdc: async () =>
            productRecord(
              {
                name: "Lipitor",
                category: "medication",
                identifiers: { ndc: ["00093-1046"] },
                source: {
                  database: "openFDA",
                  id: "00093-1046",
                  url: "https://example.test/ndc",
                  retrievedAt: ISO,
                },
              },
              [],
            ),
        },
      }),
    ).resolve({ ndc: "00093-1046" }, {});

    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.graphs).toBeUndefined();
  });

  it("parses SPL ingredients for a set id and falls back to the record", async () => {
    const setid = "a1e07d5c-2056-46f3-8737-f03ed0b4bae8";
    const xml = textFixture("nlm/dailymed-spl-a1e07d5c.xml");
    const result = await createIdentityResolver(
      deps({
        nlm: { getSplXml: async () => xml },
        openfda: {
          productBySetId: async () =>
            productRecord(
              {
                name: "Sovereign Silver",
                category: "medication",
                identifiers: { splSetId: setid, rxcui: ["999"] },
                source: {
                  database: "openFDA",
                  id: setid,
                  url: "https://example.test/label",
                  retrievedAt: ISO,
                },
              },
              [ingredient("fallback", { role: "active" })],
            ),
        },
      }),
    ).resolve({ splSetId: setid }, {});

    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(
      result.links.map((link) => [link.database, link.confidence]),
    ).toEqual([
      ["openFDA", "derived"],
      ["RxNorm", "derived"],
      ["DailyMed", "direct"],
    ]);
    expect(result.ingredients.map((item) => item.role)).toEqual([
      "active",
      "inactive",
    ]);
    expect(result.ingredients[0]?.identifiers.unii).toBe("3M4G523W1G");
  });

  it("resolves a DSLD label to its own ingredient rows", async () => {
    const result = await createIdentityResolver(
      deps({
        dsld: {
          label: async () =>
            productRecord(
              {
                name: "Example D3",
                category: "supplement",
                identifiers: { dsldId: 82118 },
                source: {
                  database: "DSLD",
                  id: "82118",
                  url: "https://dsld.od.nih.gov/label/82118",
                  retrievedAt: ISO,
                },
              },
              [ingredient("Vitamin D3", { role: "active" })],
            ),
        },
      }),
    ).resolve({ dsldId: 82118 }, {});

    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.links).toEqual([
      {
        database: "DSLD",
        id: "82118",
        url: "https://dsld.od.nih.gov/label/82118",
        matchedVia: "dsldId",
        confidence: "direct",
      },
    ]);
    expect(result.ingredients).toHaveLength(1);
  });
});

describe("identity chain (d): zero matches are ordinary", () => {
  it("returns no links or candidates for an unknown UNII", async () => {
    const graph = await resolveIngredient({ unii: "UNKNOWNUNII" });

    expect(graph.links).toEqual([]);
    expect(graph.candidates).toEqual([]);
    expect(graph.identifiers.unii).toBe("UNKNOWNUNII");
    expect(graph.subject).toEqual({});
  });

  it("returns an empty graph for an unknown name", async () => {
    const graph = await resolveIngredient({ substanceName: "nothing at all" });
    expect(graph.links).toEqual([]);
    expect(graph.candidates).toEqual([]);
    expect(graph.identifiers).toEqual({});
  });
});

describe("identity chain (e): weak terminals are always candidates", () => {
  it("labels DSLD and INKEEDecoder name matches without linking them", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () =>
            ingredient("ASPIRIN", {
              inciName: "SALICYLIC ACID",
              identifiers: { unii: "R16CO5Y76E", cas: ["50-78-2"] },
            }),
        },
        dsld: { ingredientGroupsByName: async () => DSLD_GROUPS },
        inkeedecoder: {
          getIngredient: async () =>
            ikdIngredient({
              cosing: { cas: "50-78-2", ec: "200-064-1" },
            }),
        },
      },
    );

    expect(graph.links.some((link) => link.database === "DSLD")).toBe(false);
    expect(graph.links.some((link) => link.database === "INKEEDecoder")).toBe(
      false,
    );
    const dsld = graph.candidates.find(
      (candidate) => candidate.database === "DSLD",
    );
    expect(dsld?.reason).toBe("name-match");
    expect(dsld?.matchedVia).toBe("ingredient-name");
    expect(dsld?.options).toHaveLength(2);
    const ikd = graph.candidates.find(
      (candidate) => candidate.database === "INKEEDecoder",
    );
    expect(ikd?.reason).toBe("name-match");
    expect(ikd?.options[0]?.matchBasis).toBe("CAS cross-check: 50-78-2");
    expect(ikd?.options[0]?.identifiers.cas).toEqual(["50-78-2"]);
  });
});

describe("two-pass invalidation", () => {
  it("re-runs openFDA after CosIng supplies an INCI name", async () => {
    const byCas = vi.fn(
      async (_cas: string): Promise<IngredientRef | null> => null,
    );
    const substancesByName = vi.fn(
      async (): Promise<OpenFdaSubstanceHit[]> => [
        {
          ingredient: ingredient("SALICYLIC ACID", {
            identifiers: { unii: "O414PZ4LPZ" },
          }),
          tier: "exact",
        },
      ],
    );
    const graph = await resolveIngredient(
      { cas: "69-72-7" },
      {
        openfda: { substanceByCas: byCas, substancesByName },
        cosing: { byCas: async () => [cosingHit("SALICYLIC ACID")] },
      },
    );

    expect(byCas).toHaveBeenCalledTimes(2);
    expect(substancesByName).toHaveBeenCalledWith("SALICYLIC ACID", undefined);
    expect(graph.links.map((link) => link.database)).toEqual([
      "openFDA",
      "CosIng",
    ]);
  });
});

describe("default resolver wiring", () => {
  it("never throws when the default bridges cannot reach upstream", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await resolveIdentity({ unii: "UNKNOWNUNII" });
      expect(result.kind).toBe("ingredient");
      if (result.kind !== "ingredient") return;
      expect(result.graph.links).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps an INKEEDecoder bridge value and treats a rejection as no candidate", async () => {
    const getIngredientBySlug = vi
      .fn()
      .mockResolvedValueOnce(ikdIngredient())
      .mockRejectedValueOnce(new Error("not found"));
    const bridge = { getIngredientBySlug } as unknown as IkdBridges;
    const dep = createInkeedecoderIngredientDep(bridge);
    await expect(dep.getIngredient("niacinamide")).resolves.toEqual(
      ikdIngredient(),
    );
    await expect(dep.getIngredient("missing")).resolves.toBeNull();
  });
});

describe("candidate caps", () => {
  it("honors maxCandidates and always keeps at least one option", async () => {
    const hits = [1, 2, 3, 4].map((index) =>
      cosingHit(`CANDIDATE ${index}`, "text", false),
    );
    const capped = await resolveIngredient(
      { inciName: "candidate" },
      { cosing: { byInci: async () => hits } },
      { maxCandidates: 2 },
    );
    expect(capped.candidates[0]?.options).toHaveLength(2);

    const clamped = await resolveIngredient(
      { inciName: "candidate" },
      { cosing: { byInci: async () => hits } },
      { maxCandidates: 0 },
    );
    expect(clamped.candidates[0]?.options).toHaveLength(1);
  });
});

describe("failure isolation", () => {
  it("keeps other links when one step fails", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () => {
            throw new Error("@knorby/openfda-client failed");
          },
        },
        nlm: { rxcuisForUnii: async () => ["1191"] },
      },
    );

    expect(graph.links.map((link) => link.database)).toEqual(["RxNorm"]);
    expect(JSON.stringify(graph)).not.toContain("@knorby");
  });

  it("ignores a failing profile and a failing terminal search", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () =>
            ingredient("ASPIRIN", {
              identifiers: { unii: "R16CO5Y76E" },
            }),
        },
        drugcentral: {
          structIdsForUnii: async () => [74],
          getProfile: async () => {
            throw new Error("profile down");
          },
        },
        dsld: {
          ingredientGroupsByName: async () => {
            throw new Error("groups down");
          },
        },
        inkeedecoder: {
          getIngredient: async () => {
            throw new Error("ikd down");
          },
        },
      },
    );

    expect(graph.links.map((link) => link.database)).toEqual([
      "openFDA",
      "DrugCentral",
    ]);
    expect(graph.identifiers.structId).toBe(74);
  });
});

describe("product failure isolation", () => {
  it("returns what it can when every product bridge fails", async () => {
    const result = await createIdentityResolver(
      deps({
        openfda: {
          productByNdc: async () => {
            throw new Error("openfda down");
          },
        },
        nlm: {
          rxcuisForNdc: async () => {
            throw new Error("rxnorm down");
          },
          splsForNdc: async () => {
            throw new Error("dailymed down");
          },
        },
      }),
    ).resolve({ ndc: "00093-1046" }, { includeLabelIngredients: true });

    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.links).toEqual([]);
    expect(result.ingredients).toEqual([]);
  });

  it("returns an empty ingredient list when a DSLD label misses", async () => {
    const result = await createIdentityResolver(deps()).resolve(
      { dsldId: 999 },
      {},
    );
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.links).toHaveLength(1);
    expect(result.ingredients).toEqual([]);
  });
});

describe("fixture shape checks", () => {
  it("keeps the captured ingredient-group fixture aligned with the bridge", () => {
    const groups = fixture<{ hits: { _source?: { groupName?: string } }[] }>(
      "dsld/ingredient-groups-calcium.json",
    );
    expect(groups.hits[0]?._source?.groupName).toBe("Calcium");
  });
});

describe("edge paths", () => {
  it("uses an INCI-tier openFDA hit as a confident name match", async () => {
    const graph = await resolveIngredient(
      { inciName: "NIACINAMIDE" },
      {
        openfda: {
          substancesByName: async () => [
            {
              ingredient: ingredient("NIACINAMIDE", {
                identifiers: { unii: "25X51I8RD4" },
              }),
              tier: "inci",
            },
          ],
        },
        cosing: { byInci: async () => [cosingHit("NIACINAMIDE")] },
      },
    );
    expect(graph.links[0]?.matchedVia).toBe("inci");
    expect(graph.links[1]?.confidence).toBe("direct");
  });

  it("treats multiple CAS hits and multiple exact INCI hits distinctly", async () => {
    const casGraph = await resolveIngredient(
      { cas: "50-78-2" },
      {
        cosing: {
          byCas: async () => [
            cosingHit("A", "casNo", true),
            cosingHit("B", "casNo", true),
          ],
        },
      },
    );
    expect(casGraph.candidates[0]?.reason).toBe("multiple-cas-matches");

    const inciGraph = await resolveIngredient(
      { inciName: "SALICYLIC ACID" },
      {
        cosing: {
          byInci: async () => [
            cosingHit("SALICYLIC ACID"),
            cosingHit("SALICYLIC ACID 2"),
          ],
        },
      },
    );
    expect(inciGraph.links[0]?.confidence).toBe("direct");
  });

  it("falls back to the rxcui as a candidate option name", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      { nlm: { rxcuisForUnii: async () => ["1191", "1192"] } },
    );
    expect(graph.candidates[0]?.options.map((option) => option.name)).toEqual([
      "1191",
      "1192",
    ]);
  });

  it("maps profile identifier types and CAS fallbacks", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () =>
            ingredient("ASPIRIN", {
              identifiers: { unii: "R16CO5Y76E" },
            }),
        },
        drugcentral: {
          structIdsForUnii: async () => [74],
          getProfile: async () =>
            profile(
              [
                idRow("UNII", "R16CO5Y76E"),
                idRow("UNII", "SECOND"),
                idRow("DRUGBANK_ID", "DB00945"),
              ],
              "aspirin",
              "50-78-2",
            ),
        },
      },
    );
    expect(graph.identifiers).toMatchObject({
      unii: "R16CO5Y76E",
      cas: ["50-78-2"],
    });
    expect(graph.identifiers.rxcui).toBeUndefined();
  });

  it("falls back to a synthetic DrugCentral name and empty identifiers", async () => {
    const graph = await resolveIngredient(
      { rxcui: "1191" },
      {
        drugcentral: {
          structIdsForRxcui: async () => [74],
          getProfile: async () => profile([], null, null),
        },
      },
    );
    const dc = graph.links.find((link) => link.database === "DrugCentral");
    expect(dc?.id).toBe("74");
    expect(
      graph.candidates.length +
        graph.links.filter((link) => link.database === "DrugCentral").length,
    ).toBe(1);
    expect(graph.identifiers.structId).toBe(74);
    expect(graph.identifiers.cas).toBeUndefined();
  });

  it("cross-checks an INKEEDecoder EC panel and falls back to a slug guess", async () => {
    const ecGraph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () =>
            ingredient("ASPIRIN", {
              identifiers: { unii: "R16CO5Y76E", cas: ["50-78-2"] },
            }),
        },
        cosing: { byInci: async () => [cosingHit("ASPIRIN")] },
        inkeedecoder: {
          getIngredient: async () =>
            ikdIngredient({ cosing: { ec: "200-064-1" } }),
        },
      },
    );
    const ecCandidate = ecGraph.candidates.find(
      (candidate) => candidate.database === "INKEEDecoder",
    );
    expect(ecCandidate?.options[0]?.matchBasis).toBe(
      "EC cross-check: 200-064-1",
    );

    const plainGraph = await resolveIngredient(
      { substanceName: "Niacinamide" },
      {
        inkeedecoder: {
          getIngredient: async () =>
            ikdIngredient({ url: "", cosing: undefined }),
        },
      },
    );
    const plain = plainGraph.candidates.find(
      (candidate) => candidate.database === "INKEEDecoder",
    );
    expect(plain?.options[0]?.matchBasis).toBe("slug guess");
    expect(plain?.options[0]?.source.url).toBe(
      "https://inkeedecoder.com/ingredients/niacinamide",
    );
    expect(plain?.options[0]?.identifiers.cas).toBeUndefined();
    expect(plain?.options[0]?.identifiers.ec).toBeUndefined();
  });

  it("skips the INKEEDecoder guess when the name has no slug characters", async () => {
    const getIngredient = vi.fn();
    const graph = await resolveIngredient(
      { substanceName: "!!!" },
      { inkeedecoder: { getIngredient } },
    );
    expect(getIngredient).not.toHaveBeenCalled();
    expect(graph.candidates).toEqual([]);
  });

  it("parses a minimal SPL row without strength, form, or UNII", async () => {
    const xml = `<document xmlns="urn:hl7-org:v3"><component><structuredBody><component><section><subject><manufacturedProduct><manufacturedProduct><code code="x" codeSystem="2.16.840.1.113883.6.69"/><name>PRODUCT</name><ingredient classCode="OTHER"><ingredientSubstance><name>Mystery Ingredient</name></ingredientSubstance></ingredient></manufacturedProduct></manufacturedProduct></subject></section></component></structuredBody></component></document>`;
    const result = await createIdentityResolver(
      deps({
        nlm: { getSplXml: async () => xml },
      }),
    ).resolve({ splSetId: "setid-minimal" }, {});
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.ingredients).toEqual([
      {
        name: "Mystery Ingredient",
        identifiers: {},
        source: {
          database: "DailyMed",
          id: "setid-minimal",
          url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=setid-minimal",
          retrievedAt: expect.any(String),
        },
      },
    ]);
  });

  it("fills a missing SPL strength from the directory record", async () => {
    const xml = `<document xmlns="urn:hl7-org:v3"><component><structuredBody><component><section><subject><manufacturedProduct><manufacturedProduct><code code="x" codeSystem="2.16.840.1.113883.6.69"/><name>PRODUCT</name><ingredient classCode="ACT"><quantity><numerator value="10" unit="mg"/></quantity><ingredientSubstance><code code="ABC" codeSystem="2.16.840.1.113883.4.9"/><name>Ingredient One</name><formCode displayName="TABLET"/></ingredientSubstance></ingredient><ingredient classCode="ACT"><ingredientSubstance><name>Ingredient Two</name></ingredientSubstance></ingredient></manufacturedProduct></manufacturedProduct></subject></section></component></structuredBody></component></document>`;
    const result = await createIdentityResolver(
      deps({
        nlm: { getSplXml: async () => xml },
        openfda: {
          productByNdc: async () =>
            productRecord(
              {
                name: "Product",
                category: "medication",
                identifiers: {
                  ndc: ["00093-1046"],
                  splSetId: "setid-strength",
                },
                source: {
                  database: "openFDA",
                  id: "00093-1046",
                  url: "https://example.test/ndc",
                  retrievedAt: ISO,
                },
              },
              [
                ingredient("Ingredient One", { quantity: "10 mg" }),
                ingredient("Ingredient Two", { quantity: "5 mg" }),
              ],
            ),
        },
      }),
    ).resolve({ ndc: "00093-1046" }, { includeLabelIngredients: true });
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.ingredients[0]?.quantity).toBe("10 mg");
    expect(result.ingredients[0]?.form).toBe("TABLET");
    expect(result.ingredients[1]?.quantity).toBe("5 mg");
  });

  it("uses NLM set ids when the openFDA record is absent", async () => {
    const xml = textFixture("nlm/dailymed-spl-a1e07d5c.xml");
    const result = await createIdentityResolver(
      deps({
        nlm: {
          splsForNdc: async () => ["a1e07d5c-2056-46f3-8737-f03ed0b4bae8"],
          getSplXml: async () => xml,
        },
      }),
    ).resolve({ ndc: "00093-1046" }, { includeLabelIngredients: true });
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.ingredients).toHaveLength(2);
    expect(result.links.map((link) => link.database)).toEqual(["DailyMed"]);
  });

  it("falls back to record ingredients when label XML is empty or fails", async () => {
    for (const getSplXml of [
      async () => "",
      async () => {
        throw new Error("label down");
      },
    ]) {
      const result = await createIdentityResolver(
        deps({
          nlm: { getSplXml },
          openfda: {
            productByNdc: async () =>
              productRecord(
                {
                  name: "Product",
                  category: "medication",
                  identifiers: {
                    ndc: ["00093-1046"],
                    splSetId: "setid-1",
                  },
                  source: {
                    database: "openFDA",
                    id: "00093-1046",
                    url: "https://example.test/ndc",
                    retrievedAt: ISO,
                  },
                },
                [
                  ingredient("Fallback", {
                    role: "active",
                    quantity: "1 mg",
                  }),
                ],
              ),
          },
        }),
      ).resolve({ ndc: "00093-1046" }, { includeLabelIngredients: true });
      expect(result.kind).toBe("product");
      if (result.kind !== "product") return;
      expect(result.ingredients).toHaveLength(1);
      expect(result.ingredients[0]?.name).toBe("Fallback");
    }
  });

  it("skips label parsing when no set id can be found", async () => {
    const getSplXml = vi.fn();
    const result = await createIdentityResolver(
      deps({
        nlm: { getSplXml },
        openfda: {
          productByNdc: async () =>
            productRecord(
              {
                name: "Product",
                category: "medication",
                identifiers: { ndc: ["00093-1046"] },
                source: {
                  database: "openFDA",
                  id: "00093-1046",
                  url: "https://example.test/ndc",
                  retrievedAt: ISO,
                },
              },
              [],
            ),
        },
      }),
    ).resolve({ ndc: "00093-1046" }, { includeLabelIngredients: true });
    expect(result.kind).toBe("product");
    expect(getSplXml).not.toHaveBeenCalled();
  });

  it("falls back to an SPL record's own rows when XML is empty", async () => {
    const setid = "setid-fallback";
    const result = await createIdentityResolver(
      deps({
        nlm: { getSplXml: async () => "" },
        openfda: {
          productBySetId: async () =>
            productRecord(
              {
                name: "Product",
                category: "medication",
                identifiers: { splSetId: setid },
                source: {
                  database: "openFDA",
                  id: setid,
                  url: "https://example.test/label",
                  retrievedAt: ISO,
                },
              },
              [ingredient("Record Row", { role: "active" })],
            ),
        },
      }),
    ).resolve({ splSetId: setid }, {});
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.ingredients[0]?.name).toBe("Record Row");
    expect(result.links.some((link) => link.database === "RxNorm")).toBe(false);
  });

  it("resolves an ingredient graph by name when a product row has no UNII", async () => {
    const result = await createIdentityResolver(
      deps({
        openfda: {
          productByNdc: async () =>
            productRecord(
              {
                name: "Product",
                category: "medication",
                identifiers: { ndc: ["00093-1046"] },
                source: {
                  database: "openFDA",
                  id: "00093-1046",
                  url: "https://example.test/ndc",
                  retrievedAt: ISO,
                },
              },
              [ingredient("Unidentified Row")],
            ),
          substancesByName: async () => [
            {
              ingredient: ingredient("Unidentified Row", {
                identifiers: { unii: "ROWUNII" },
              }),
              tier: "exact",
            },
          ],
        },
      }),
    ).resolve({ ndc: "00093-1046" }, { resolveIngredients: true });
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.graphs?.[0]?.links[0]?.id).toBe("unidentified-row");
  });

  it("prefers the default resolver factory when no deps are passed", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await createIdentityResolver().resolve({
        substanceName: "unknown",
      });
      expect(result.kind).toBe("ingredient");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sorts equal-database links by id and deduplicates repeats", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        openfda: {
          substanceByUnii: async () =>
            ingredient("ASPIRIN", {
              identifiers: { unii: "R16CO5Y76E" },
            }),
        },
        drugcentral: {
          structIdsForUnii: async () => [74],
          getProfile: async () =>
            profile(
              [
                idRow("UNII", "R16CO5Y76E"),
                idRow("UNII", "R16CO5Y76E"),
                idRow("RXNORM", "1191"),
              ],
              "aspirin",
              "50-78-2",
            ),
        },
        nlm: { rxcuisForUnii: async () => ["1191"] },
      },
    );
    expect(new Set(graph.identifiers.cas)).toEqual(new Set(["50-78-2"]));
  });

  it("continues to the INCI search when a CAS search is empty", async () => {
    const graph = await resolveIngredient(
      { cas: "00-00-0" },
      {
        cosing: {
          byCas: async () => [],
          byInci: async () => [],
        },
      },
    );
    expect(graph.links).toEqual([]);
    expect(graph.candidates).toEqual([]);
  });

  it("names ambiguous DrugCentral options without a subject name", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      { drugcentral: { structIdsForUnii: async () => [74, 5375] } },
    );
    expect(graph.candidates[0]?.options.map((option) => option.name)).toEqual([
      "DrugCentral 74",
      "DrugCentral 5375",
    ]);
  });

  it("names a DrugCentral link without any subject or profile name", async () => {
    const graph = await resolveIngredient(
      { unii: "R16CO5Y76E" },
      {
        drugcentral: {
          structIdsForUnii: async () => [74],
          getProfile: async () => profile([], null),
        },
      },
    );
    const dc = graph.links.find((link) => link.database === "DrugCentral");
    expect(dc?.id).toBe("74");
    expect(graph.subject).toEqual({});
  });

  it("carries a DrugCentral crosswalk UNII into the identifiers", async () => {
    const graph = await resolveIngredient(
      { rxcui: "1191" },
      {
        drugcentral: {
          structIdsForRxcui: async () => [74],
          getProfile: async () =>
            profile(
              [idRow("UNII", "R16CO5Y76E"), idRow("RXNORM", "1191")],
              "aspirin",
            ),
        },
      },
    );
    expect(graph.identifiers.unii).toBe("R16CO5Y76E");
    expect(graph.identifiers.rxcui).toEqual(["1191"]);
  });

  it("marks crosswalk links derived when the UNII was learned", async () => {
    const graph = await resolveIngredient(
      { substanceName: "ASPIRIN" },
      {
        openfda: {
          substancesByName: async () => [
            {
              ingredient: ingredient("ASPIRIN", {
                identifiers: { unii: "R16CO5Y76E" },
              }),
              tier: "exact",
            },
          ],
        },
        nlm: { rxcuisForUnii: async () => ["1191"] },
        drugcentral: { structIdsForUnii: async () => [74] },
      },
    );
    expect(
      graph.links
        .filter((link) => ["RxNorm", "DrugCentral"].includes(link.database))
        .map((link) => link.confidence),
    ).toEqual(["derived", "derived"]);
  });

  it("uses record RxCUIs and application details when NLM has none", async () => {
    const result = await createIdentityResolver(
      deps({
        openfda: {
          productByNdc: async () => ({
            ...productRecord(
              {
                name: "Product",
                category: "medication",
                identifiers: { ndc: ["00093-1046"], rxcui: ["617314"] },
                source: {
                  database: "openFDA",
                  id: "00093-1046",
                  url: "https://example.test/ndc",
                  retrievedAt: ISO,
                },
              },
              [],
            ),
            details: { source: "ndc", applicationNumber: "NDA020702" },
          }),
        },
      }),
    ).resolve({ ndc: "00093-1046" }, {});
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.links.map((link) => link.id)).toEqual([
      "00093-1046",
      "NDA020702",
      "617314",
    ]);
  });

  it("returns an empty list for an SPL miss with no record", async () => {
    const result = await createIdentityResolver(
      deps({ nlm: { getSplXml: async () => "" } }),
    ).resolve({ splSetId: "missing-setid" }, {});
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.ingredients).toEqual([]);
  });
});
