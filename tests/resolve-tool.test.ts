import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/constants.js";
import {
  type GraphCoverage,
  type IngredientRef,
  type NextStep,
  type ProductRef,
  resolveIdentifiersResultSchema,
} from "../src/lib/schemas.js";
import type { CosingBridgeHit } from "../src/sources/cosing.js";
import type { DrugCentralBridges } from "../src/sources/drugcentral.js";
import {
  createIdentityResolver,
  type IdentityDeps,
  type IdentityGraph,
  type IdentityResolver,
  type IngredientResolution,
  type ProductResolution,
  type ResolveInput,
  type ResolveOptions,
} from "../src/sources/identity/chain.js";
import type {
  OpenFdaProductRecord,
  OpenFdaSubstanceHit,
} from "../src/sources/openfda.js";
import { registerResolveIdentifiersTool } from "../src/tools/resolve-identifiers.js";
import { createTestClient, type TestHarness, textOf } from "./helpers.js";

/**
 * `drugdata_resolve_identifiers` is driven through a real MCP client against a
 * test server wired to fixture-backed identity bridges. The tool validates the
 * one-identifier contract before the chain runs, so these tests assert both the
 * refusal text and the graph/product shapes a host receives.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url);
const ISO = "2026-10-22T12:00:00.000Z";
const SETID = "a1e07d5c-2056-46f3-8737-f03ed0b4bae8";
const TOOL = "drugdata_resolve_identifiers";

const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
] as const;

for (const key of ENV_KEYS) delete process.env[key];

function textFixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

/** Builds an ingredient ref with source defaults. */
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
        id: "12345",
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
): ProfileResult {
  return {
    data: {
      structure: structure(name),
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

/** An openFDA product record with the given rows. */
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

/** Builds an openFDA product ref. */
function openFdaProduct(
  id: string,
  identifiers: ProductRef["identifiers"] = { ndc: [id] },
): ProductRef {
  return {
    name: "Lipitor",
    category: "medication",
    identifiers,
    source: {
      database: "openFDA",
      id,
      url: `https://example.test/openfda/product/${encodeURIComponent(id)}`,
      retrievedAt: ISO,
    },
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

/** Builds an empty ingredient graph, with overrides. */
function graph(partial: Partial<IdentityGraph> = {}): IdentityGraph {
  return {
    subject: {},
    identifiers: {},
    links: [],
    candidates: [],
    ...partial,
  };
}

/** Builds an empty ingredient resolution. */
function ingredientResolution(
  partial: Partial<IdentityGraph> = {},
): IngredientResolution {
  return { kind: "ingredient", graph: graph(partial) };
}

/** Builds an empty product resolution. */
function productResolution(
  partial: Partial<ProductResolution> = {},
): ProductResolution {
  return {
    kind: "product",
    links: [],
    candidates: [],
    ingredients: [],
    ...partial,
  };
}

/** A resolver that fails the test if the tool reaches the engine. */
const panicResolver: IdentityResolver = {
  resolve: async () => {
    throw new Error("the engine must not run for invalid input");
  },
};

/** A resolver that throws, for the tool's failure path. */
const throwingResolver: IdentityResolver = {
  resolve: async () => {
    throw new Error("@knorby/openfda-client exploded");
  },
};

interface RecordedCall {
  input: ResolveInput;
  opts: ResolveOptions | undefined;
}

/** Records the engine input and returns a harmless result. */
function recordingResolver(): {
  resolver: IdentityResolver;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    resolver: {
      async resolve(input, opts) {
        calls.push({ input, opts });
        const product =
          input.ndc !== undefined ||
          input.splSetId !== undefined ||
          input.dsldId !== undefined;
        return product ? productResolution() : ingredientResolution();
      },
    },
  };
}

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Connects a real MCP client to a server exposing only the resolve tool. */
async function connect(resolver?: IdentityResolver): Promise<TestHarness> {
  harness = await createTestClient(() => {
    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    registerResolveIdentifiersTool(server, resolver);
    return server;
  });
  return harness;
}

/** Calls the resolve tool and returns the raw result. */
async function call(
  client: TestHarness["client"],
  args: Record<string, unknown>,
) {
  return await client.callTool({ name: TOOL, arguments: args });
}

describe("resolve_identifiers input validation", () => {
  it("rejects a call with no identifier and names every allowed key", async () => {
    const client = await connect(panicResolver);

    const result = await call(client.client, {});

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("exactly one identifier");
    expect(text).toContain("None were provided");
    for (const key of [
      "unii",
      "ndc",
      "rxcui",
      "cas",
      "inci_name",
      "substance_name",
      "spl_setid",
      "dsld_id",
    ]) {
      expect(text).toContain(key);
    }
  });

  it("rejects a call with two identifiers and names those received", async () => {
    const client = await connect(panicResolver);

    const result = await call(client.client, {
      unii: "R16CO5Y76E",
      ndc: "00093-1046",
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("exactly one identifier");
    expect(text).toContain("received unii, ndc");
  });

  it.each([
    ["unii", { unii: "too-short" }, "10 letters or digits"],
    ["ndc", { ndc: "not-an-ndc" }, "10- or 11-digit NDC"],
    ["ndc", { ndc: "1234-567" }, "10- or 11-digit NDC"],
    ["rxcui", { rxcui: "abc" }, "numeric RxCUI"],
    ["cas", { cas: "50-78" }, "dashed CAS"],
    ["inci_name", { inci_name: "   " }, "non-empty name"],
    ["substance_name", { substance_name: "" }, "non-empty name"],
    ["spl_setid", { spl_setid: "not-a-set-id" }, "SPL set id"],
    ["dsld_id", { dsld_id: 0 }, "positive integer DSLD"],
    ["dsld_id", { dsld_id: 1.5 }, "positive integer DSLD"],
    [
      "dsld_id",
      { dsld_id: Number.MAX_SAFE_INTEGER + 2 },
      "positive integer DSLD",
    ],
    ["dsld_id", { dsld_id: "not-a-dsld-id" }, "positive integer DSLD"],
  ])(
    "rejects a malformed %s before calling the engine",
    async (_key, args, expected) => {
      const client = await connect(panicResolver);

      const result = await call(client.client, args);

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain(expected);
      expect(text).toContain("drugdata_");
    },
  );

  it("bounds a very long malformed value in the error text", async () => {
    const client = await connect(panicResolver);

    const result = await call(client.client, {
      substance_name: "x".repeat(5_000),
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeLessThan(1_000);
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(81));
  });

  it.each([
    [{ unii: " r16co5y76e " }, { unii: "R16CO5Y76E" }],
    [{ ndc: "00093104601" }, { ndc: "00093104601" }],
    [{ ndc: "00093-1046" }, { ndc: "00093-1046" }],
    [{ ndc: "00093-1046-01" }, { ndc: "00093104601" }],
    [{ rxcui: " 1191 " }, { rxcui: "1191" }],
    [{ cas: " 50-78-2 " }, { cas: "50-78-2" }],
    [{ inci_name: " Niacinamide " }, { inciName: "Niacinamide" }],
    [{ substance_name: " Aspirin " }, { substanceName: "Aspirin" }],
    [{ spl_setid: ` ${SETID.toUpperCase()} ` }, { splSetId: SETID }],
    [{ dsld_id: 82118 }, { dsldId: 82118 }],
    [{ dsld_id: "82118" }, { dsldId: 82118 }],
  ])("normalizes %j before calling the engine", async (args, expected) => {
    const recording = recordingResolver();
    const client = await connect(recording.resolver);

    const result = await call(client.client, args);

    expect(result.isError).toBeUndefined();
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.input).toEqual(expected);
  });

  it("passes the cost flags and candidate cap through to the engine", async () => {
    const recording = recordingResolver();
    const client = await connect(recording.resolver);

    await call(client.client, {
      unii: "R16CO5Y76E",
      include_label_ingredients: true,
      resolve_ingredients: true,
      max_candidates: 7,
    });

    expect(recording.calls[0]?.opts).toEqual({
      includeLabelIngredients: true,
      resolveIngredients: true,
      maxCandidates: 7,
    });
  });

  it("defaults the cost flags off and the candidate cap to five", async () => {
    const recording = recordingResolver();
    const client = await connect(recording.resolver);

    await call(client.client, { unii: "R16CO5Y76E" });

    expect(recording.calls[0]?.opts).toEqual({
      includeLabelIngredients: false,
      resolveIngredients: false,
      maxCandidates: 5,
    });
  });
});

describe("resolve_identifiers ingredient resolution", () => {
  /** A full UNII chain across all four confident sources. */
  function fullChainDeps(): IdentityDeps {
    return deps({
      openfda: {
        substanceByUnii: async () =>
          ingredient("ASPIRIN", {
            inciName: "SALICYLIC ACID",
            identifiers: { unii: "R16CO5Y76E", cas: ["50-78-2"] },
            source: {
              database: "openFDA",
              id: "R16CO5Y76E",
              url: "https://example.test/openfda/R16CO5Y76E",
              retrievedAt: ISO,
            },
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
    });
  }

  it("returns the chain graph and link-driven follow-ups for a UNII", async () => {
    const client = await connect(createIdentityResolver(fullChainDeps()));

    const result = await call(client.client, { unii: "R16CO5Y76E" });

    expect(result.isError).toBeUndefined();
    expect(
      resolveIdentifiersResultSchema.parse(result.structuredContent),
    ).toEqual(result.structuredContent);
    const output = result.structuredContent as IngredientResolution & {
      nextSteps: NextStep[];
      confidence: {
        directLinks: number;
        derivedLinks: number;
        candidateSets: number;
      };
    };
    expect(output.kind).toBe("ingredient");
    expect(output.graph.subject).toEqual({
      name: "ASPIRIN",
      inciName: "SALICYLIC ACID",
    });
    expect(output.graph.links.map((link) => link.database)).toEqual([
      "openFDA",
      "CosIng",
      "RxNorm",
      "DrugCentral",
    ]);
    expect(output.graph.identifiers).toEqual({
      unii: "R16CO5Y76E",
      cas: ["50-78-2"],
      ec: ["200-064-1"],
      rxcui: ["1191"],
      structId: 74,
    });
    expect(output.confidence).toEqual({
      directLinks: 4,
      derivedLinks: 0,
      candidateSets: 0,
    });
    expect(output.nextSteps).toHaveLength(3);
    expect(output.nextSteps.map((step) => step.tool)).toEqual([
      "drugdata_get_ingredient",
      "drugdata_get_ingredient",
      "drugdata_get_ingredient",
    ]);
    expect(output.nextSteps.map((step) => step.input)).toEqual([
      { source: "openfda", id: "R16CO5Y76E" },
      { source: "cosing", id: "12345" },
      { source: "nlm", id: "1191" },
    ]);

    const text = textOf(result);
    expect(text).toContain("ASPIRIN");
    expect(text).toContain("## Links (4)");
    expect(text).toContain("## Confidence");
    expect(text).toContain("4 direct");
    expect(text).toContain("**Next steps**");
    expect(text).not.toContain("@knorby");
  });

  it("returns candidate sets and a search follow-up for an ambiguous name", async () => {
    const client = await connect(
      createIdentityResolver(
        deps({
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
          dsld: {
            ingredientGroupsByName: async () => [
              ingredient("Glycerin", {
                identifiers: { cas: ["56-81-5"] },
                source: {
                  database: "DSLD",
                  id: "glycerin",
                  url: "https://dsld.od.nih.gov/ingredient/Glycerin",
                  retrievedAt: ISO,
                },
              }),
            ],
          },
        }),
      ),
    );

    const result = await call(client.client, { substance_name: "glycerin" });

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as IngredientResolution & {
      nextSteps: NextStep[];
      confidence: { candidateSets: number };
    };
    expect(output.graph.links.map((link) => link.database)).toEqual(["CosIng"]);
    expect(output.graph.candidates.map((set) => set.database)).toEqual([
      "openFDA",
      "DSLD",
    ]);
    expect(output.confidence.candidateSets).toBe(2);
    expect(output.nextSteps).toContainEqual(
      expect.objectContaining({
        tool: "drugdata_search_ingredients",
        input: { type: "name", query: "GLYCERIN METHYL ETHER" },
      }),
    );
    const text = textOf(result);
    expect(text).toContain("## Candidates (2)");
    expect(text).toContain("multiple-substance-matches");
    expect(text).toContain("name-match");
  });

  it("renders an empty graph without follow-ups", async () => {
    const client = await connect({
      resolve: async () => ingredientResolution(),
    });

    const result = await call(client.client, { unii: "AAAAAAAAAA" });

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as IngredientResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([]);
    const text = textOf(result);
    expect(text).toContain("Unknown subject");
    expect(text).toContain("No confident cross-source links");
    expect(text).toContain("No ambiguous candidates");
    expect(text).not.toContain("**Next steps**");
  });

  it("names the cap when a candidate set was truncated", async () => {
    const client = await connect({
      resolve: async () =>
        ingredientResolution({
          candidates: [
            {
              database: "RxNorm",
              matchedVia: "unii",
              reason: "name-match",
              options: Array.from({ length: 6 }, (_, index) =>
                ingredient(`Match ${index + 1}`),
              ),
              optionsTruncated: true,
            },
          ],
        }),
    });

    const result = await call(client.client, { unii: "R16CO5Y76E" });

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("## Candidates (1)");
    expect(text).toContain(
      "Only the first 6 options are shown; the source had more",
    );
    expect(text).toContain("Raise max_candidates");
    expect(text).toContain("- Match 6");
  });

  it("appends the truncation note to a JSON response that overflows", async () => {
    const client = await connect({
      resolve: async () =>
        ingredientResolution({
          identifiers: { cas: ["x".repeat(40_000)] },
        }),
    });

    const result = await call(client.client, {
      unii: "R16CO5Y76E",
      response_format: "json",
    });

    expect(result.isError).toBeUndefined();
    const blocks = result.content.filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toContain("cas");
    expect(blocks[0]?.text.length).toBeLessThan(40_000);
    expect(blocks[1]?.text).toContain("Some fields were shortened");
    expect(blocks[1]?.text).toContain("25,000");
  });

  it("maps confident ingredient links to their own record lookups", async () => {
    const client = await connect({
      resolve: async () =>
        ingredientResolution({
          links: [
            {
              database: "openFDA",
              id: "50-78-2",
              url: "https://example.test/openfda/50-78-2",
              matchedVia: "cas",
              confidence: "direct",
            },
            {
              database: "INKEEDecoder",
              id: "squalane",
              url: "https://inkeedecoder.com/ingredients/squalane",
              matchedVia: "slug",
              confidence: "derived",
            },
            {
              database: "DailyMed",
              id: SETID,
              url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SETID}`,
              matchedVia: "ndc",
              confidence: "derived",
            },
          ],
        }),
    });

    const result = await call(client.client, { unii: "R16CO5Y76E" });

    const output = result.structuredContent as IngredientResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps.map((step) => step.input)).toEqual([
      { source: "openfda", id: "50-78-2" },
      { source: "inkeedecoder", id: "squalane" },
      { source: "dailymed", id: SETID },
    ]);
  });

  it("ignores empty candidate sets and renders options without identifiers", async () => {
    const client = await connect({
      resolve: async () =>
        ingredientResolution({
          links: [
            {
              database: "openFDA",
              id: "no-usable-id",
              url: "https://example.test/openfda/no-usable-id",
              matchedVia: "substance name",
              confidence: "derived",
            },
          ],
          candidates: [
            {
              database: "openFDA",
              matchedVia: "substance name",
              reason: "multiple-substance-matches",
              options: [],
            },
            {
              database: "DSLD",
              matchedVia: "ingredient-name",
              reason: "name-match",
              options: [ingredient("Glycerin")],
            },
          ],
        }),
    });

    const result = await call(client.client, { substance_name: "glycerin" });

    const output = result.structuredContent as IngredientResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([
      {
        tool: "drugdata_search_ingredients",
        input: { type: "name", query: "Glycerin" },
        why: expect.any(String),
      },
    ]);
    const text = textOf(result);
    expect(text).toContain(
      "- Glycerin — https://example.test/openfda/Glycerin",
    );
  });

  it("renders an INCI-only subject and its INCI line", async () => {
    const client = await connect({
      resolve: async () =>
        ingredientResolution({
          subject: { inciName: "Niacinamide" },
          identifiers: { ec: ["200-584-9"] },
        }),
    });

    const result = await call(client.client, { inci_name: "Niacinamide" });

    const text = textOf(result);
    expect(text).toContain("## Identity — Niacinamide");
    expect(text).toContain("- INCI: Niacinamide");
  });

  it("bounds candidate follow-up names and skips unusable ones", async () => {
    const longName = `  ${"c".repeat(250)}  `;
    const client = await connect({
      resolve: async () =>
        ingredientResolution({
          candidates: [
            {
              database: "openFDA",
              matchedVia: "substance name",
              reason: "multiple-substance-matches",
              options: [ingredient("   ")],
            },
            {
              database: "DSLD",
              matchedVia: "ingredient-name",
              reason: "name-match",
              options: [ingredient(longName)],
            },
          ],
        }),
    });

    const result = await call(client.client, { substance_name: "candidate" });

    const output = result.structuredContent as IngredientResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([
      {
        tool: "drugdata_search_ingredients",
        input: { type: "name", query: "c".repeat(200) },
        why: expect.any(String),
      },
    ]);
    expect(
      output.nextSteps.every((step) => {
        const query = step.input.query;
        return (
          typeof query === "string" &&
          query.trim().length > 0 &&
          query.length <= 200
        );
      }),
    ).toBe(true);
  });

  it("serializes the result as JSON when asked", async () => {
    const client = await connect(createIdentityResolver(fullChainDeps()));

    const result = await call(client.client, {
      unii: "R16CO5Y76E",
      response_format: "json",
    });

    const parsed = JSON.parse(textOf(result)) as {
      kind: string;
      graph: { identifiers: { unii: string } };
      nextSteps: NextStep[];
    };
    expect(parsed.kind).toBe("ingredient");
    expect(parsed.graph.identifiers.unii).toBe("R16CO5Y76E");
    expect(parsed.nextSteps).toHaveLength(3);
  });

  it("bounds an oversized graph and marks the text truncated", async () => {
    const links = Array.from({ length: 200 }, (_, index) => ({
      database: "openFDA" as const,
      id: `link-${index}`,
      url: `https://example.test/${"x".repeat(3_000)}/${index}`,
      matchedVia: "unii",
      confidence: "direct" as const,
    }));
    const client = await connect({
      resolve: async () => ingredientResolution({ links }),
    });

    const result = await call(client.client, { unii: "R16CO5Y76E" });

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as IngredientResolution & {
      nextSteps: NextStep[];
    };
    expect(output.graph.links.length).toBeLessThan(200);
    expect(output.graph.links[0]?.url).toContain("…[truncated]");
    expect(output.nextSteps.length).toBeLessThanOrEqual(3);
    expect(textOf(result)).toContain("Some fields were shortened");
  });

  it("returns a sanitized error when the engine throws", async () => {
    const client = await connect(throwingResolver);

    const result = await call(client.client, { unii: "R16CO5Y76E" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("failed unexpectedly");
    expect(text).not.toContain("@knorby");
    expect(text).not.toContain("exploded");
  });
});

describe("resolve_identifiers product resolution", () => {
  /** The NDC record with one active ingredient and cross-source links. */
  function ndcDeps(ingredients = [activeIngredient()]): IdentityDeps {
    return deps({
      openfda: {
        productByNdc: async () =>
          productRecord(
            openFdaProduct("00093-1046", {
              ndc: ["00093-1046"],
              rxcui: ["617314"],
              applicationNumber: "NDA020702",
              splSetId: SETID,
            }),
            ingredients,
          ),
      },
      nlm: {
        rxcuisForNdc: async () => ["617314"],
        splsForNdc: async () => [SETID],
      },
    });
  }

  /** One active ingredient row with a UNII. */
  function activeIngredient(name = "atorvastatin calcium"): IngredientRef {
    return ingredient(name, {
      role: "active",
      quantity: "10 mg",
      form: "tablet",
      identifiers: { unii: "A0JWA85V8F" },
      source: {
        database: "openFDA",
        id: "00093-1046",
        url: "https://example.test/openfda/product/00093-1046",
        retrievedAt: ISO,
      },
    });
  }

  it("returns product links, ingredient refs, and the ingredient-first follow-ups", async () => {
    const client = await connect(createIdentityResolver(ndcDeps()));

    const result = await call(client.client, { ndc: "00093-1046" });

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
      confidence: { directLinks: number; derivedLinks: number };
    };
    expect(output.kind).toBe("product");
    expect(output.links.map((link) => link.database)).toEqual([
      "openFDA",
      "openFDA",
      "RxNorm",
      "DailyMed",
    ]);
    expect(output.ingredients[0]).toMatchObject({
      name: "atorvastatin calcium",
      role: "active",
      quantity: "10 mg",
    });
    expect(output.graphs).toBeUndefined();
    expect(output.confidence).toEqual({
      directLinks: 1,
      derivedLinks: 3,
      candidateSets: 0,
    });
    expect(output.nextSteps.map((step) => step.input)).toEqual([
      { unii: "A0JWA85V8F" },
      { source: "openfda", id: "00093-1046" },
      { source: "nlm", id: "617314" },
    ]);

    const text = textOf(result);
    expect(text).toContain("## Product links (4)");
    expect(text).toContain("## Ingredients (1)");
    expect(text).toContain("role: active");
    expect(text).toContain("form: tablet");
    expect(text).toContain("Set `resolve_ingredients: true`");
    expect(text).toContain("**Next steps**");
  });

  it("returns per-ingredient graphs when resolve_ingredients is on", async () => {
    const client = await connect(createIdentityResolver(ndcDeps()));

    const result = await call(client.client, {
      ndc: "00093-1046",
      resolve_ingredients: true,
    });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
      graphCoverage: GraphCoverage;
    };
    expect(output.graphs).toHaveLength(1);
    expect(output.graphs?.[0]?.identifiers.unii).toBe("A0JWA85V8F");
    expect(output.graphCoverage).toEqual({
      included: 1,
      total: 1,
      cap: 20,
      capped: false,
    });
    const text = textOf(result);
    expect(text).toContain("## Per-ingredient graphs (1 of 1)");
    expect(text).not.toContain("Set `resolve_ingredients: true`");
  });

  it("surfaces the graph prefix when a product has more ingredients than graphs", async () => {
    const rows = Array.from({ length: 22 }, (_, index) =>
      ingredient(`Ingredient ${index + 1}`, {
        role: "active",
        identifiers: {},
      }),
    );
    const client = await connect(createIdentityResolver(ndcDeps(rows)));

    const result = await call(client.client, {
      ndc: "00093-1046",
      resolve_ingredients: true,
    });

    const output = result.structuredContent as ProductResolution & {
      graphCoverage: GraphCoverage;
    };
    expect(output.graphs).toHaveLength(20);
    expect(output.graphCoverage).toEqual({
      included: 20,
      total: 22,
      cap: 20,
      capped: true,
    });
    const text = textOf(result);
    expect(text).toContain("only the first 20 of 22 ingredient rows");
    expect(text).toContain("caps per-call graphs at 20");

    const json = await call(client.client, {
      ndc: "00093-1046",
      resolve_ingredients: true,
      response_format: "json",
    });
    const parsed = JSON.parse(textOf(json)) as {
      graphCoverage: {
        included: number;
        total: number;
        cap: number;
        capped: boolean;
      };
    };
    expect(parsed.graphCoverage).toEqual(output.graphCoverage);
  });

  it("parses SPL XML for ingredient UNIIs when include_label_ingredients is on", async () => {
    const client = await connect(
      createIdentityResolver({
        ...ndcDeps(),
        nlm: {
          ...ndcDeps().nlm,
          getSplXml: async () => textFixture("nlm/dailymed-spl-a1e07d5c.xml"),
        },
      }),
    );

    const result = await call(client.client, {
      ndc: "00093-1046",
      include_label_ingredients: true,
    });

    const output = result.structuredContent as ProductResolution;
    expect(output.ingredients.map((item) => item.identifiers.unii)).toContain(
      "3M4G523W1G",
    );
    expect(output.ingredients.map((item) => item.name)).not.toContain(
      "atorvastatin calcium",
    );
  });

  it("resolves an SPL set id as a product with label ingredients", async () => {
    const client = await connect(
      createIdentityResolver(
        deps({
          openfda: {
            productBySetId: async () =>
              productRecord(
                openFdaProduct(SETID, {
                  splSetId: SETID,
                  rxcui: ["999"],
                }),
                [ingredient("fallback", { role: "active" })],
              ),
          },
          nlm: {
            getSplXml: async () => textFixture("nlm/dailymed-spl-a1e07d5c.xml"),
          },
        }),
      ),
    );

    const result = await call(client.client, { spl_setid: SETID });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.kind).toBe("product");
    expect(output.links).toContainEqual(
      expect.objectContaining({
        database: "DailyMed",
        id: SETID,
        confidence: "direct",
      }),
    );
    expect(output.ingredients.length).toBeGreaterThan(0);
    expect(output.nextSteps).toContainEqual(
      expect.objectContaining({
        tool: "drugdata_get_product",
        input: { source: "openfda", id: SETID },
      }),
    );
  });

  it("resolves a DSLD label and offers its product record", async () => {
    const client = await connect(
      createIdentityResolver(
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
                [ingredient("Vitamin D3")],
              ),
          },
        }),
      ),
    );

    const result = await call(client.client, { dsld_id: 82118 });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.links.map((link) => link.database)).toEqual(["DSLD"]);
    expect(output.ingredients.map((item) => item.name)).toEqual(["Vitamin D3"]);
    expect(output.nextSteps).toEqual([
      {
        tool: "drugdata_get_product",
        input: { source: "dsld", id: "82118" },
        why: expect.any(String),
      },
      {
        tool: "drugdata_resolve_identifiers",
        input: { substance_name: "Vitamin D3" },
        why: expect.any(String),
      },
    ]);
  });

  it("resolves a product ingredient by INCI when it has no UNII", async () => {
    const client = await connect({
      resolve: async () =>
        productResolution({
          ingredients: [
            ingredient("Niacinamide", {
              inciName: "Niacinamide",
              role: "inactive",
            }),
          ],
        }),
    });

    const result = await call(client.client, { ndc: "00093-1046" });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([
      {
        tool: "drugdata_resolve_identifiers",
        input: { inci_name: "Niacinamide" },
        why: expect.any(String),
      },
    ]);
    expect(textOf(result)).toContain("INCI: Niacinamide");
  });

  it("truncates a long ingredient name in the name follow-up", async () => {
    const name = "n".repeat(250);
    const client = await connect({
      resolve: async () =>
        productResolution({ ingredients: [ingredient(name)] }),
    });

    const result = await call(client.client, { ndc: "00093-1046" });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([
      {
        tool: "drugdata_resolve_identifiers",
        input: { substance_name: name.slice(0, 200) },
        why: expect.any(String),
      },
    ]);
  });

  it("skips an ingredient name that cannot become a valid follow-up", async () => {
    const client = await connect({
      resolve: async () =>
        productResolution({
          ingredients: [ingredient("", { inciName: "   " })],
        }),
    });

    const result = await call(client.client, { ndc: "00093-1046" });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([]);
  });

  it("renders a product with no links, ingredients, or graphs", async () => {
    const client = await connect({
      resolve: async () => productResolution({ graphs: [] }),
    });

    const result = await call(client.client, { ndc: "00093-1046" });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([]);
    const text = textOf(result);
    expect(text).toContain("No confident product links");
    expect(text).toContain("No ingredient rows");
    expect(text).toContain("No per-ingredient graphs");
  });

  it("skips links whose ids are not usable lookups", async () => {
    const client = await connect({
      resolve: async () =>
        productResolution({
          links: [
            {
              database: "openFDA",
              id: "NDA020702",
              url: "https://example.test/application/NDA020702",
              matchedVia: "application-number",
              confidence: "derived",
            },
            {
              database: "openFDA",
              id: "also-not-an-ndc",
              url: "https://example.test/other",
              matchedVia: "unknown",
              confidence: "derived",
            },
            {
              database: "CosIng",
              id: "12345",
              url: "https://example.test/cosing/12345",
              matchedVia: "cas",
              confidence: "direct",
            },
            {
              database: "DailyMed",
              id: "not-a-set-id",
              url: "https://example.test/dailymed/not-a-set-id",
              matchedVia: "ndc",
              confidence: "derived",
            },
            {
              database: "RxNorm",
              id: "not-numeric",
              url: "https://example.test/rxnorm/not-numeric",
              matchedVia: "ndc",
              confidence: "derived",
            },
            {
              database: "DSLD",
              id: "not-a-dsld-id",
              url: "https://example.test/dsld/not-a-dsld-id",
              matchedVia: "ndc",
              confidence: "derived",
            },
          ],
        }),
    });

    const result = await call(client.client, { ndc: "00093-1046" });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([]);
  });

  it("deduplicates identical follow-up calls", async () => {
    const link = {
      database: "RxNorm" as const,
      id: "617314",
      url: "https://example.test/rxnorm/617314",
      matchedVia: "ndc",
      confidence: "derived" as const,
    };
    const client = await connect({
      resolve: async () => productResolution({ links: [link, { ...link }] }),
    });

    const result = await call(client.client, { ndc: "00093-1046" });

    const output = result.structuredContent as ProductResolution & {
      nextSteps: NextStep[];
    };
    expect(output.nextSteps).toEqual([
      {
        tool: "drugdata_get_ingredient",
        input: { source: "nlm", id: "617314" },
        why: expect.any(String),
      },
    ]);
  });
});

describe("resolve configuration and source failures", () => {
  it("returns the configuration error instead of an empty graph", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "not-a-source";
    resetConfig();
    resetClients();
    try {
      const client = await connect();
      const result = await call(client.client, { unii: "R16CO5Y76E" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("DRUGDATA_DISABLED_SOURCES");
      expect(result.structuredContent).toBeUndefined();
    } finally {
      delete process.env.DRUGDATA_DISABLED_SOURCES;
      resetConfig();
      resetClients();
    }
  });

  it("renders source failures the chain recorded", async () => {
    const client = await connect(
      createIdentityResolver(
        deps({
          openfda: {
            substanceByUnii: async () => {
              throw new Error("@knorby/openfda-client is down");
            },
          },
          nlm: { rxcuisForUnii: async () => ["1191"] },
        }),
      ),
    );

    const result = await call(client.client, { unii: "R16CO5Y76E" });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as IngredientResolution;
    expect(output.graph.errors).toEqual([
      {
        database: "openFDA",
        message: expect.stringContaining(
          "the openFDA identity step failed unexpectedly",
        ),
      },
    ]);
    const text = textOf(result);
    expect(text).toContain("⚠ openFDA unavailable");
    expect(text).not.toContain("@knorby");
  });

  it("renders a configuration failure inside the graph", async () => {
    const client = await connect(
      createIdentityResolver(
        deps({
          openfda: {
            substanceByUnii: async () => {
              throw new Error("Invalid environment configuration: bad timeout");
            },
          },
        }),
      ),
    );

    const result = await call(client.client, { unii: "R16CO5Y76E" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("⚠ Configuration error");
  });
});

describe("resolve disabled sources", () => {
  function sourceUrl(input: RequestInfo | URL): string {
    return String(input);
  }

  it("queries no source when every adapter is disabled", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES =
      "openfda,cosing,nlm,drugcentral,dsld,inkeedecoder";
    resetConfig();
    resetClients();
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = await connect();
      const result = await call(client.client, { unii: "R16CO5Y76E" });

      expect(result.isError).toBeFalsy();
      const output = result.structuredContent as IngredientResolution;
      expect(output.graph.links).toEqual([]);
      expect(output.graph.candidates).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.DRUGDATA_DISABLED_SOURCES;
      resetConfig();
      resetClients();
      vi.unstubAllGlobals();
    }
  });

  it("skips the INKEEDecoder terminal when its adapter is disabled", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "inkeedecoder";
    resetConfig();
    resetClients();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = await connect();
      await call(client.client, { substance_name: "Niacinamide" });

      const hosts = fetchMock.mock.calls.map(
        ([input]) => new URL(sourceUrl(input)).hostname,
      );
      expect(hosts).not.toContain("inkeedecoder.com");
    } finally {
      delete process.env.DRUGDATA_DISABLED_SOURCES;
      resetConfig();
      resetClients();
      vi.unstubAllGlobals();
    }
  });
});
