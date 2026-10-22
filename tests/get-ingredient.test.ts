import { readFileSync } from "node:fs";
import {
  createDrugCentralClient,
  type DrugCentralClient,
  type FetchLike as DrugCentralFetch,
} from "@knorby/drugcentral-client";
import {
  CosingClient,
  type FetchLike as CosingFetch,
} from "@knorby/eu-cosing-client";
import {
  createInkeedecoderClient,
  type InkeedecoderClient,
} from "@knorby/inkeedecoder-client";
import { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import {
  OpenFdaClient,
  type FetchLike as OpenFdaFetch,
  OpenFdaNotFoundError,
} from "@knorby/openfda-client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import {
  CHARACTER_LIMIT,
  SERVER_NAME,
  SERVER_VERSION,
} from "../src/constants.js";
import { ingredientDetailNextSteps } from "../src/lib/next-steps.js";
import type { IngredientRef, NextStep } from "../src/lib/schemas.js";
import { createCosingAdapter } from "../src/sources/cosing.js";
import { createDrugCentralAdapter } from "../src/sources/drugcentral.js";
import { createInkeedecoderAdapter } from "../src/sources/inkeedecoder.js";
import { createNlmAdapter } from "../src/sources/nlm.js";
import { createOpenFdaAdapter } from "../src/sources/openfda.js";
import { createRegistry } from "../src/sources/registry.js";
import type { Registry, SourceAdapter } from "../src/sources/types.js";
import {
  prepareIngredientId,
  registerGetIngredientTool,
} from "../src/tools/get-ingredient.js";
import {
  createTestClient,
  jsonResponse,
  type TestHarness,
  textOf,
} from "./helpers.js";

/**
 * `drugdata_get_ingredient` is driven through a real MCP client. Every case
 * uses a registry built from a real adapter backed by its captured fixtures,
 * so the adapter lookup, the tool's closed output schema, the markdown
 * rendering, and the source-only error text are exercised the way a host sees
 * them.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url);
const RETRIEVED_AT = "2026-10-21T12:00:00.000Z";
const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
] as const;

function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;
}

function textFixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

/** Reads the first metadata record from a CosIng search fixture. */
function cosingMetadata(path: string): Record<string, unknown> {
  const body = fixture<{
    results: Array<{ metadata: Record<string, unknown> }>;
  }>(path);
  const metadata = body.results[0]?.metadata;
  if (metadata === undefined)
    throw new Error(`fixture ${path} has no metadata`);
  return metadata;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Builds an openFDA client whose fetch routes through `handler`. */
function openFdaClient(handler: Handler): OpenFdaClient {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new URL(String(input)), init ?? {}),
  );
  return new OpenFdaClient({
    fetch: fetchMock as unknown as OpenFdaFetch,
    timeoutMs: 5_000,
  });
}

/** Builds a CosIng client whose fetch routes through `handler`. */
function cosingClient(handler: Handler): CosingClient {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new URL(String(input)), init ?? {}),
  );
  return new CosingClient({
    fetch: fetchMock as unknown as CosingFetch,
    timeoutMs: 5_000,
  });
}

/** Builds an NLM client whose fetch routes through `handler`. */
function nlmClient(handler: (url: URL) => Response): NlmDrugsClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    handler(new URL(String(input))),
  );
  return new NlmDrugsClient({
    fetch: fetchMock as unknown as typeof fetch,
  });
}

/** Builds an INKEEDecoder client whose fetch routes through `handler`. */
function ikdClient(handler: Handler): InkeedecoderClient {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new URL(String(input)), init ?? {}),
  );
  return createInkeedecoderClient({
    fetch: fetchMock as unknown as typeof fetch,
    requestIntervalMs: 0,
    timeoutMs: 5_000,
  });
}

/** A fresh 404 response. */
function notFound(): Response {
  return jsonResponse({ detail: "not found" }, { status: 404 });
}

/** A fresh HTTP failure response. */
function failure(status: number): Response {
  return jsonResponse({ detail: "upstream failure" }, { status });
}

/** Answers every request with one fixed JSON body. */
function routeTo(body: unknown): Handler {
  return () => jsonResponse(body);
}

/** Answers every request with one fixed HTML body. */
function routeHtml(body: string): Handler {
  return () => new Response(body, { status: 200 });
}

type Route = unknown | (() => Response);

/** Builds a DrugCentral client routed by decoded pathname. */
function drugCentralClient(
  routes: Record<string, Route>,
  fallback?: (path: string) => Response,
): DrugCentralClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const route = routes[path];
    if (route === undefined) {
      if (fallback !== undefined) return fallback(path);
      throw new Error(`unexpected DrugCentral request: ${path}`);
    }
    if (typeof route === "function") return (route as () => Response)();
    if (route instanceof Response) return route;
    if (typeof route === "string") return jsonResponse(fixture(route));
    return jsonResponse(route);
  });
  return createDrugCentralClient({
    fetch: fetchMock as unknown as DrugCentralFetch,
    timeoutMs: 5_000,
  });
}

/** The five profile requests for DrugCentral struct 74. */
const ASPIRIN_PROFILE: Record<string, Route> = {
  "/structures/id/74": "drugcentral/structures-id-74.json",
  "/identifier/struct_id/74": "drugcentral/identifier-struct-74.json",
  "/synonyms/id/74": "drugcentral/synonyms-struct-74.json",
  "/struct2obprod/struct_id/74": "drugcentral/struct2obprod-struct-74.json",
  "/struct2atc/struct_id/74": "drugcentral/struct2atc-struct-74.json",
};

/** Answers any profile table for a struct id with 404. */
function emptyDrugCentralProfile(path: string): Response {
  if (
    path.startsWith("/structures/id/") ||
    path.startsWith("/identifier/struct_id/") ||
    path.startsWith("/identifier/identifier/") ||
    path.startsWith("/synonyms/id/") ||
    path.startsWith("/struct2obprod/struct_id/") ||
    path.startsWith("/struct2atc/struct_id/") ||
    path.startsWith("/omop_relationship/struct_id/") ||
    path.startsWith("/faers/struct_id/")
  ) {
    return notFound();
  }
  throw new Error(`unexpected DrugCentral request: ${path}`);
}

async function start(registry?: Registry): Promise<TestHarness> {
  return createTestClient(() => {
    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    registerGetIngredientTool(server, registry);
    return server;
  });
}

async function findTool(harness: TestHarness, name: string) {
  const { tools } = await harness.client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  return tool;
}

interface IngredientOutput {
  ingredient: IngredientRef;
  profile: Record<string, unknown>;
  regulatory?: {
    notices: Array<{ text: string; basis: string; source: string }>;
  };
  links: Array<{ label: string; url: string }>;
  nextSteps: NextStep[];
}

/** Calls the tool and returns its structured record. */
async function getIngredient(
  harness: TestHarness,
  args: Record<string, unknown>,
): Promise<IngredientOutput> {
  const result = await harness.client.callTool({
    name: "drugdata_get_ingredient",
    arguments: args,
  });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as unknown as IngredientOutput;
}

/** Calls an adapter's required ingredient lookup, failing loudly if absent. */
function ingredientLookup(
  adapter: SourceAdapter,
  id: string,
  opts: Record<string, unknown> = {},
): Promise<unknown> {
  const lookup = adapter.getIngredient;
  if (lookup === undefined) throw new Error("adapter has no ingredient lookup");
  return lookup.call(adapter, id, opts);
}

/** An adapter that only implements an ingredient lookup. */
function lookupAdapter(
  id: string,
  databases: IngredientRef["source"]["database"][],
  getIngredient: NonNullable<SourceAdapter["getIngredient"]>,
): SourceAdapter {
  return {
    id,
    databases,
    productSearchTypes: [],
    ingredientSearchTypes: [],
    productCategories: [],
    getIngredient,
  };
}

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("get_ingredient tool", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  it("advertises the briefed ingredient inputs and sources", async () => {
    harness = await start(createRegistry([], []));

    const tool = await findTool(harness, "drugdata_get_ingredient");
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tool.description).toContain("include_clinical");
    expect(tool.description).toContain("include_cosing_panel");
    expect(tool.description).toContain("no extra request");
    expect(tool.description).toContain("default false");
    expect(tool.description).not.toMatch(/client/i);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual([
      "id",
      "include_clinical",
      "include_cosing_panel",
      "response_format",
      "source",
    ]);
  });

  it("rejects an unknown source and names the valid databases", async () => {
    harness = await start(createRegistry([], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "dsld", id: "123" },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    for (const source of [
      "openfda",
      "cosing",
      "drugcentral",
      "nlm",
      "inkeedecoder",
    ]) {
      expect(text).toContain(source);
    }
  });

  it("validates each source's id shape with search-tool guidance", async () => {
    harness = await start(createRegistry([], []));

    const cases: Array<[string, string, RegExp]> = [
      ["openfda", "not a unii", /drugdata_search_ingredients/],
      ["openfda", "123", /drugdata_search_ingredients/],
      [
        "cosing",
        "https://example.com/ingredient",
        /drugdata_search_ingredients/,
      ],
      ["drugcentral", "not an identifier", /drugdata_search_ingredients/],
      ["nlm", "atorvastatin", /drugdata_search_ingredients/],
      [
        "inkeedecoder",
        "https://example.com/products/nope",
        /drugdata_search_ingredients/,
      ],
    ];

    for (const [source, id, pattern] of cases) {
      const result = await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source, id },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(pattern);
    }
  });

  it("rejects an unsupported DrugCentral crosswalk type with the supported vocabulary", async () => {
    harness = await start(createRegistry([], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "drugcentral", id: "PUBCHEM_CID:2244" },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("does not support crosswalk type");
    expect(text).toContain("PUBCHEM_CID");
    expect(text).toContain("DRUGBANK_ID");
    expect(text).toContain("identifiers.structId");
    expect(text).toContain("drugdata_search_ingredients");
    expect(text).not.toContain("failed unexpectedly");
  });

  it("prepares ids for every source, normalizing where the database is case-insensitive", () => {
    expect(prepareIngredientId("openfda", "pdc6a3c0ox")).toEqual({
      ok: true,
      id: "PDC6A3C0OX",
    });
    expect(prepareIngredientId("openfda", "56-81-5")).toEqual({
      ok: true,
      id: "56-81-5",
    });
    expect(prepareIngredientId("cosing", "0035499")).toEqual({
      ok: true,
      id: "35499",
    });
    expect(prepareIngredientId("cosing", "Niacinamide")).toEqual({
      ok: true,
      id: "Niacinamide",
    });
    expect(prepareIngredientId("drugcentral", "00074")).toEqual({
      ok: true,
      id: "74",
    });
    expect(prepareIngredientId("drugcentral", "r16co5y76e")).toEqual({
      ok: true,
      id: "R16CO5Y76E",
    });
    expect(prepareIngredientId("drugcentral", "50-78-2")).toEqual({
      ok: true,
      id: "50-78-2",
    });
    expect(prepareIngredientId("drugcentral", "DRUGBANK_ID:DB00945")).toEqual({
      ok: true,
      id: "DRUGBANK_ID:DB00945",
    });
    expect(
      prepareIngredientId("drugcentral", "PUBCHEM_CID:2244"),
    ).toMatchObject({ ok: false });
    expect(prepareIngredientId("nlm", "0083367")).toEqual({
      ok: true,
      id: "83367",
    });
    expect(prepareIngredientId("inkeedecoder", "niacinamide")).toEqual({
      ok: true,
      id: "niacinamide",
    });
    expect(prepareIngredientId("cosing", "")).toMatchObject({ ok: false });
    expect(prepareIngredientId("cosing", "0")).toMatchObject({ ok: false });
    expect(prepareIngredientId("nlm", "0")).toMatchObject({ ok: false });
    expect(prepareIngredientId("drugcentral", "0")).toMatchObject({
      ok: false,
    });
  });

  it("caps follow-up steps at three and skips the database that answered", () => {
    const steps = ingredientDetailNextSteps({
      name: "Rich ingredient",
      inciName: "RICH INGREDIENT",
      identifiers: {
        unii: "ABCDEFGHIJ",
        rxcui: ["123"],
        structId: 74,
        cas: ["50-78-2"],
        slug: "rich-ingredient",
      },
      source: {
        database: "openFDA",
        id: "ABCDEFGHIJ",
        url: "https://example.test/openFDA/ABCDEFGHIJ",
        retrievedAt: RETRIEVED_AT,
      },
    });

    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.tool)).toEqual([
      "drugdata_resolve_identifiers",
      "drugdata_resolve_identifiers",
      "drugdata_get_ingredient",
    ]);
    expect(steps[2]?.input).toEqual({ source: "drugcentral", id: "74" });
  });

  it("rejects an over-long CosIng name before any request", () => {
    const prepared = prepareIngredientId("cosing", "x".repeat(201));
    expect(prepared).toMatchObject({ ok: false });
  });

  it("reports a configuration error instead of throwing", async () => {
    vi.stubEnv("DRUGDATA_TIMEOUT_MS", "not-a-number");
    harness = await start();

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "openfda", id: "PDC6A3C0OX" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("DRUGDATA_TIMEOUT_MS");
  });

  it("returns the actionable routing error when the named database cannot answer ingredient lookups", async () => {
    const adapter: SourceAdapter = {
      id: "openfda",
      databases: ["openFDA"],
      productSearchTypes: [],
      ingredientSearchTypes: [],
      productCategories: [],
    };
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "openfda", id: "PDC6A3C0OX" },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("does not provide ingredient lookups");
    expect(text).toMatch(/Available sources|No registered source/i);
  });

  it("scrubs client-library names from an adapter failure", async () => {
    const adapter = lookupAdapter("openfda", ["openFDA"], async () => {
      throw new Error("@knorby/openfda-client failed unexpectedly");
    });
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: {
        source: "openfda",
        id: "PDC6A3C0OX",
        response_format: "json",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/@knorby|client/i);
  });

  it("returns a JSON profile with the same bounded structured value", async () => {
    const adapter = lookupAdapter("cosing", ["CosIng"], async () => ({
      ingredient: {
        name: "Niacinamide",
        identifiers: { cas: ["98-92-0"] },
        source: {
          database: "CosIng",
          id: "35499",
          url: "https://ec.europa.eu/growth/tools-databases/cosing/details/35499",
          retrievedAt: RETRIEVED_AT,
        },
      },
      profile: { functions: ["SMOOTHING"], status: "Active" },
    }));
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "cosing", id: "35499", response_format: "json" },
    });
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    const parsed = JSON.parse(text) as IngredientOutput;
    expect(parsed).toEqual(result.structuredContent);
    expect(parsed.profile.functions).toEqual(["SMOOTHING"]);
    expect(
      parsed.nextSteps.some(
        (step) => step.tool === "drugdata_resolve_identifiers",
      ),
    ).toBe(true);
  });
});

describe("get_ingredient — DrugCentral", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  it("returns the structure profile with the identifier crosswalk and ATC codes", async () => {
    const adapter = createDrugCentralAdapter(
      drugCentralClient(ASPIRIN_PROFILE),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "74",
    });

    expect(output.ingredient.name).toBe("acetylsalicylic acid");
    expect(output.ingredient.identifiers).toMatchObject({
      structId: 74,
      unii: "R16CO5Y76E",
      rxcui: ["1191"],
      inchiKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
      cid: [348],
    });
    expect(output.ingredient.identifiers.cas).toContain("50-78-2");
    expect(output.profile.identifiers).toContainEqual({
      type: "DRUGBANK_ID",
      value: "DB00945",
    });
    expect(output.profile.identifiers).toContainEqual({
      type: "PUBCHEM_CID",
      value: "2244",
    });
    expect(output.profile.atc).toContain("A01AD05");
    expect(output.profile.atc).toContain("N02BA01");
    expect(output.profile.inchiKey).toBe("BSYNRYMUTXBXSQ-UHFFFAOYSA-N");
    expect(output.profile.clinical).toBeUndefined();
    expect(output.regulatory).toBeUndefined();

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "drugcentral", id: "74" },
      }),
    );
    expect(text).toContain("Identifier crosswalk");
    expect(text).toContain("ATC codes");
    expect(text).not.toContain("FAERS signals");
  });

  it("omits clinical sections unless include_clinical is set", async () => {
    const adapter = createDrugCentralAdapter(
      drugCentralClient(ASPIRIN_PROFILE),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "74",
      include_clinical: false,
    });

    expect(output.profile.clinical).toBeUndefined();
  });

  it("adds indications, off-label uses, contraindications, and FAERS counts when asked", async () => {
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        ...ASPIRIN_PROFILE,
        "/omop_relationship/struct_id/74":
          "drugcentral/omop-relationships-combined.json",
        "/faers/struct_id/74": "drugcentral/faers-struct-74.json",
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "74",
      include_clinical: true,
    });
    const clinical = output.profile.clinical as {
      indications: Array<{ name: string; relationship: string }>;
      offLabelUses: Array<{ name: string; relationship: string }>;
      contraindications: Array<{ name: string; relationship: string }>;
      faers: Array<Record<string, unknown>>;
      truncated: boolean;
    };

    expect(clinical.indications.length).toBeGreaterThan(0);
    expect(clinical.offLabelUses).toHaveLength(1);
    expect(clinical.contraindications.length).toBeGreaterThan(0);
    expect(clinical.faers).toHaveLength(3);
    expect(clinical.faers[0]).toMatchObject({
      population: "all",
      term: "Abdominal discomfort",
      llr: 954.055,
      llrThreshold: 10.068,
      drugAe: 3467,
      drugNoAe: 1588930,
      noDrugAe: 641246,
      noDrugNoAe: 150907258,
    });
    expect(clinical.truncated).toBe(false);

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: {
          source: "drugcentral",
          id: "74",
          include_clinical: true,
        },
      }),
    );
    expect(text).toContain("Indications (source assertions)");
    expect(text).toContain("Off-label uses (source assertions)");
    expect(text).toContain("Contraindications (source assertions)");
    expect(text).toContain("FAERS signals");
    expect(text).toContain("not incidence rates");
  });

  it("caps clinical lists and says they were truncated", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      relationship_name: "indication",
      id: index,
      concept_name: `Condition ${index}`,
      snomed_full_name: `Condition ${index}`,
      snomed_conceptid: index,
      struct_id: 74,
      concept_id: index,
      umls_cui: `C${index}`,
      cui_semantic_type: "T047",
    }));
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        ...ASPIRIN_PROFILE,
        "/omop_relationship/struct_id/74": many,
        "/faers/struct_id/74": [],
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "74",
      include_clinical: true,
    });
    const clinical = output.profile.clinical as {
      indications: unknown[];
      faers: unknown[];
      truncated: boolean;
    };

    expect(clinical.indications).toHaveLength(50);
    expect(clinical.faers).toEqual([]);
    expect(clinical.truncated).toBe(true);
    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: {
          source: "drugcentral",
          id: "74",
          include_clinical: true,
        },
      }),
    );
    expect(text).toContain("No signal rows were returned");
    expect(text).toContain("Clinical lists were capped");
  });

  it("resolves UNII, CAS, and prefixed crosswalk identifiers to one structure", async () => {
    const routes = {
      ...ASPIRIN_PROFILE,
      "/identifier/identifier/R16CO5Y76E":
        "drugcentral/identifier-unii-aspirin.json",
      "/identifier/identifier/132-49-0":
        "drugcentral/identifier-struct-74.json",
      "/identifier/identifier/DB00945": "drugcentral/identifier-struct-74.json",
    };
    const adapter = createDrugCentralAdapter(drugCentralClient(routes));
    harness = await start(createRegistry([adapter], []));

    for (const id of ["R16CO5Y76E", "132-49-0", "DRUGBANK_ID:DB00945"]) {
      const output = await getIngredient(harness, {
        source: "drugcentral",
        id,
      });
      expect(output.ingredient.source.id).toBe("74");
      expect(output.ingredient.identifiers.structId).toBe(74);
    }
  });

  it("refuses ambiguous identifier matches and names the structure-id alternative", async () => {
    const ambiguous = [
      {
        identifier: "R16CO5Y76E",
        id: 1,
        id_type: "UNII",
        struct_id: 74,
        parent_match: null,
      },
      {
        identifier: "R16CO5Y76E",
        id: 2,
        id_type: "UNII",
        struct_id: 75,
        parent_match: null,
      },
    ];
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        "/identifier/identifier/R16CO5Y76E": ambiguous,
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "drugcentral", id: "R16CO5Y76E" },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("74, 75");
    expect(text).toContain("identifiers.structId");
  });

  it("returns 404-style errors for a missing structure and a missing identifier", async () => {
    const adapter = createDrugCentralAdapter(
      drugCentralClient({}, emptyDrugCentralProfile),
    );
    harness = await start(createRegistry([adapter], []));

    for (const id of ["999", "R16CO5Y76E"]) {
      const result = await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "drugcentral", id },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not found|no structure/i);
    }
  });

  it("rewords DrugCentral failures without naming a client library", async () => {
    const adapter = createDrugCentralAdapter(
      drugCentralClient({}, () => failure(500)),
    );
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "drugcentral", id: "74" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 500|temporarily unavailable/i);
  });

  it("uses the preferred synonym and omits absent structure fields", async () => {
    const structure = {
      id: 75,
      name: null,
      cas_reg_no: null,
      status: null,
      cd_id: null,
      cd_formula: null,
      cd_molweight: null,
      smiles: null,
      inchi: null,
      inchikey: null,
    };
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        "/structures/id/75": [structure],
        "/identifier/struct_id/75": [],
        "/synonyms/id/75": [
          { id: 75, name: "Preferred Name", preferred_name: 1 },
        ],
        "/struct2obprod/struct_id/75": [],
        "/struct2atc/struct_id/75": [],
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "75",
    });

    expect(output.ingredient.name).toBe("Preferred Name");
    expect(output.ingredient.summary).toBeUndefined();
    expect(output.profile).toMatchObject({
      structId: 75,
      identifiers: [],
      atc: [],
      synonyms: ["Preferred Name"],
    });
    expect(output.profile).not.toHaveProperty("inchiKey");
    expect(output.profile).not.toHaveProperty("cas");
  });

  it("falls back to the structure id when no name exists", async () => {
    const structure = {
      id: 76,
      name: null,
      cas_reg_no: null,
      status: null,
      cd_id: null,
      cd_formula: null,
      cd_molweight: null,
      smiles: null,
      inchi: null,
      inchikey: null,
    };
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        "/structures/id/76": [structure],
        "/identifier/struct_id/76": [],
        "/synonyms/id/76": [],
        "/struct2obprod/struct_id/76": [],
        "/struct2atc/struct_id/76": [],
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "76",
    });

    expect(output.ingredient.name).toBe("76");
  });

  it("deduplicates the crosswalk and drops blank identifier rows", async () => {
    const rows = [
      {
        id: 1,
        id_type: "UNII",
        identifier: "R16CO5Y76E",
        struct_id: 74,
        parent_match: null,
      },
      {
        id: 2,
        id_type: "UNII",
        identifier: "R16CO5Y76E",
        struct_id: 74,
        parent_match: null,
      },
      {
        id: 5,
        id_type: "UNII",
        identifier: "KLMNOPQRST",
        struct_id: 74,
        parent_match: true,
      },
      { id: 3, id_type: "", identifier: "BLANK-TYPE", struct_id: 74 },
      { id: 4, id_type: "BLANK-VALUE", identifier: "", struct_id: 74 },
    ];
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        ...ASPIRIN_PROFILE,
        "/identifier/struct_id/74": rows,
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "74",
    });

    expect(output.profile.identifiers).toEqual([
      { type: "UNII", value: "R16CO5Y76E" },
      { type: "UNII", value: "KLMNOPQRST" },
    ]);
    expect(output.ingredient.identifiers.unii).toBe("R16CO5Y76E");
  });

  it("uses a parent UNII when it is the only crosswalk row", async () => {
    const structure = {
      id: 77,
      name: "Parent-linked structure",
      cas_reg_no: null,
      status: null,
      cd_id: null,
      cd_formula: null,
      cd_molweight: null,
      smiles: null,
      inchi: null,
      inchikey: null,
    };
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        "/structures/id/77": [structure],
        "/identifier/struct_id/77": [
          {
            id: 1,
            id_type: "UNII",
            identifier: "KLMNOPQRST",
            struct_id: 77,
            parent_match: 123,
          },
        ],
        "/synonyms/id/77": [],
        "/struct2obprod/struct_id/77": [],
        "/struct2atc/struct_id/77": [],
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "77",
    });

    expect(output.ingredient.identifiers.unii).toBe("KLMNOPQRST");
  });

  it("maps condition and FAERS rows with absent optional fields", async () => {
    const omop = [
      {
        relationship_name: "indication",
        id: 1,
        concept_id: 10,
        concept_name: null,
        snomed_full_name: "Fallback condition",
        snomed_conceptid: null,
        umls_cui: null,
        struct_id: 74,
      },
      {
        relationship_name: "indication",
        id: 2,
        concept_id: 11,
        concept_name: null,
        snomed_full_name: null,
        snomed_conceptid: null,
        umls_cui: null,
        struct_id: 74,
      },
    ];
    const faers = [
      {
        population: "all",
        id: 1,
        struct_id: 74,
        meddra_code: null,
        meddra_name: null,
        level: "PT",
        llr: null,
        llr_threshold: null,
        drug_ae: null,
        drug_no_ae: null,
        no_drug_ae: null,
        no_drug_no_ae: null,
      },
      {
        population: "all",
        id: 2,
        struct_id: 74,
        meddra_code: 123,
        meddra_name: null,
        level: "PT",
        llr: 1,
        llr_threshold: 2,
        drug_ae: 3,
        drug_no_ae: 4,
        no_drug_ae: 5,
        no_drug_no_ae: 6,
      },
    ];
    const adapter = createDrugCentralAdapter(
      drugCentralClient({
        ...ASPIRIN_PROFILE,
        "/omop_relationship/struct_id/74": omop,
        "/faers/struct_id/74": faers,
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "drugcentral",
      id: "74",
      include_clinical: true,
    });
    const clinical = output.profile.clinical as {
      indications: Array<{ name: string; snomedFullName?: string }>;
      faers: Array<{ term: string; llr?: number; drugAe?: number }>;
    };

    expect(clinical.indications.map((row) => row.name)).toEqual([
      "Fallback condition",
      "11",
    ]);
    expect(clinical.indications[0]?.snomedFullName).toBe("Fallback condition");
    expect(clinical.faers[0]).toMatchObject({ term: "unnamed MedDRA term" });
    expect(clinical.faers[0]).not.toHaveProperty("llr");
    expect(clinical.faers[1]).toMatchObject({
      term: "MedDRA 123",
      llr: 1,
      drugAe: 3,
    });
  });

  it("guards direct adapter calls against an unusable id", async () => {
    const adapter = createDrugCentralAdapter(
      drugCentralClient(ASPIRIN_PROFILE),
    );

    await expect(ingredientLookup(adapter, "")).rejects.toThrow(
      /Expected a DrugCentral structure id or identifier/,
    );
    await expect(ingredientLookup(adapter, "0")).rejects.toThrow(
      /Expected a positive DrugCentral structure id/,
    );
    await expect(ingredientLookup(adapter, "PUBCHEM_CID:2244")).rejects.toThrow(
      /does not support crosswalk type/,
    );
  });
});

describe("get_ingredient — CosIng", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  it("returns the inventory record and functions by substance id", async () => {
    const adapter = createCosingAdapter(
      cosingClient(routeTo(fixture("cosing/ingredient-inci-niacinamide.json"))),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "cosing",
      id: "35499",
    });

    expect(output.ingredient.name).toBe("NIACINAMIDE");
    expect(output.ingredient.inciName).toBe("NIACINAMIDE");
    expect(output.ingredient.identifiers).toEqual({
      cas: ["98-92-0"],
      ec: ["202-713-4"],
    });
    expect(output.profile.functions).toEqual(["SMOOTHING"]);
    expect(output.profile.status).toBe("Active");
    expect(output.regulatory).toBeUndefined();

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "cosing", id: "35499" },
      }),
    );
    expect(text).toContain("CosIng inventory");
    expect(text).toContain("Functions: SMOOTHING");
  });

  it("finds a record by exact INCI name and labels restriction text verbatim with its annex basis", async () => {
    const metadata = structuredClone(
      cosingMetadata("cosing/ingredient-inci-salicylic-acid.json"),
    );
    metadata.annexNo = ["III", "V"];
    const adapter = createCosingAdapter(
      cosingClient(routeTo({ results: [{ metadata }] })),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "cosing",
      id: "SALICYLIC ACID",
    });

    expect(output.ingredient.name).toBe("SALICYLIC ACID");
    expect(output.regulatory?.notices).toEqual([
      {
        text: "III/98\r\nV/3",
        basis: "annex III, V",
        source: "CosIng",
      },
      {
        text: "OPINION ON salicylic acid (CAS 69-72-7) Submission I",
        basis: "SCCS opinion (verbatim)",
        source: "CosIng",
      },
    ]);
    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "cosing", id: "SALICYLIC ACID" },
      }),
    );
    expect(text).toContain("Regulatory notices (verbatim)");
    expect(text).toContain("basis: annex III, V");
  });

  it("falls back from an exact INCI miss to an exact glossary-name hit", async () => {
    let calls = 0;
    const adapter = createCosingAdapter(
      cosingClient(() => {
        calls += 1;
        return calls === 1
          ? jsonResponse(fixture("cosing/ingredient-zero.json"))
          : jsonResponse(fixture("cosing/ingredient-inci-niacinamide.json"));
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "cosing",
      id: "niacinamide",
    });

    expect(output.ingredient.source.id).toBe("35499");
    expect(calls).toBe(2);
  });

  it("uses a generic restriction basis when CosIng assigns no annex", async () => {
    const adapter = createCosingAdapter(
      cosingClient(
        routeTo(fixture("cosing/ingredient-inci-salicylic-acid.json")),
      ),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "cosing",
      id: "SALICYLIC ACID",
    });

    expect(output.regulatory?.notices[0]).toMatchObject({
      basis: "CosIng restriction",
    });
  });

  it("returns a 404-style error for an unknown record and for a record with no substance id", async () => {
    const empty = createCosingAdapter(
      cosingClient(routeTo(fixture("cosing/ingredient-zero.json"))),
    );
    harness = await start(createRegistry([empty], []));
    let result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "cosing", id: "999999" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found|no inventory record/i);

    await harness.close();
    const metadata = structuredClone(
      cosingMetadata("cosing/ingredient-inci-niacinamide.json"),
    );
    delete metadata.substanceId;
    const withoutId = createCosingAdapter(
      cosingClient(routeTo({ results: [{ metadata }] })),
    );
    harness = await start(createRegistry([withoutId], []));
    result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "cosing", id: "35499" },
    });
    expect(result.isError).toBe(true);
  });

  it("maps optional metadata fields and skips blank regulatory text", async () => {
    const metadata = structuredClone(
      cosingMetadata("cosing/ingredient-inci-niacinamide.json"),
    );
    metadata.inciUsaName = ["US NIACINAMIDE"];
    metadata.chemicalDescription = ["A description."];
    metadata.otherRestrictions = ["", "Other restriction"];
    metadata.sccsOpinion = ["", "SCCS opinion"];
    metadata.note = ["", "A note"];
    metadata.annexNo = ["III"];
    const adapter = createCosingAdapter(
      cosingClient(routeTo({ results: [{ metadata }] })),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "cosing",
      id: "35499",
    });

    expect(output.profile.inciUsaName).toBe("US NIACINAMIDE");
    expect(output.profile.chemicalDescription).toBe("A description.");
    expect(output.profile.notes).toEqual(["A note"]);
    expect(output.regulatory?.notices).toEqual([
      {
        text: "Other restriction",
        basis: "other restriction (verbatim)",
        source: "CosIng",
      },
      {
        text: "SCCS opinion",
        basis: "SCCS opinion (verbatim)",
        source: "CosIng",
      },
    ]);
  });

  it("maps a minimal metadata record without inventing optional fields", async () => {
    const metadata = {
      substanceId: ["999"],
      cosmeticRestriction: ["   "],
    };
    const adapter = createCosingAdapter(
      cosingClient(routeTo({ results: [{ metadata }] })),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "cosing",
      id: "999",
    });

    expect(output.ingredient.name).toBe("999");
    expect(output.profile).toEqual({
      functions: [],
      annexNumbers: [],
      identifiedIngredientIds: [],
      otherRestrictions: [],
      sccsOpinions: [],
      sccsOpinionUrls: [],
      relatedRegulations: [],
      otherRegulations: [],
      notes: [],
    });
    expect(output.ingredient.summary).toBeUndefined();
    expect(output.regulatory).toBeUndefined();
  });

  it("returns a 404-style error for an unknown text name", async () => {
    const adapter = createCosingAdapter(
      cosingClient(routeTo(fixture("cosing/ingredient-zero.json"))),
    );
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "cosing", id: "UNKNOWN INGREDIENT" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found|no inventory record/i);
  });

  it("rewords CosIng failures without naming a client library", async () => {
    const adapter = createCosingAdapter(cosingClient(() => failure(500)));
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "cosing", id: "35499" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/@knorby|client/i);
    expect(textOf(result)).toMatch(/HTTP 500|temporarily unavailable/i);
  });
});

describe("get_ingredient — openFDA", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  it("returns names, codes, and relationships for a UNII", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(routeTo(fixture("openfda/substance-unii-glycerin.json"))),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "openfda",
      id: "PDC6A3C0OX",
    });

    expect(output.ingredient.name).toBe("Glycerin");
    expect(output.ingredient.identifiers.unii).toBe("PDC6A3C0OX");
    expect(output.ingredient.identifiers.cas).toContain("56-81-5");
    expect((output.profile.names as unknown[]).length).toBeGreaterThan(5);
    expect((output.profile.codes as unknown[]).length).toBeGreaterThan(5);
    expect((output.profile.relationships as unknown[]).length).toBeGreaterThan(
      1,
    );
    expect(output.profile.substanceClass).toBe("chemical");

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "openfda", id: "PDC6A3C0OX" },
      }),
    );
    expect(text).toContain("Names");
    expect(text).toContain("Codes");
    expect(text).toContain("Relationships");
  });

  it("looks a substance up by dashed CAS number", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(fixture("openfda/substance-cas-glycerin.json")),
    );
    const adapter = createOpenFdaAdapter(
      new OpenFdaClient({
        fetch: fetchMock as unknown as OpenFdaFetch,
        timeoutMs: 5_000,
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "openfda",
      id: "56-81-5",
    });

    expect(output.ingredient.identifiers.unii).toBe("PDC6A3C0OX");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const search = decodeURIComponent(url.search);
    expect(search).toContain("codes.code_system:CAS");
    expect(search).toContain("56");
  });

  it("omits empty profile sections and falls back to the UNII as the name", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(
        routeTo({
          results: [
            {
              unii: "ABCDEFGHIJ",
              names: [{}],
              codes: [{}],
              relationships: [{}, { type: "ACTIVE MOIETY" }],
            },
          ],
        }),
      ),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "openfda",
      id: "ABCDEFGHIJ",
    });

    expect(output.ingredient.name).toBe("ABCDEFGHIJ");
    expect(output.profile.names).toBeUndefined();
    expect(output.profile.codes).toBeUndefined();
    expect(output.profile.relationships).toEqual([{ type: "ACTIVE MOIETY" }]);
    expect(output.ingredient.summary).toBeUndefined();
  });

  it("maps a substance with no optional profile collections", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(routeTo({ results: [{ unii: "ABCDEFGHIJ" }] })),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "openfda",
      id: "ABCDEFGHIJ",
    });

    expect(output.profile).toEqual({});
    expect(output.ingredient.summary).toBeUndefined();
  });

  it("maps partial code and relationship rows without inventing values", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(
        routeTo({
          results: [
            {
              unii: "ABCDEFGHIJ",
              names: [
                {
                  name: "Preferred",
                  preferred: true,
                  display_name: true,
                  name_orgs: [{ name_org: "USP" }],
                },
                { name: "No flags", name_orgs: [] },
              ],
              codes: [
                { code: "ONLY-CODE" },
                { code_system: "ONLY-SYSTEM" },
                { code: "VALID", code_system: "TEST" },
              ],
              relationships: [{ related_substance: { name: "Related" } }],
            },
          ],
        }),
      ),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "openfda",
      id: "ABCDEFGHIJ",
    });

    expect(output.profile.names).toEqual([
      {
        name: "Preferred",
        preferred: true,
        displayName: true,
        organizations: ["USP"],
      },
      { name: "No flags", organizations: [] },
    ]);
    expect(output.profile.codes).toEqual([{ code: "VALID", system: "TEST" }]);
    expect(output.profile.relationships).toEqual([{ relatedName: "Related" }]);
  });

  it("handles an explicit not-found error and an empty result set", async () => {
    const throwing = createOpenFdaAdapter({
      other: {
        substance: {
          search: async () => {
            throw new OpenFdaNotFoundError(
              "https://api.fda.gov/other/substance",
            );
          },
        },
      },
    } as unknown as OpenFdaClient);
    await expect(ingredientLookup(throwing, "ABCDEFGHIJ")).rejects.toThrow(
      /no substance record/,
    );

    const empty = createOpenFdaAdapter(openFdaClient(routeTo({ results: [] })));
    await expect(ingredientLookup(empty, "ABCDEFGHIJ")).rejects.toThrow(
      /no substance record/,
    );
  });

  it("returns 404-style errors for a missing substance and a record without a UNII", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) => {
        if (url.pathname === "/other/substance.json") {
          return jsonResponse({ results: [{ names: [{ name: "No UNII" }] }] });
        }
        return notFound();
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "openfda", id: "PDC6A3C0OX" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found|no substance record/i);
  });

  it("turns an upstream 404 into a not-found result", async () => {
    const adapter = createOpenFdaAdapter(openFdaClient(() => notFound()));
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "openfda", id: "PDC6A3C0OX" },
    });

    expect(result.isError).toBe(true);
  });

  it("rewords openFDA failures and guards direct adapter ids", async () => {
    const adapter = createOpenFdaAdapter(openFdaClient(() => failure(500)));
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "openfda", id: "PDC6A3C0OX" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 500|temporarily unavailable/i);

    await expect(ingredientLookup(adapter, "not-a-unii")).rejects.toThrow(
      /Expected a UNII or a dashed CAS number/,
    );
  });
});

describe("get_ingredient — RxNorm", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  function routedNlm(
    overrides: Record<string, unknown | (() => Response)> = {},
  ): NlmDrugsClient {
    return nlmClient((url) => {
      const route = overrides[url.pathname];
      if (route !== undefined) {
        if (typeof route === "function") return (route as () => Response)();
        return jsonResponse(route);
      }
      if (url.pathname === "/REST/rxcui/83367/properties.json") {
        return jsonResponse(fixture("nlm/rxnorm-concept-83367.json"));
      }
      if (url.pathname === "/REST/RxTerms/rxcui/83367/allinfo.json") {
        return jsonResponse(fixture("nlm/rxterms-allinfo-83367.json"));
      }
      if (url.pathname === "/REST/rxcui/83367/ndcs.json") {
        return jsonResponse(fixture("nlm/rxnorm-ndcs-617314.json"));
      }
      return notFound();
    });
  }

  it("returns the concept, RxTerms presentation, and NDC crosswalk", async () => {
    const adapter = createNlmAdapter(routedNlm());
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "nlm",
      id: "83367",
    });

    expect(output.ingredient.name).toBe("atorvastatin");
    expect(output.ingredient.identifiers.rxcui).toEqual(["83367"]);
    expect(output.ingredient.source.database).toBe("RxNorm");
    expect(output.profile).toMatchObject({
      rxcui: "83367",
      tty: "IN",
      rxTerm: {
        displayName: "atorvastatin",
        fullName: "atorvastatin",
        brandName: "Lipitor",
        strength: "10 MG",
        route: "Oral",
      },
    });
    expect((output.profile.ndcs as string[]).length).toBeGreaterThan(0);
    expect(output.nextSteps[0]).toMatchObject({
      tool: "drugdata_resolve_identifiers",
      input: { rxcui: "83367" },
    });

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "nlm", id: "83367" },
      }),
    );
    expect(text).toContain("RxNorm concept");
    expect(text).toContain("NDC crosswalk");
  });

  it("maps partial RxTerms, a synonym, and an empty NDC list", async () => {
    const adapter = createNlmAdapter(
      routedNlm({
        "/REST/rxcui/83367/properties.json": {
          properties: {
            rxcui: "83367",
            name: "atorvastatin",
            tty: "IN",
            synonym: "Atorvastatin calcium",
          },
        },
        "/REST/RxTerms/rxcui/83367/allinfo.json": {
          rxtermsProperties: { rxcui: "83367", displayName: "Only display" },
        },
        "/REST/rxcui/83367/ndcs.json": { ndcGroup: {} },
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "nlm",
      id: "83367",
    });

    expect(output.profile.rxTerm).toEqual({ displayName: "Only display" });
    expect(output.profile.synonym).toBe("Atorvastatin calcium");
    expect(output.profile.ndcs).toEqual([]);
  });

  it("returns a 404-style error when the concept has no rxcui", async () => {
    const adapter = createNlmAdapter(
      routedNlm({
        "/REST/rxcui/83367/properties.json": {
          properties: { rxcui: "", name: "Nameless", tty: "IN" },
        },
        "/REST/RxTerms/rxcui/83367/allinfo.json": {},
        "/REST/rxcui/83367/ndcs.json": { ndcGroup: {} },
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "nlm", id: "83367" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found|no concept/i);
  });

  it("tolerates an absent RxTerms record", async () => {
    const adapter = createNlmAdapter(
      routedNlm({ "/REST/RxTerms/rxcui/83367/allinfo.json": {} }),
    );
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "nlm",
      id: "83367",
    });

    expect(output.profile.rxTerm).toBeUndefined();
  });

  it("returns a 404-style error for a missing concept", async () => {
    const adapter = createNlmAdapter(
      nlmClient((url) => {
        if (url.pathname === "/REST/rxcui/83367/properties.json") {
          return jsonResponse({});
        }
        if (url.pathname === "/REST/RxTerms/rxcui/83367/allinfo.json") {
          return jsonResponse({});
        }
        if (url.pathname === "/REST/rxcui/83367/ndcs.json") {
          return jsonResponse({ ndcGroup: {} });
        }
        return notFound();
      }),
    );
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "nlm", id: "83367" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found|no concept/i);
  });

  it("rewords RxNorm failures and guards direct adapter ids", async () => {
    const adapter = createNlmAdapter(nlmClient(() => failure(500)));
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "nlm", id: "83367" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 500|temporarily unavailable/i);

    await expect(ingredientLookup(adapter, "atorvastatin")).rejects.toThrow(
      /Expected an RxNorm rxcui/,
    );
  });
});

describe("get_ingredient — INKEEDecoder", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  const PAGE = textFixture("inkeedecoder/ingredient-niacinamide.html");

  it("returns the page profile without the CosIng panel by default", async () => {
    const adapter = createInkeedecoderAdapter(ikdClient(routeHtml(PAGE)));
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "inkeedecoder",
      id: "niacinamide",
    });

    expect(output.ingredient.name).toBe("Niacinamide");
    expect(output.ingredient.identifiers).toEqual({ slug: "niacinamide" });
    expect(output.profile.functions).toEqual([
      "cell-communicating ingredient",
      "skin brightening",
      "anti-acne",
      "moisturizer/humectant",
    ]);
    expect(output.profile.cosingFunctions).toBeUndefined();
    expect(output.profile.iupacName).toBeUndefined();
    expect(output.nextSteps).toEqual([
      {
        tool: "drugdata_search_ingredients",
        input: { type: "inci", query: "Niacinamide" },
        why: expect.stringContaining("compare other cosmetic records"),
      },
    ]);

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "inkeedecoder", id: "niacinamide" },
      }),
    );
    expect(text).toContain("Page profile");
    expect(text).not.toContain("IUPAC name");
  });

  it("adds the CosIng CAS, EC, and IUPAC panel when asked", async () => {
    const adapter = createInkeedecoderAdapter(ikdClient(routeHtml(PAGE)));
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "inkeedecoder",
      id: "niacinamide",
      include_cosing_panel: true,
    });

    expect(output.ingredient.identifiers).toEqual({
      slug: "niacinamide",
      cas: ["98-92-0"],
      ec: ["202-713-4"],
    });
    expect(output.profile.cosingFunctions).toBe("smoothing");
    expect(output.profile.iupacName).toBe("3-Pyridinecarboxamide");
    expect((output.profile.proof as string[]).length).toBeGreaterThan(0);
    expect(output.profile.details).toContain("Niacinamide");

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: {
          source: "inkeedecoder",
          id: "niacinamide",
          include_cosing_panel: true,
        },
      }),
    );
    expect(text).toContain("IUPAC name");
    expect(text).toContain("Page write-up (verbatim)");
  });

  it("returns a 404-style error when the page is missing", async () => {
    const adapter = createInkeedecoderAdapter(
      ikdClient(() => new Response(null, { status: 404 })),
    );
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "inkeedecoder", id: "missing" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/404|no record/i);
  });
});

describe("get_ingredient — profile rendering", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  /** A complete fake record for one database. */
  function record(
    database: IngredientRef["source"]["database"],
    profile: Record<string, unknown>,
    overrides: Partial<IngredientRef> = {},
  ) {
    return {
      ingredient: {
        name: `${database} ingredient`,
        identifiers: {},
        source: {
          database,
          id: "1",
          url: `https://example.test/${database}/1`,
          retrievedAt: RETRIEVED_AT,
        },
        ...overrides,
      },
      profile,
    };
  }

  it("renders an empty profile for every database without inventing sections", async () => {
    const cases: Array<
      [
        string,
        IngredientRef["source"]["database"],
        IngredientRef["source"]["database"],
        string,
      ]
    > = [
      ["openfda", "openFDA", "openFDA", "ABCDEFGHIJ"],
      ["cosing", "CosIng", "CosIng", "1"],
      ["drugcentral", "DrugCentral", "DrugCentral", "1"],
      ["nlm", "RxNorm", "RxNorm", "1"],
      ["inkeedecoder", "INKEEDecoder", "INKEEDecoder", "ingredient"],
      ["openfda", "openFDA", "DailyMed", "ABCDEFGHIJ"],
    ];

    for (const [source, routeDatabase, keptDatabase, id] of cases) {
      const adapter = lookupAdapter(source, [routeDatabase], async () =>
        record(keptDatabase, {}),
      );
      harness = await start(createRegistry([adapter], []));
      const output = await getIngredient(harness, { source, id });
      expect(output.ingredient.source.database).toBe(keptDatabase);
      expect(output.nextSteps).toEqual([]);
      expect(output.links).toHaveLength(1);
      await harness.close();
      harness = undefined;
    }
  });

  it("renders every optional openFDA profile field", async () => {
    const adapter = lookupAdapter("openfda", ["openFDA"], async () => ({
      ingredient: {
        name: "Substance",
        inciName: "SUBSTANCE",
        identifiers: { unii: "ABCDEFGHIJ", structId: 74, slug: "substance" },
        source: {
          database: "openFDA",
          id: "ABCDEFGHIJ",
          url: "https://drugcentral.org/drugcard/74",
          retrievedAt: RETRIEVED_AT,
        },
        summary: "Substance class: chemical",
      },
      profile: {
        substanceClass: "chemical",
        definitionLevel: "COMPLETE",
        definitionType: "PRIMARY",
        names: [
          {
            name: "Substance",
            type: "sys",
            preferred: true,
            displayName: true,
            organizations: ["USP"],
          },
          { name: "No optional name fields", organizations: [] },
        ],
        codes: [
          { code: "CODE", system: "TEST", type: "PRIMARY" },
          { code: "NO-TYPE", system: "TEST" },
        ],
        relationships: [
          {
            type: "SALT",
            qualification: "ACTIVE",
            relatedName: "Related",
            relatedUnii: "KLMNOPQRST",
            relatedSubstanceClass: "reference",
          },
          { relatedName: "No type" },
          {},
        ],
      },
    }));
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "openfda",
      id: "ABCDEFGHIJ",
    });
    expect(output.links.map((link) => link.url)).toContain(
      "https://drugcentral.org/drugcard/74",
    );
    expect(output.links.map((link) => link.url)).toContain(
      "https://inkeedecoder.com/ingredients/substance",
    );
    expect(output.links).toHaveLength(2);

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "openfda", id: "ABCDEFGHIJ" },
      }),
    );
    expect(text).toContain("preferred");
    expect(text).toContain("display name");
    expect(text).toContain("organizations: USP");
    expect(text).toContain("Relationships");
  });

  it("renders every optional CosIng profile field and verbatim notes", async () => {
    const adapter = lookupAdapter("cosing", ["CosIng"], async () => ({
      ingredient: {
        name: "Ingredient",
        identifiers: { cas: ["98-92-0"] },
        source: {
          database: "CosIng",
          id: "35499",
          url: "https://ec.europa.eu/growth/tools-databases/cosing/details/35499",
          retrievedAt: RETRIEVED_AT,
        },
      },
      profile: {
        glossaryName: "GLOSSARY",
        inciName: "INCI",
        innName: "INN",
        inciUsaName: "INCI USA",
        phEurName: "PH EUR",
        chemicalName: "CHEMICAL",
        chemicalDescription: "A chemical description.",
        functions: ["SMOOTHING"],
        status: "Active",
        annexNumbers: ["III"],
        identifiedIngredientIds: ["123"],
        perfuming: true,
        officialJournalPublication: false,
        notes: ["A note", " "],
        sccsOpinionUrls: ["https://example.test/sccs-opinion"],
        relatedRegulations: ["Related regulation"],
        otherRegulations: ["Other regulation"],
      },
      regulatory: { notices: [] },
    }));
    harness = await start(createRegistry([adapter], []));

    const output = await getIngredient(harness, {
      source: "cosing",
      id: "35499",
    });
    expect(output.regulatory?.notices).toEqual([]);
    expect(output.links).toContainEqual({
      label: "SCCS opinion",
      url: "https://example.test/sccs-opinion",
    });

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "cosing", id: "35499" },
      }),
    );
    expect(text).toContain("INCI USA");
    expect(text).toContain("Ph. Eur.");
    expect(text).toContain("Annex: III");
    expect(text).toContain("Annex substance ids: 123");
    expect(text).toContain("Perfuming: yes");
    expect(text).toContain("Official Journal publication: no");
    expect(text).toContain("Chemical description (verbatim)");
    expect(text).toContain("Notes (verbatim) (1)");
    expect(text).toContain("Related regulations (verbatim)");
    expect(text).toContain("Other regulations (verbatim)");
  });

  it("renders a minimal RxNorm profile and skips blank display names", async () => {
    const adapter = lookupAdapter("nlm", ["RxNorm"], async () => ({
      ingredient: {
        name: "Concept",
        identifiers: { rxcui: ["1"] },
        source: {
          database: "RxNorm",
          id: "1",
          url: "https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=1",
          retrievedAt: RETRIEVED_AT,
        },
      },
      profile: {
        rxcui: "1",
        rxTerm: { displayName: "   " },
      },
    }));
    harness = await start(createRegistry([adapter], []));

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "nlm", id: "1" },
      }),
    );
    expect(text).toContain("RxNorm concept");
    expect(text).not.toContain("Display name");
  });

  it("renders clinical rows without optional references and empty lists", async () => {
    const adapter = lookupAdapter("drugcentral", ["DrugCentral"], async () => ({
      ingredient: {
        name: "Structure",
        identifiers: { structId: 1 },
        source: {
          database: "DrugCentral",
          id: "1",
          url: "https://drugcentral.org/drugcard/1",
          retrievedAt: RETRIEVED_AT,
        },
      },
      profile: {
        structId: 1,
        identifiers: [],
        atc: [],
        synonyms: [],
        clinical: {
          indications: [],
          offLabelUses: [{ name: "Condition", relationship: "off-label use" }],
          contraindications: [],
          faers: [],
          truncated: false,
        },
      },
    }));
    harness = await start(createRegistry([adapter], []));

    const text = textOf(
      await harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: {
          source: "drugcentral",
          id: "1",
          include_clinical: true,
        },
      }),
    );
    expect(text).not.toContain("Indications (source assertions)");
    expect(text).toContain("Off-label uses (source assertions)");
    expect(text).toContain("- Condition — off-label use");
    expect(text).not.toContain("Contraindications");
    expect(text).toContain("No signal rows were returned");
  });
});

describe("get_ingredient — bounds", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    resetClients();
    vi.restoreAllMocks();
  });

  it("marks clinical data truncated when bounding shortens it", async () => {
    const long = "x".repeat(6_000);
    const adapter = lookupAdapter("drugcentral", ["DrugCentral"], async () => ({
      ingredient: {
        name: "Structure",
        identifiers: { structId: 1 },
        source: {
          database: "DrugCentral",
          id: "1",
          url: "https://drugcentral.org/drugcard/1",
          retrievedAt: RETRIEVED_AT,
        },
      },
      profile: {
        structId: 1,
        clinical: {
          indications: Array.from({ length: 5 }, (_, index) => ({
            name: `${long}-${index}`,
            relationship: "indication",
          })),
          offLabelUses: [],
          contraindications: [],
          faers: [],
          truncated: false,
        },
      },
    }));
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: {
        source: "drugcentral",
        id: "1",
        include_clinical: true,
      },
    });

    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as unknown as IngredientOutput & {
      profile: { clinical: { truncated: boolean } };
    };
    expect(output.profile.clinical.truncated).toBe(true);
    expect(textOf(result)).toContain("[Some fields were shortened");
  });

  it("bounds an oversized profile and says fields were shortened", async () => {
    const names = Array.from({ length: 100 }, (_, index) => ({
      name: `Name ${index} with a deliberately long descriptive label`,
      organizations: ["Organization ".repeat(10)],
    }));
    const adapter = lookupAdapter("openfda", ["openFDA"], async () => ({
      ingredient: {
        name: "Oversized",
        identifiers: { unii: "ABCDEFGHIJ" },
        source: {
          database: "openFDA",
          id: "ABCDEFGHIJ",
          url: "https://example.test/openFDA/ABCDEFGHIJ",
          retrievedAt: RETRIEVED_AT,
        },
        summary: "x".repeat(20_000),
      },
      profile: {
        substanceClass: "chemical",
        names,
        codes: Array.from({ length: 100 }, (_, index) => ({
          code: `CODE${index}`,
          system: "TESTING",
        })),
        relationships: Array.from({ length: 100 }, (_, index) => ({
          type: "RELATIONSHIP",
          relatedName: `Related ${index}`,
        })),
        extra: "stripped",
      },
    }));
    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "openfda", id: "ABCDEFGHIJ" },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(
      CHARACTER_LIMIT,
    );
    expect(
      (result.structuredContent as { profile?: Record<string, unknown> })
        .profile,
    ).not.toHaveProperty("extra");
    const text = textOf(result);
    expect(text).toContain("[Some fields were shortened");
  });
});
