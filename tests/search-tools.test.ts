import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import {
  CHARACTER_LIMIT,
  SERVER_NAME,
  SERVER_VERSION,
} from "../src/constants.js";
import { searchNextSteps } from "../src/lib/next-steps.js";
import type {
  DatabaseId,
  IngredientRef,
  IngredientSearchEntity,
  NextStep,
  ProductIdentifiers,
  ProductRef,
  ProductSearchEntity,
  SourceSearchStatus,
} from "../src/lib/schemas.js";
import type { IdentityResolver } from "../src/sources/identity/chain.js";
import { createRegistry } from "../src/sources/registry.js";
import type {
  IngredientGroup,
  IngredientSearchType,
  ProductCategory,
  ProductGroup,
  ProductSearchType,
  Registry,
  SourceAdapter,
} from "../src/sources/types.js";
import { registerSearchIngredientsTool } from "../src/tools/search-ingredients.js";
import { registerSearchProductsTool } from "../src/tools/search-products.js";
import { resolveRegistry } from "../src/tools/search-support.js";
import { createTestClient, type TestHarness, textOf } from "./helpers.js";

/**
 * The unified search tools fan a query out over every capable source and
 * return source-grouped results. These tests drive a real MCP client against a
 * test server wired to fake adapters, so schema validation, tool registration,
 * and the result shape are exercised exactly as a host sees them.
 */

const RETRIEVED_AT = "2026-10-21T12:00:00.000Z";

const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

interface ProductSearchOutput {
  query: string;
  page: number;
  entities: ProductSearchEntity[];
  sources: SourceSearchStatus[];
  nextSteps: NextStep[];
}

interface IngredientSearchOutput {
  query: string;
  page: number;
  entities: IngredientSearchEntity[];
  sources: SourceSearchStatus[];
  nextSteps: NextStep[];
}

/** Mirrors an adapter's source id: the database's canonical lookup key. */
function productSourceId(
  name: string,
  identifiers: ProductIdentifiers,
): string {
  if (identifiers.dsldId !== undefined) return String(identifiers.dsldId);
  if (identifiers.splSetId !== undefined) return identifiers.splSetId;
  if (identifiers.slug !== undefined) return identifiers.slug;
  const ndc = identifiers.ndc?.[0];
  if (ndc !== undefined) return ndc;
  const rxcui = identifiers.rxcui?.[0];
  if (rxcui !== undefined) return rxcui;
  return name;
}

function productRef(
  database: DatabaseId,
  name: string,
  identifiers: ProductIdentifiers = {},
  extra: Partial<ProductRef> = {},
): ProductRef {
  return {
    name,
    identifiers,
    source: {
      database,
      id: productSourceId(name, identifiers),
      url: `https://example.test/${database}/${encodeURIComponent(name)}`,
      retrievedAt: RETRIEVED_AT,
    },
    ...extra,
  };
}

/** Enough product data to push both compact and rendered output over the cap. */
function oversizedProductItems(): ProductRef[] {
  return Array.from({ length: 300 }, (_, index) =>
    productRef(
      "openFDA",
      `Product ${index} with a long descriptive name`,
      { ndc: [`0000000000${index}`] },
      {
        category: "medication",
        summary:
          "A deliberately long summary used to exercise response bounding. ".repeat(
            2,
          ),
      },
    ),
  );
}

function ingredientRef(
  database: DatabaseId,
  name: string,
  identifiers: IngredientRef["identifiers"] = {},
  extra: Partial<IngredientRef> = {},
): IngredientRef {
  return {
    name,
    identifiers,
    source: {
      database,
      id: name,
      url: `https://example.test/${database}/${encodeURIComponent(name)}`,
      retrievedAt: RETRIEVED_AT,
    },
    ...extra,
  };
}

function productGroup(
  source: DatabaseId,
  items: ProductRef[],
  page = 1,
  hasMore = false,
): ProductGroup {
  return { source, items, page, hasMore };
}

function ingredientGroup(
  source: DatabaseId,
  items: IngredientRef[],
  page = 1,
  hasMore = false,
): IngredientGroup {
  return { source, items, page, hasMore };
}

interface FakeAdapterInput {
  id: string;
  databases: DatabaseId[];
  productTypes?: ProductSearchType[];
  ingredientTypes?: IngredientSearchType[];
  categories?: ProductCategory[];
  searchProducts?: SourceAdapter["searchProducts"];
  searchIngredients?: SourceAdapter["searchIngredients"];
}

/** Builds an adapter with only the capabilities a test names. */
function fakeAdapter(input: FakeAdapterInput): SourceAdapter {
  return {
    id: input.id,
    databases: input.databases,
    productSearchTypes: input.productTypes ?? [],
    ingredientSearchTypes: input.ingredientTypes ?? [],
    productCategories: input.categories ?? [],
    ...(input.searchProducts === undefined
      ? {}
      : { searchProducts: input.searchProducts }),
    ...(input.searchIngredients === undefined
      ? {}
      : { searchIngredients: input.searchIngredients }),
  };
}

const noResolution: IdentityResolver = {
  resolve: async () => ({
    kind: "ingredient",
    graph: { subject: {}, identifiers: {}, links: [], candidates: [] },
  }),
};
async function start(
  registry?: Registry,
  resolver: IdentityResolver = noResolution,
): Promise<TestHarness> {
  return createTestClient(() => {
    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    registerSearchProductsTool(server, registry, resolver);
    registerSearchIngredientsTool(server, registry, resolver);
    return server;
  });
}

/** Finds a tool in a listing, failing loudly when it is absent. */
async function findTool(harness: TestHarness, name: string) {
  const { tools } = await harness.client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  return tool;
}

describe("search tools", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    clearEnv();
    resetConfig();
    vi.restoreAllMocks();
  });

  it("advertises both tools as read-only open-world searches with paging semantics", async () => {
    harness = await start(createRegistry([], []));

    const expectedInputs: Record<string, string[]> = {
      drugdata_search_products: [
        "category",
        "page",
        "query",
        "response_format",
        "type",
      ],
      drugdata_search_ingredients: ["page", "query", "response_format", "type"],
    };

    for (const [name, keys] of Object.entries(expectedInputs)) {
      const tool = await findTool(harness, name);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.description).toContain("page");
      expect(tool.description).toContain("hasMore");
      expect(tool.description).toContain("error");
      expect(tool.description).not.toMatch(/client/i);
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
        keys,
      );
    }
  });

  it("returns grouped product results with closed structured content and next steps", async () => {
    const leaked = {
      ...productRef(
        "openFDA",
        "Aspirin",
        { ndc: ["00000000001"], upc: [] },
        {
          brand: "Bayer",
          category: "medication",
          matchBasis: "name match",
        },
      ),
      upstreamSecret: "must not reach the model",
    } as ProductRef;

    const openfda = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [
        productGroup(
          "openFDA",
          [leaked, productRef("openFDA", "Plain")],
          1,
          true,
        ),
      ]),
    });
    const dsld = fakeAdapter({
      id: "dsld",
      databases: ["DSLD"],
      productTypes: ["name"],
      categories: ["supplement"],
      searchProducts: vi.fn(async () => [
        productGroup(
          "DSLD",
          [
            productRef(
              "DSLD",
              "Vitamin D",
              { dsldId: 82118 },
              {
                category: "supplement",
              },
            ),
          ],
          1,
          false,
        ),
      ]),
    });

    harness = await start(createRegistry([openfda, dsld], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "aspirin" },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductSearchOutput;
    expect(output.query).toBe("aspirin");
    expect(output.page).toBe(1);
    expect(output.sources.map((group) => group.source)).toEqual([
      "openFDA",
      "DSLD",
    ]);
    expect(output.entities).toHaveLength(3);
    expect(output.sources.map((source) => source.resultCount)).toEqual([2, 1]);

    // The output schema is closed: an adapter's stray field is stripped.
    const firstItem = output.entities[0]?.records[0];
    expect(firstItem).toBeDefined();
    expect(
      (firstItem as unknown as Record<string, unknown>).upstreamSecret,
    ).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("must not reach the model");

    expect(output.entities[0]?.nextSteps[0]).toMatchObject({
      tool: "drugdata_get_product",
      input: { source: "openfda", id: "00000000001" },
    });
    expect(output.entities[2]?.nextSteps[0]).toMatchObject({
      tool: "drugdata_get_product",
      input: { source: "dsld", id: "82118" },
    });
    expect(output.nextSteps[0]?.input.page).toBe(2);

    const text = textOf(result);
    expect(text).toContain("### openFDA — 2 results (page 1, more available)");
    expect(text).toContain("### DSLD — 1 result (page 1)");
    expect(text).toContain("brand: Bayer");
    expect(text).toContain("category: medication");
    expect(text).toContain("NDC: 00000000001");
    expect(text).toContain("match: name match");
    expect(text).toContain("https://example.test/DSLD/Vitamin%20D");
    expect(text).toContain("**Next steps**");
    expect(text).toContain("drugdata_get_product");
    expect(text).toContain("call this tool again with page: 2");
  });

  it("keeps a failed source as an error group and rewords its message", async () => {
    const openfda = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [
        productGroup("openFDA", [productRef("openFDA", "Aspirin")]),
      ]),
    });
    const dsld = fakeAdapter({
      id: "dsld",
      databases: ["DSLD"],
      productTypes: ["name"],
      categories: ["supplement"],
      searchProducts: vi.fn(async () => {
        throw new Error("@knorby/nih-dsld-client rejected the search");
      }),
    });

    harness = await start(createRegistry([openfda, dsld], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "aspirin" },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductSearchOutput;
    const errorGroup = output.sources.find((group) => group.source === "DSLD");
    expect(errorGroup?.resultCount).toBe(0);
    expect(errorGroup?.error).toContain("upstream service");
    expect(errorGroup?.error).not.toMatch(/@knorby|client/i);
    expect(
      output.sources.find((group) => group.source === "openFDA")?.resultCount,
    ).toBe(1);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/@knorby|client/i);
    expect(textOf(result)).toContain("⚠ DSLD:");
  });

  it("returns a successful empty result with guidance when nothing matches", async () => {
    const empty = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [productGroup("openFDA", [])]),
    });

    harness = await start(createRegistry([empty], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "unobtainium" },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductSearchOutput;
    expect(output.sources).toHaveLength(1);
    expect(output.entities).toEqual([]);
    expect(output.nextSteps).toEqual([]);
    expect(textOf(result)).toContain("### openFDA — 0 results");
    expect(textOf(result)).toContain("- No matches on this page.");
    expect(textOf(result)).toContain("No matches found.");
  });

  it("explains empty results when some sources failed", async () => {
    const empty = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [productGroup("openFDA", [])]),
    });
    const failing = fakeAdapter({
      id: "dsld",
      databases: ["DSLD"],
      productTypes: ["name"],
      categories: ["supplement"],
      searchProducts: vi.fn(async () => {
        throw new Error("DSLD is unavailable");
      }),
    });

    harness = await start(createRegistry([empty, failing], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "unobtainium" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(
      "No matches from the sources that answered.",
    );
  });

  it("reports when every searched source failed", async () => {
    const failing = fakeAdapter({
      id: "cosing",
      databases: ["CosIng"],
      ingredientTypes: ["name"],
      searchIngredients: vi.fn(async () => {
        throw new Error("CosIng is unavailable");
      }),
    });

    harness = await start(createRegistry([failing], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "name", query: "niacinamide" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Every searched source failed.");
  });

  it("reports when the filter leaves no source to search", async () => {
    const medicationOnly = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [productGroup("openFDA", [])]),
    });

    harness = await start(createRegistry([medicationOnly], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: {
        type: "name",
        query: "vitamin",
        category: "supplement",
      },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductSearchOutput;
    expect(output.sources).toEqual([]);
    expect(textOf(result)).toContain(
      "No source covers this search type and filter.",
    );
    expect(textOf(result)).toContain("drugdata_ping");
  });

  it("omits filter advice when a product search has no category", async () => {
    harness = await start(createRegistry([], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "vitamin" },
    });

    expect(textOf(result)).toContain("No source covers this search type.");
    expect(textOf(result)).not.toContain("and filter");
  });

  it("explains when no source covers an ingredient search type", async () => {
    harness = await start(createRegistry([], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "name", query: "niacinamide" },
    });

    expect(textOf(result)).toContain("No source covers this search type.");
    expect(textOf(result)).not.toContain("and filter");
  });

  it("applies the category filter and page to the fan-out", async () => {
    const searchProducts = vi.fn(async () => [
      productGroup("openFDA", [productRef("openFDA", "Aspirin")], 2),
    ]);
    const searchDsld = vi.fn(async () => [
      productGroup("DSLD", [productRef("DSLD", "Vitamin D", { dsldId: 7 })], 2),
    ]);
    const openfda = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts,
    });
    const dsld = fakeAdapter({
      id: "dsld",
      databases: ["DSLD"],
      productTypes: ["name"],
      categories: ["supplement"],
      searchProducts: searchDsld,
    });

    harness = await start(createRegistry([openfda, dsld], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: {
        type: "name",
        query: "vitamin",
        category: "supplement",
        page: 2,
      },
    });

    expect(searchProducts).not.toHaveBeenCalled();
    expect(searchDsld).toHaveBeenCalledWith(
      "name",
      "vitamin",
      2,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const output = result.structuredContent as ProductSearchOutput;
    expect(output.page).toBe(2);
    expect(output.sources.map((group) => group.source)).toEqual(["DSLD"]);
    expect(output.sources[0]?.page).toBe(2);
  });

  it("returns JSON text when response_format is json", async () => {
    const adapter = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [
        productGroup("openFDA", [
          productRef("openFDA", "Aspirin", { ndc: ["00000000001"] }),
        ]),
      ]),
    });

    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: {
        type: "name",
        query: "aspirin",
        response_format: "json",
      },
    });

    const text = textOf(result);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it("returns parseable JSON for an oversized product result", async () => {
    const adapter = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [
        productGroup("openFDA", oversizedProductItems()),
      ]),
    });

    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: {
        type: "name",
        query: "product",
        response_format: "json",
      },
    });

    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it("adds empty-result guidance as a separate JSON block", async () => {
    const adapter = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [productGroup("openFDA", [])]),
    });

    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: {
        type: "name",
        query: "unobtainium",
        category: "medication",
        response_format: "json",
      },
    });

    const blocks = result.content as { type: string; text: string }[];
    const jsonBlock = blocks[0];
    const guidance = blocks[1];
    if (jsonBlock === undefined || guidance === undefined) {
      throw new Error("expected a JSON block and a guidance block");
    }
    expect(JSON.parse(jsonBlock.text)).toEqual(result.structuredContent);
    expect(guidance.text).toContain("No matches found.");
    expect(guidance.text).toContain("remove the category filter");
  });

  it("renders ingredient results and suggests resolving a UNII", async () => {
    const openfda = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      ingredientTypes: ["name"],
      searchIngredients: vi.fn(async () => [
        ingredientGroup("openFDA", [
          ingredientRef(
            "openFDA",
            "Niacinamide",
            { unii: "25X51I8RD4", cas: ["98-92-0"] },
            {
              inciName: "NIACINAMIDE",
              role: "active",
              quantity: "10%",
              matchBasis: "exact match",
            },
          ),
          ingredientRef(
            "openFDA",
            "No identifiers",
            { cas: [] },
            { inciName: "No identifiers" },
          ),
          ingredientRef("openFDA", "Plain"),
        ]),
      ]),
    });

    harness = await start(createRegistry([openfda], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "name", query: "niacinamide" },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as IngredientSearchOutput;
    expect(output.query).toBe("niacinamide");
    expect(output.sources).toHaveLength(1);
    expect(output.entities).toHaveLength(3);
    expect(output.entities[0]?.nextSteps).toContainEqual(
      expect.objectContaining({
        tool: "drugdata_resolve_identifiers",
        input: { unii: "25X51I8RD4" },
      }),
    );

    const text = textOf(result);
    expect(text).toContain("### openFDA — 3 results (page 1)");
    expect(text).toContain("INCI: NIACINAMIDE");
    expect(text).toContain("role: active");
    expect(text).toContain("quantity: 10%");
    expect(text).toContain("UNII: 25X51I8RD4");
    expect(text).toContain("CAS: 98-92-0");
    expect(text).toContain("match: exact match");
    expect(text).toContain("drugdata_resolve_identifiers");
  });

  it("returns JSON text for an ingredient search", async () => {
    const adapter = fakeAdapter({
      id: "cosing",
      databases: ["CosIng"],
      ingredientTypes: ["name"],
      searchIngredients: vi.fn(async () => [
        ingredientGroup("CosIng", [
          ingredientRef(
            "CosIng",
            "Niacinamide",
            {},
            { inciName: "NIACINAMIDE" },
          ),
        ]),
      ]),
    });

    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: {
        type: "name",
        query: "niacinamide",
        response_format: "json",
      },
    });

    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("gives ingredient-specific empty guidance without a category filter", async () => {
    const adapter = fakeAdapter({
      id: "cosing",
      databases: ["CosIng"],
      ingredientTypes: ["name"],
      searchIngredients: vi.fn(async () => [ingredientGroup("CosIng", [])]),
    });

    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: {
        type: "name",
        query: "unobtainium",
        response_format: "json",
      },
    });

    const blocks = result.content as { type: string; text: string }[];
    const jsonBlock = blocks[0];
    const guidance = blocks[1];
    if (jsonBlock === undefined || guidance === undefined) {
      throw new Error("expected a JSON block and a guidance block");
    }
    expect(JSON.parse(jsonBlock.text)).toEqual(result.structuredContent);
    expect(guidance.text).toContain("name search");
    expect(guidance.text).not.toContain("category filter");
  });

  it("renders single-result, empty, and oversized ingredient groups", async () => {
    const cosing = fakeAdapter({
      id: "cosing",
      databases: ["CosIng"],
      ingredientTypes: ["name"],
      searchIngredients: vi.fn(async () => [
        ingredientGroup(
          "CosIng",
          [ingredientRef("CosIng", "Niacinamide", {})],
          1,
          true,
        ),
      ]),
    });
    const largeItems = Array.from({ length: 300 }, (_, index) =>
      ingredientRef(
        "DrugCentral",
        `Ingredient ${index} with a long descriptive name`,
        { structId: index + 1 },
        {
          summary:
            "A deliberately long summary used to exercise response bounding. ".repeat(
              2,
            ),
        },
      ),
    );
    const drugcentral = fakeAdapter({
      id: "drugcentral",
      databases: ["DrugCentral"],
      ingredientTypes: ["name"],
      searchIngredients: vi.fn(async () => [
        ingredientGroup("DrugCentral", largeItems),
      ]),
    });
    const empty = fakeAdapter({
      id: "nlm",
      databases: ["RxNorm"],
      ingredientTypes: ["name"],
      searchIngredients: vi.fn(async () => [ingredientGroup("RxNorm", [])]),
    });

    harness = await start(createRegistry([cosing, drugcentral, empty], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "name", query: "niacinamide" },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(
      CHARACTER_LIMIT,
    );
    const text = textOf(result);
    expect(text).toContain("### CosIng — 1 result (page 1, more available)");
    expect(text).toContain("### RxNorm — 0 results (page 1)");
    expect(text).toContain("- No matches on this page.");
    expect(text).toContain("Response truncated");
    expect(text).toContain("call this tool again with page: 2");
  });

  it("reports invalid configuration as an actionable error for both tools", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "not-a-source";
    resetConfig();
    harness = await start();

    const products = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "aspirin" },
    });
    expect(products.isError).toBe(true);
    expect(textOf(products)).toContain("DRUGDATA_DISABLED_SOURCES");

    const ingredients = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "name", query: "niacinamide" },
    });
    expect(ingredients.isError).toBe(true);
    expect(textOf(ingredients)).toContain("DRUGDATA_DISABLED_SOURCES");
  });

  it("turns a registry failure into an isError result without leaking internals", async () => {
    const failing = {
      searchProducts: vi.fn(async () => {
        throw new Error("@knorby/openfda-client exploded");
      }),
      searchIngredients: vi.fn(async () => {
        throw Object.assign(new Error("upstream unavailable"), { status: 503 });
      }),
    } as unknown as Registry;
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    harness = await start(failing);

    const products = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "aspirin" },
    });
    expect(products.isError).toBe(true);
    expect(textOf(products)).toContain("failed unexpectedly");
    expect(textOf(products)).toContain("upstream service");
    expect(textOf(products)).not.toMatch(/@knorby|client/i);
    // The raw failure is logged for the operator, never returned to the model.
    expect(String(write.mock.calls[0]?.[0])).toContain("exploded");

    const ingredients = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "name", query: "niacinamide" },
    });
    expect(ingredients.isError).toBe(true);
    expect(textOf(ingredients)).toContain("HTTP 503");
  });

  it("bounds an oversized search and says so in the text", async () => {
    const adapter = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      categories: ["medication"],
      searchProducts: vi.fn(async () => [
        productGroup("openFDA", oversizedProductItems()),
      ]),
    });

    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "product" },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(
      CHARACTER_LIMIT,
    );
    expect(textOf(result)).toContain("Response truncated");
  });

  it("preserves source paging advice when entities are bounded", async () => {
    const sources: DatabaseId[] = [
      "openFDA",
      "DSLD",
      "INKEEDecoder",
      "RxNorm",
      "CosIng",
      "DrugCentral",
    ];
    const groups = sources.map((source, index) =>
      productGroup(
        source,
        Array.from({ length: 8 }, (_, itemIndex) =>
          productRef(
            source,
            `${source} product ${itemIndex} with a long descriptive name`,
            { ndc: [`00000000${itemIndex}`] },
            {
              category: "medication",
              summary: "x".repeat(2_000),
            },
          ),
        ),
        1,
        index === 3,
      ),
    );
    const adapter = fakeAdapter({
      id: "openfda",
      databases: sources,
      productTypes: ["name"],
      searchProducts: vi.fn(async () => groups),
    });

    harness = await start(createRegistry([adapter], []));

    const result = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "product" },
    });

    const output = result.structuredContent as ProductSearchOutput;
    expect(output.sources.length).toBe(sources.length);
    expect(textOf(result)).toContain("More results available");
  });

  it("builds the default registry from valid configuration", () => {
    const resolved = resolveRegistry();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.registry).toBeDefined();
    }
  });
});

describe("searchNextSteps", () => {
  function firstStep(steps: NextStep[]): NextStep | undefined {
    return steps[0];
  }

  it("suggests product lookups from each database's identifiers", () => {
    const openfda = firstStep(
      searchNextSteps("name", [
        {
          source: "openFDA",
          page: 1,
          hasMore: false,
          items: [productRef("openFDA", "Aspirin", { ndc: ["00000000001"] })],
        },
      ]),
    );
    expect(openfda).toMatchObject({
      tool: "drugdata_get_product",
      input: { source: "openfda", id: "00000000001" },
    });

    const dailyMed = firstStep(
      searchNextSteps("name", [
        {
          source: "DailyMed",
          page: 1,
          hasMore: false,
          items: [productRef("DailyMed", "Label", { splSetId: "set-1" })],
        },
      ]),
    );
    expect(dailyMed).toMatchObject({
      tool: "drugdata_get_product",
      input: {
        source: "dailymed",
        id: "set-1",
      },
    });
    expect(dailyMed?.why).toContain("include_label_sections");

    const dsld = firstStep(
      searchNextSteps("brand", [
        {
          source: "DSLD",
          page: 1,
          hasMore: false,
          items: [productRef("DSLD", "Vitamin D", { dsldId: 42 })],
        },
      ]),
    );
    expect(dsld).toMatchObject({
      tool: "drugdata_get_product",
      input: { source: "dsld", id: "42" },
    });

    const inkeedecoder = firstStep(
      searchNextSteps("name", [
        {
          source: "INKEEDecoder",
          page: 1,
          hasMore: false,
          items: [
            productRef(
              "INKEEDecoder",
              "Product",
              { slug: "product" },
              { category: "cosmetic" },
            ),
          ],
        },
      ]),
    );
    expect(inkeedecoder).toMatchObject({
      tool: "drugdata_get_product",
      input: { source: "inkeedecoder", id: "product" },
    });

    const rxnorm = firstStep(
      searchNextSteps("ndc", [
        {
          source: "RxNorm",
          page: 1,
          hasMore: false,
          items: [productRef("RxNorm", "Concept", { rxcui: ["1191"] })],
        },
      ]),
    );
    expect(rxnorm).toMatchObject({
      tool: "drugdata_get_ingredient",
      input: { source: "nlm", id: "1191" },
    });
  });

  it("skips product groups from databases without a product lookup", () => {
    for (const database of ["CosIng", "DrugCentral"] as const) {
      expect(
        searchNextSteps("name", [
          {
            source: database,
            page: 1,
            hasMore: false,
            items: [
              productRef(database, "No lookup", {}, { category: "medication" }),
            ],
          },
        ]),
      ).toEqual([]);
    }
  });

  it("suggests resolving a UNII before a database lookup", () => {
    const steps = searchNextSteps("inci", [
      {
        source: "openFDA",
        page: 1,
        hasMore: false,
        items: [
          ingredientRef("openFDA", "Niacinamide", {
            unii: "25X51I8RD4",
            cas: ["98-92-0"],
          }),
        ],
      },
    ]);

    expect(steps).toEqual([
      {
        tool: "drugdata_resolve_identifiers",
        input: { unii: "25X51I8RD4" },
        why: "The inci search found UNII 25X51I8RD4; resolve it across the other databases for linked records.",
      },
    ]);
  });

  it("suggests ingredient lookups from each database's identifiers", () => {
    const cosing = firstStep(
      searchNextSteps("name", [
        {
          source: "CosIng",
          page: 1,
          hasMore: false,
          items: [ingredientRef("CosIng", "Niacinamide", {})],
        },
      ]),
    );
    expect(cosing).toMatchObject({
      tool: "drugdata_get_ingredient",
      input: { source: "cosing", id: "Niacinamide" },
    });

    const drugcentral = firstStep(
      searchNextSteps("cas", [
        {
          source: "DrugCentral",
          page: 1,
          hasMore: false,
          items: [ingredientRef("DrugCentral", "Aspirin", { structId: 74 })],
        },
      ]),
    );
    expect(drugcentral).toMatchObject({
      tool: "drugdata_get_ingredient",
      input: { source: "drugcentral", id: "74" },
    });

    const rxnorm = firstStep(
      searchNextSteps("rxcui", [
        {
          source: "RxNorm",
          page: 1,
          hasMore: false,
          items: [ingredientRef("RxNorm", "Aspirin", { rxcui: ["1191"] })],
        },
      ]),
    );
    expect(rxnorm).toMatchObject({
      tool: "drugdata_get_ingredient",
      input: { source: "nlm", id: "1191" },
    });

    const inkeedecoder = firstStep(
      searchNextSteps("inci", [
        {
          source: "INKEEDecoder",
          page: 1,
          hasMore: false,
          items: [
            ingredientRef("INKEEDecoder", "Niacinamide", {
              slug: "niacinamide",
            }),
          ],
        },
      ]),
    );
    expect(inkeedecoder).toMatchObject({
      tool: "drugdata_get_ingredient",
      input: { source: "inkeedecoder", id: "niacinamide" },
    });
  });

  it("skips ingredients with no usable identifier or lookup", () => {
    const cases: Array<[DatabaseId, IngredientRef["identifiers"]]> = [
      ["openFDA", {}],
      ["DrugCentral", {}],
      ["RxNorm", {}],
      ["INKEEDecoder", {}],
      ["DSLD", {}],
    ];

    for (const [database, identifiers] of cases) {
      expect(
        searchNextSteps("name", [
          {
            source: database,
            page: 1,
            hasMore: false,
            items: [ingredientRef(database, "No identifier", identifiers)],
          },
        ]),
      ).toEqual([]);
    }
  });

  it("deduplicates repeated identifiers", () => {
    const steps = searchNextSteps("name", [
      {
        source: "openFDA",
        page: 1,
        hasMore: false,
        items: [ingredientRef("openFDA", "A", { unii: "ABCDEFGHIJ" })],
      },
      {
        source: "openFDA",
        page: 1,
        hasMore: false,
        items: [ingredientRef("openFDA", "B", { unii: "ABCDEFGHIJ" })],
      },
    ]);

    expect(steps).toHaveLength(1);
  });

  it("keeps one step per group and caps the list at three", () => {
    const steps = searchNextSteps("name", [
      {
        source: "openFDA",
        page: 1,
        hasMore: false,
        items: [
          ingredientRef("openFDA", "A", { unii: "ABCDEFGHIJ" }),
          ingredientRef("openFDA", "B", { unii: "KLMNOPQRST" }),
        ],
      },
      {
        source: "CosIng",
        page: 1,
        hasMore: false,
        items: [ingredientRef("CosIng", "C", {})],
      },
      {
        source: "DrugCentral",
        page: 1,
        hasMore: false,
        items: [ingredientRef("DrugCentral", "D", { structId: 74 })],
      },
      {
        source: "RxNorm",
        page: 1,
        hasMore: false,
        items: [ingredientRef("RxNorm", "E", { rxcui: ["1191"] })],
      },
    ]);

    expect(steps.map((step) => step.tool)).toEqual([
      "drugdata_resolve_identifiers",
      "drugdata_get_ingredient",
      "drugdata_get_ingredient",
    ]);
    expect(steps[1]?.input).toEqual({ source: "cosing", id: "C" });
    expect(steps[2]?.input).toEqual({ source: "drugcentral", id: "74" });
  });

  it("returns no steps for an empty result", () => {
    expect(searchNextSteps("name", [])).toEqual([]);
  });
});

describe("request cancellation", () => {
  it("returns a cancelled error result instead of error groups", async () => {
    const controller = new AbortController();
    const first = vi.fn();
    const hanging = fakeAdapter({
      id: "openfda",
      databases: ["openFDA"],
      productTypes: ["name"],
      searchProducts: async (_type, _query, _page, signal) => {
        first();
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return [];
      },
    });
    const registry = createRegistry([hanging], []);
    let handler:
      | ((args: unknown, ctx: unknown) => Promise<unknown>)
      | undefined;
    const server = {
      registerTool: (
        _name: string,
        _config: unknown,
        callback: (args: unknown, ctx: unknown) => Promise<unknown>,
      ) => {
        handler = callback;
      },
    } as unknown as McpServer;
    registerSearchProductsTool(server, registry);

    const pending = handler?.(
      {
        type: "name",
        query: "aspirin",
        page: 1,
        response_format: "markdown",
      },
      { mcpReq: { signal: controller.signal } },
    );
    await Promise.resolve();
    controller.abort(
      new DOMException(
        "The request was cancelled by the caller.",
        "AbortError",
      ),
    );
    const result = (await pending) as {
      isError?: boolean;
      content: unknown;
    };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cancelled");
    expect(first).toHaveBeenCalledTimes(1);
  });
});
