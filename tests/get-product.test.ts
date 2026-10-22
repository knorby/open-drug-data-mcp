import { readFileSync } from "node:fs";
import { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import { type FetchLike, OpenFdaClient } from "@knorby/openfda-client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import {
  CHARACTER_LIMIT,
  SERVER_NAME,
  SERVER_VERSION,
} from "../src/constants.js";
import {
  type ProductDetailSubject,
  productDetailNextSteps,
} from "../src/lib/next-steps.js";
import type {
  IngredientRef,
  NextStep,
  ProductRef,
} from "../src/lib/schemas.js";
import { createDsldAdapter } from "../src/sources/dsld.js";
import { createInkeedecoderAdapter } from "../src/sources/inkeedecoder.js";
import { createNlmAdapter } from "../src/sources/nlm.js";
import { createOpenFdaAdapter } from "../src/sources/openfda.js";
import { createRegistry } from "../src/sources/registry.js";
import type { Registry, SourceAdapter } from "../src/sources/types.js";
import { registerGetProductTool } from "../src/tools/get-product.js";
import {
  createTestClient,
  jsonResponse,
  type TestHarness,
  textOf,
} from "./helpers.js";

/**
 * `drugdata_get_product` is driven through a real MCP client. Most cases use a
 * registry built from the real adapters and their captured fixtures, so the
 * adapter lookups, the tool's closed output schema, and the rendered text are
 * all exercised the way a host sees them.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url);
const SPL_SETID = "a1e07d5c-2056-46f3-8737-f03ed0b4bae8";
const OVERSIZED_SETID = "ffffffff-1111-4111-8111-111111111111";
const RETRIEVED_AT = "2026-10-21T12:00:00.000Z";
const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
] as const;

function fixturePath(path: string): string {
  return new URL(path, FIXTURES).pathname;
}

function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(fixturePath(path), "utf8")) as T;
}

function textFixture(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}

type Handler = (url: URL) => Response | Promise<Response>;

function nlmClient(handler: Handler): NlmDrugsClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    handler(new URL(String(input))),
  );
  return new NlmDrugsClient({
    fetch: fetchMock as unknown as typeof fetch,
  });
}

function openFdaClient(handler: Handler): OpenFdaClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    handler(new URL(String(input))),
  );
  return new OpenFdaClient({
    fetch: fetchMock as unknown as FetchLike,
    timeoutMs: 5_000,
  });
}

/** The DSLD and INKEEDecoder clients share one injectable-fetch shape. */
function fetchHandler(handler: Handler): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) =>
    handler(new URL(String(input))),
  ) as unknown as typeof fetch;
}

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function start(registry?: Registry): Promise<TestHarness> {
  return createTestClient(() => {
    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    registerGetProductTool(server, registry);
    return server;
  });
}

async function findTool(harness: TestHarness, name: string) {
  const { tools } = await harness.client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  return tool;
}

interface ProductDetailOutput {
  product: ProductRef;
  details: Record<string, unknown>;
  ingredients?: IngredientRef[];
  labelSections?: {
    sections: Array<{ heading: string; text: string }>;
    truncated: boolean;
  };
  links: Array<{ label: string; url: string }>;
  summary?: string;
  nextSteps: NextStep[];
  labelIngredientsIncluded: boolean;
  pagination: {
    page: number;
    ingredientsTotal: number;
    ingredientsHasMore: boolean;
    sectionsTotal: number;
    sectionsHasMore: boolean;
  };
}

function productRef(
  database: ProductRef["source"]["database"],
  name: string,
  identifiers: ProductRef["identifiers"] = {},
  extra: Partial<ProductRef> = {},
): ProductRef {
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

function ingredientRef(
  name: string,
  extra: Partial<IngredientRef> = {},
): IngredientRef {
  return {
    name,
    identifiers: {},
    source: {
      database: "DailyMed",
      id: SPL_SETID,
      url: `https://example.test/DailyMed/${SPL_SETID}`,
      retrievedAt: RETRIEVED_AT,
    },
    ...extra,
  };
}

/** An adapter that only implements a product lookup. */
function lookupAdapter(
  id: string,
  databases: ProductRef["source"]["database"][],
  getProduct: NonNullable<SourceAdapter["getProduct"]>,
): SourceAdapter {
  return {
    id,
    databases,
    productSearchTypes: [],
    ingredientSearchTypes: [],
    productCategories: [],
    getProduct,
  };
}

describe("get_product tool", () => {
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

  it("advertises the briefed product inputs and sources", async () => {
    harness = await start(createRegistry([], []));

    const tool = await findTool(harness, "drugdata_get_product");
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tool.description).toContain("include_label_sections");
    expect(tool.description).toContain("large");
    expect(tool.description).toContain("default false");
    expect(tool.description).not.toMatch(/client/i);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual([
      "id",
      "include_ingredients",
      "include_label_sections",
      "page",
      "response_format",
      "source",
    ]);
    const sourceSchema = tool.inputSchema.properties?.source as {
      enum?: string[];
    };
    expect(sourceSchema.enum).toEqual([
      "openfda",
      "dsld",
      "dailymed",
      "inkeedecoder",
    ]);
  });

  it("returns a DailyMed SPL product with parsed ingredients and next steps", async () => {
    const xml = textFixture("nlm/dailymed-spl-a1e07d5c.xml");
    const client = nlmClient((url) => {
      if (url.pathname.includes(SPL_SETID)) {
        return new Response(xml, {
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const nlm = createNlmAdapter(client);
    const original = nlm.getProduct;
    if (original === undefined)
      throw new Error("NLM adapter has no getProduct");
    const withLeak: SourceAdapter = {
      ...nlm,
      getProduct: async (...args) => ({
        ...((await original(...args)) as Record<string, unknown>),
        upstreamSecret: "must not reach the model",
      }),
    };

    harness = await start(createRegistry([withLeak], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dailymed", id: SPL_SETID },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductDetailOutput;
    expect(output.product).toMatchObject({
      name: "SOVEREIGN SILVER HOMEOPATHIC WOUND WASH",
      category: "medication",
      identifiers: {
        splSetId: SPL_SETID,
        ndc: ["52166002201"],
      },
      source: {
        database: "DailyMed",
        id: SPL_SETID,
        url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SPL_SETID}`,
      },
    });
    expect(output.details).toEqual({
      version: "2",
      effectiveTime: "20261013",
      dosageForm: "LIQUID",
      labeler: "Natural Immunogenics Corp.dba SOVEREIGN NATURALS",
    });
    expect(output.labelIngredientsIncluded).toBe(true);
    expect(output.ingredients).toEqual([
      {
        name: "Silver",
        role: "active",
        quantity: "30 [hp_X]/g",
        identifiers: { unii: "3M4G523W1G" },
        source: expect.objectContaining({
          database: "DailyMed",
          id: SPL_SETID,
        }),
      },
      {
        name: "Water",
        role: "inactive",
        identifiers: { unii: "059QF0KO0R" },
        source: expect.objectContaining({
          database: "DailyMed",
          id: SPL_SETID,
        }),
      },
    ]);
    expect(output.labelSections).toBeUndefined();
    expect(output.pagination).toEqual({
      page: 1,
      ingredientsTotal: 2,
      ingredientsHasMore: false,
      sectionsTotal: 0,
      sectionsHasMore: false,
    });
    expect(output.links[0]).toEqual({
      label: "DailyMed record",
      url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SPL_SETID}`,
    });
    expect(output.summary).toContain("SPL version 2");
    expect(output.summary).toContain("effective 20261013");
    expect(output.summary).toContain("LIQUID");
    expect(output.nextSteps[0]).toMatchObject({
      tool: "drugdata_resolve_identifiers",
      input: { unii: "3M4G523W1G" },
    });
    expect(
      (output.product as unknown as Record<string, unknown>).upstreamSecret,
    ).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("must not reach the model");

    const text = textOf(result);
    expect(text).toContain("SOVEREIGN SILVER HOMEOPATHIC WOUND WASH");
    expect(text).toContain("## Ingredients (2)");
    expect(text).toContain("role: active");
    expect(text).toContain("quantity: 30 [hp_X]/g");
    expect(text).toContain("UNII: 3M4G523W1G");
    expect(text).toContain("**Next steps**");
    expect(text).toContain("drugdata_resolve_identifiers");
    expect(text).not.toContain("## Label sections");
  });

  it("extracts DailyMed usage sections only when asked", async () => {
    const xml = textFixture("nlm/dailymed-spl-a1e07d5c.xml");
    const client = nlmClient((url) =>
      url.pathname.includes(SPL_SETID)
        ? new Response(xml, {
            headers: { "content-type": "application/xml" },
          })
        : new Response(null, { status: 404 }),
    );

    harness = await start(createRegistry([createNlmAdapter(client)], []));
    const withSections = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        include_label_sections: true,
      },
    });

    expect(withSections.isError).toBeFalsy();
    const output = withSections.structuredContent as ProductDetailOutput;
    expect(output.labelSections?.truncated).toBe(false);
    expect(output.labelSections?.sections).toEqual([
      {
        heading: "Directions",
        text: expect.stringContaining("Clean affected area"),
      },
    ]);
    expect(textOf(withSections)).toContain("## Label sections (1)");
    expect(textOf(withSections)).toContain("### Directions");

    const withoutSections = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        include_label_sections: false,
      },
    });
    expect(
      (withoutSections.structuredContent as ProductDetailOutput).labelSections,
    ).toBeUndefined();
    expect(textOf(withoutSections)).not.toContain("## Label sections");
  });

  it("distinguishes an empty page from an empty record", async () => {
    const xml = textFixture("nlm/dailymed-spl-a1e07d5c.xml");
    const client = nlmClient((url) =>
      url.pathname.includes(SPL_SETID)
        ? new Response(xml, {
            headers: { "content-type": "application/xml" },
          })
        : new Response(null, { status: 404 }),
    );

    harness = await start(createRegistry([createNlmAdapter(client)], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        page: 2,
        include_label_sections: true,
      },
    });

    const output = result.structuredContent as ProductDetailOutput;
    expect(output.ingredients).toEqual([]);
    expect(output.labelSections?.sections).toEqual([]);
    expect(output.pagination).toEqual({
      page: 2,
      ingredientsTotal: 2,
      ingredientsHasMore: false,
      sectionsTotal: 1,
      sectionsHasMore: false,
    });
    const text = textOf(result);
    expect(text).toContain(
      "No ingredient rows on page 2; the record has 2 ingredient rows.",
    );
    expect(text).toContain(
      "No usage sections on page 2; the record has 1 usage section.",
    );
  });

  it("does not mark label sections truncated when only another field is shortened", async () => {
    const adapter = lookupAdapter("nlm", ["DailyMed"], async () => ({
      product: productRef(
        "DailyMed",
        "Bounded summary",
        { splSetId: SPL_SETID },
        { summary: "x".repeat(20_000) },
      ),
      ingredients: [],
      labelSections: {
        sections: [{ heading: "Directions", text: "Use as directed." }],
        truncated: false,
      },
      summary: "y".repeat(20_000),
    }));

    harness = await start(createRegistry([adapter], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        include_label_sections: true,
      },
    });

    const output = result.structuredContent as ProductDetailOutput;
    expect(output.labelSections?.truncated).toBe(false);
    expect(output.labelSections?.sections[0]?.text).toBe("Use as directed.");
    expect(textOf(result)).toContain("Some fields were shortened");
  });

  it("bounds a deliberately oversized label and notes the truncation", async () => {
    const xml = textFixture("nlm/dailymed-spl-oversized.xml");
    const client = nlmClient((url) =>
      url.pathname.includes(OVERSIZED_SETID)
        ? new Response(xml, {
            headers: { "content-type": "application/xml" },
          })
        : new Response(null, { status: 404 }),
    );

    harness = await start(createRegistry([createNlmAdapter(client)], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: OVERSIZED_SETID,
        include_label_sections: true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(
      CHARACTER_LIMIT,
    );
    const output = result.structuredContent as ProductDetailOutput;
    expect(output.pagination.sectionsHasMore).toBe(true);
    expect(output.labelSections?.truncated).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Some fields were shortened");
    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it("returns an openFDA NDC product with directory actives by default", async () => {
    const client = openFdaClient((url) => {
      if (url.pathname === "/drug/ndc.json") {
        return jsonResponse(fixture("openfda/ndc-brand-lipitor.json"));
      }
      return new Response(null, { status: 404 });
    });

    harness = await start(createRegistry([createOpenFdaAdapter(client)], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "openfda", id: "58151-155" },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductDetailOutput;
    expect(output.product.name).toBe("atorvastatin calcium");
    expect(output.product.brand).toBe("Lipitor");
    expect(output.product.identifiers.ndc).toEqual(["58151-155-77"]);
    expect(output.product.identifiers.splSetId).toBe(
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
    );
    expect(output.details).toMatchObject({
      source: "ndc",
      labeler: "Viatris Specialty LLC",
    });
    expect(output.labelIngredientsIncluded).toBe(false);
    expect(output.ingredients).toEqual([
      {
        name: "ATORVASTATIN CALCIUM TRIHYDRATE",
        role: "active",
        quantity: "10 mg/1",
        identifiers: {},
        source: expect.objectContaining({ database: "openFDA" }),
      },
    ]);
    expect(output.ingredients?.map((item) => item.name)).not.toContain("Water");
    expect(output.pagination).toEqual({
      page: 1,
      ingredientsTotal: 1,
      ingredientsHasMore: false,
      sectionsTotal: 0,
      sectionsHasMore: false,
    });
    expect(output.links.map((link) => link.url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("api.fda.gov"),
        expect.stringContaining("dailymed.nlm.nih.gov"),
      ]),
    );
  });

  it("returns an openFDA label by SPL set id", async () => {
    const client = openFdaClient((url) => {
      if (url.pathname === "/drug/ndc.json") {
        return jsonResponse(fixture("openfda/ndc-zero-match.json"), {
          status: 404,
        });
      }
      if (url.pathname === "/drug/label.json") {
        return jsonResponse(fixture("openfda/label-setid-atorvastatin.json"));
      }
      return new Response(null, { status: 404 });
    });

    harness = await start(createRegistry([createOpenFdaAdapter(client)], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "openfda",
        id: "A60CC18B-0631-4CF0-B021-9F52224ECE65",
      },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductDetailOutput;
    expect(output.product.name).toBe("Lipitor");
    expect(output.product.source.id).toBe(
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
    );
    expect(output.product.identifiers.ndc).toEqual([
      "58151-155",
      "58151-156",
      "58151-155-77",
    ]);
    expect(output.details).toMatchObject({
      source: "label",
      effectiveTime: "20260101",
      version: "29",
    });
    expect(output.labelIngredientsIncluded).toBe(false);
    expect(output.ingredients).toEqual([]);
    expect(output.labelSections).toBeUndefined();
    expect(output.summary).toContain("effective 20260101");
    expect(textOf(result)).toContain('source: "dailymed"');
  });

  it("returns a DSLD label with active and inactive ingredient rows", async () => {
    const adapter = createDsldAdapter(
      // The DSLD client accepts a fetch override.
      new (await import("@knorby/nih-dsld-client")).DsldClient({
        fetch: fetchHandler((url) => {
          if (url.pathname.endsWith("/v9/label/82118")) {
            return jsonResponse(fixture("dsld/label-82118.json"));
          }
          if (url.pathname.endsWith("/v9/ingredient-groups")) {
            const term = url.searchParams.get("term");
            return jsonResponse(
              term === "Vitamin D3"
                ? fixture("dsld/ingredient-groups-vitamin-d3.json")
                : { hits: [] },
            );
          }
          return new Response(null, { status: 404 });
        }),
      }),
    );

    harness = await start(createRegistry([adapter], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dsld", id: "82118" },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductDetailOutput;
    expect(output.product.name).toBe("Vitamin D3 1000 IU Softgels");
    expect(output.product.identifiers).toEqual({
      dsldId: 82118,
      upc: ["0 33674 13941 7"],
    });
    expect(output.details).toEqual({
      productType: "Vitamin",
      targetGroups: ["Adult (18 - 50 Years)", "Adult (51 - 70 Years)"],
      netContents: ["90 Softgel(s)"],
      claims: ["Nutrient"],
      offMarket: false,
      entryDate: "2023-05-01",
    });
    expect(output.labelIngredientsIncluded).toBe(true);
    expect(output.ingredients?.[0]).toMatchObject({
      name: "Vitamin D3",
      role: "active",
      quantity: "25 mcg",
      identifiers: { unii: "1C6V77Q43H", cas: ["67-97-0"] },
    });
    expect(output.ingredients?.[2]).toMatchObject({
      name: "Gelatin",
      role: "inactive",
    });
    expect(output.summary).toContain("Vitamin");
    expect(output.summary).toContain("Net contents: 90 Softgel(s)");
    expect(output.summary).toContain("Label claims (verbatim): Nutrient");
    expect(textOf(result)).toContain("role: inactive");
  });

  it("returns an INKEEDecoder cosmetic product in INCI order", async () => {
    const { createInkeedecoderClient } = await import(
      "@knorby/inkeedecoder-client"
    );
    const adapter = createInkeedecoderAdapter(
      createInkeedecoderClient({
        fetch: fetchHandler((url) =>
          url.pathname === "/products/the-inkey-list-niacinamide"
            ? new Response(
                textFixture(
                  "inkeedecoder/product-the-inkey-list-niacinamide.html",
                ),
                { headers: { "content-type": "text/html" } },
              )
            : new Response(null, { status: 404 }),
        ),
      }),
    );

    harness = await start(createRegistry([adapter], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "inkeedecoder",
        id: "https://inkeedecoder.com/products/the-inkey-list-niacinamide",
      },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as ProductDetailOutput;
    expect(output.product.name).toBe("The Inkey List Niacinamide");
    expect(output.product.identifiers).toEqual({
      slug: "the-inkey-list-niacinamide",
    });
    expect(output.ingredients?.[0]).toMatchObject({
      name: "Water (Aqua/Eau)",
      identifiers: { slug: "water" },
    });
    expect(output.ingredients?.[0]?.role).toBeUndefined();
    expect(
      output.ingredients?.find((item) => item.name.startsWith("Niacinamide")),
    ).toMatchObject({ quantity: "10.0%" });
    expect(output.summary).toContain("Description:");
    expect(textOf(result)).toContain("Description:");
  });

  it("rejects malformed ids with actionable advice for each source", async () => {
    harness = await start(createRegistry([], []));

    const cases: Array<[string, string, RegExp]> = [
      ["openfda", "definitely-not-an-id", /drugdata_search_products/],
      ["dailymed", "not-a-setid", /drugdata_search_products/],
      ["dsld", "label-82118", /drugdata_search_products/],
      ["inkeedecoder", "", /drugdata_search_products/],
      [
        "inkeedecoder",
        "https://example.com/products/nope",
        /drugdata_search_products/,
      ],
    ];

    for (const [source, id, pattern] of cases) {
      const result = await harness.client.callTool({
        name: "drugdata_get_product",
        arguments: { source, id },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(pattern);
    }
  });

  it("rejects an unknown source and names the valid databases", async () => {
    harness = await start(createRegistry([], []));

    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "rxnorm", id: "617314" },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    for (const source of ["openfda", "dsld", "dailymed", "inkeedecoder"]) {
      expect(text).toContain(source);
    }
  });

  it("bounds an oversized product detail and says fields were shortened", async () => {
    const ingredients = Array.from({ length: 100 }, (_, index) =>
      ingredientRef(`Ingredient ${index} with a long descriptive name`, {
        quantity: "10 mg",
        identifiers: { unii: `UNII${String(index).padStart(6, "0")}` },
        summary:
          "A deliberately long ingredient summary used to exercise bounding. ".repeat(
            10,
          ),
      }),
    );
    const adapter = lookupAdapter("nlm", ["DailyMed"], async () => ({
      product: productRef(
        "DailyMed",
        "Oversized label",
        { splSetId: SPL_SETID },
        { category: "medication", summary: "x".repeat(20_000) },
      ),
      ingredients,
      summary: "y".repeat(20_000),
      labelIngredientsIncluded: true,
    }));

    harness = await start(createRegistry([adapter], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dailymed", id: SPL_SETID },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(
      CHARACTER_LIMIT,
    );
    const text = textOf(result);
    expect(text).toContain("Some fields were shortened");
    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it("returns parseable JSON in json mode", async () => {
    const adapter = lookupAdapter("dsld", ["DSLD"], async () => ({
      product: productRef("DSLD", "Vitamin D", { dsldId: 42 }),
      ingredients: [ingredientRef("Vitamin D3", { role: "active" })],
    }));

    harness = await start(createRegistry([adapter], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dsld", id: "42", response_format: "json" },
    });

    const text = textOf(result);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it("turns an upstream failure into a sanitized error result", async () => {
    const failing = {
      getProduct: vi.fn(async () => {
        throw Object.assign(
          new Error("@knorby/nlm-drugs-client rejected the request"),
          { status: 503 },
        );
      }),
    } as unknown as Registry;

    harness = await start(failing);
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dailymed", id: SPL_SETID },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("HTTP 503");
    expect(text).not.toMatch(/@knorby|client/i);
  });

  it("reports invalid configuration as an actionable error", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "not-a-source";
    resetConfig();
    harness = await start();

    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dailymed", id: SPL_SETID },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("DRUGDATA_DISABLED_SOURCES");
  });

  it("explains when a product has no ingredient rows", async () => {
    const adapter = lookupAdapter(
      "inkeedecoder",
      ["INKEEDecoder"],
      async () => ({
        product: productRef("INKEEDecoder", "Bare product", {
          slug: "bare-product",
        }),
        ingredients: [],
      }),
    );

    harness = await start(createRegistry([adapter], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "inkeedecoder", id: "bare-product" },
    });

    expect(textOf(result)).toContain("No ingredient rows are available");
  });

  it("adds cross-database links and renders identifier-free products", async () => {
    const crossLinked = lookupAdapter("openfda", ["openFDA"], async () => ({
      product: productRef(
        "openFDA",
        "Cross-linked",
        { ndc: ["00000000001"], dsldId: 42, slug: "cross-product" },
        { category: "medication" },
      ),
      ingredients: [],
    }));

    harness = await start(createRegistry([crossLinked], []));
    const linked = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "openfda", id: "00000000001" },
    });
    const linkedOutput = linked.structuredContent as ProductDetailOutput;
    expect(linkedOutput.links.map((link) => link.label)).toEqual(
      expect.arrayContaining([
        "openFDA record",
        "DSLD label",
        "INKEEDecoder product",
      ]),
    );
    expect(textOf(linked)).toContain("https://dsld.od.nih.gov/label/42");

    const bare = lookupAdapter("dsld", ["DSLD"], async () => ({
      product: productRef(
        "DSLD",
        "No identifiers",
        {},
        {
          category: "supplement",
        },
      ),
      ingredients: [],
      summary: "Fallback summary",
    }));
    harness = await start(createRegistry([bare], []));
    const bareResult = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dsld", id: "42" },
    });
    const bareOutput = bareResult.structuredContent as ProductDetailOutput;
    expect(bareOutput.product.identifiers).toEqual({});
    expect(bareOutput.summary).toBe("Fallback summary");
    expect(textOf(bareResult)).not.toContain("- Identifiers:");
    expect(textOf(bareResult)).toContain("- Summary: Fallback summary");
  });

  it("renders market status, partial INKEEDecoder details, and ingredient forms", async () => {
    const supplement = lookupAdapter("dsld", ["DSLD"], async () => ({
      product: productRef("DSLD", "Off-market supplement", { dsldId: 43 }),
      ingredients: [],
      details: { productType: "Vitamin", offMarket: true },
    }));
    harness = await start(createRegistry([supplement], []));
    const supplementResult = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "dsld", id: "43" },
    });
    expect(
      (supplementResult.structuredContent as ProductDetailOutput).summary,
    ).toBe("Vitamin · Off market");

    const cosmetic = lookupAdapter(
      "inkeedecoder",
      ["INKEEDecoder"],
      async () => ({
        product: productRef("INKEEDecoder", "Cosmetic", { slug: "cosmetic" }),
        ingredients: [
          ingredientRef("Powdered thing", {
            role: "active",
            identifiers: {},
            form: "POWDER",
          }),
        ],
        details: {
          hashtags: ["Alcohol Free"],
          updatedAt: "2026-01-01",
        },
      }),
    );
    harness = await start(createRegistry([cosmetic], []));
    const cosmeticResult = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "inkeedecoder", id: "cosmetic" },
    });
    const cosmeticOutput =
      cosmeticResult.structuredContent as ProductDetailOutput;
    expect(cosmeticOutput.summary).toBe(
      "Claims: Alcohol Free · Updated: 2026-01-01",
    );
    const text = textOf(cosmeticResult);
    expect(text).toContain("form: POWDER");
    expect(text).not.toContain("Description:");
  });

  it("labels partial upload provenance from INKEEDecoder", async () => {
    let call = 0;
    const adapter = lookupAdapter(
      "inkeedecoder",
      ["INKEEDecoder"],
      async () => {
        const details =
          call++ === 0 ? { uploadedBy: "alice" } : { uploadedAt: "2026-02-02" };
        return {
          product: productRef("INKEEDecoder", "Uploaded", {
            slug: "uploaded",
          }),
          ingredients: [],
          details,
        };
      },
    );

    harness = await start(createRegistry([adapter], []));
    const byUser = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "inkeedecoder", id: "uploaded" },
    });
    expect((byUser.structuredContent as ProductDetailOutput).summary).toBe(
      "Uploaded by alice",
    );

    const byDate = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: { source: "inkeedecoder", id: "uploaded" },
    });
    expect((byDate.structuredContent as ProductDetailOutput).summary).toBe(
      "Uploaded on 2026-02-02",
    );
  });

  it("pages ingredient and label-section collections and honors include_ingredients", async () => {
    const ingredients = Array.from({ length: 30 }, (_, index) =>
      ingredientRef(`Ingredient ${index}`, {
        role: "active",
        identifiers: { unii: `UNII${String(index).padStart(6, "0")}` },
      }),
    );
    const sections = Array.from({ length: 15 }, (_, index) => ({
      heading: `Section ${index}`,
      text: `Text for section ${index}.`,
    }));
    const adapter = lookupAdapter("nlm", ["DailyMed"], async () => ({
      product: productRef("DailyMed", "Large label", { splSetId: SPL_SETID }),
      ingredients,
      labelSections: { sections, truncated: false },
    }));

    harness = await start(createRegistry([adapter], []));
    const first = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        include_label_sections: true,
      },
    });
    const firstOutput = first.structuredContent as ProductDetailOutput;
    expect(firstOutput.ingredients).toHaveLength(25);
    expect(firstOutput.labelSections?.sections).toHaveLength(10);
    expect(firstOutput.pagination).toEqual({
      page: 1,
      ingredientsTotal: 30,
      ingredientsHasMore: true,
      sectionsTotal: 15,
      sectionsHasMore: true,
    });
    expect(textOf(first)).toContain(
      "More results available — call this tool again with page: 2.",
    );

    const second = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        include_label_sections: true,
        page: 2,
      },
    });
    const secondOutput = second.structuredContent as ProductDetailOutput;
    expect(secondOutput.ingredients).toHaveLength(5);
    expect(secondOutput.ingredients?.[0]?.name).toBe("Ingredient 25");
    expect(secondOutput.labelSections?.sections).toHaveLength(5);
    expect(secondOutput.pagination).toEqual({
      page: 2,
      ingredientsTotal: 30,
      ingredientsHasMore: false,
      sectionsTotal: 15,
      sectionsHasMore: false,
    });

    const noIngredients = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        include_ingredients: false,
      },
    });
    const noIngredientsOutput =
      noIngredients.structuredContent as ProductDetailOutput;
    expect(noIngredientsOutput.ingredients).toBeUndefined();
    expect(noIngredientsOutput.labelIngredientsIncluded).toBe(false);
    expect(noIngredientsOutput.pagination.ingredientsHasMore).toBe(false);
    expect(textOf(noIngredients)).toContain(
      "Ingredients omitted (include_ingredients: false).",
    );
  });

  it("explains when a requested label has no usage sections", async () => {
    const adapter = lookupAdapter("nlm", ["DailyMed"], async () => ({
      product: productRef("DailyMed", "No sections", { splSetId: SPL_SETID }),
      ingredients: [],
      labelSections: { sections: [], truncated: false },
    }));

    harness = await start(createRegistry([adapter], []));
    const result = await harness.client.callTool({
      name: "drugdata_get_product",
      arguments: {
        source: "dailymed",
        id: SPL_SETID,
        include_label_sections: true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("## Label sections (0)");
    expect(textOf(result)).toContain("No usage sections were found");
  });
});

describe("product adapter lookups", () => {
  it("rejects an id that is neither an openFDA NDC nor a set id", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(() => {
        throw new Error("no request expected");
      }),
    );

    await expect(adapter.getProduct?.("not-an-id", {})).rejects.toThrow(
      /Expected an openFDA product NDC or SPL set id/,
    );
  });

  it("reports an openFDA zero match as a not-found failure", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(() =>
        jsonResponse(fixture("openfda/ndc-zero-match.json"), { status: 404 }),
      ),
    );

    await expect(adapter.getProduct?.("00000-0000", {})).rejects.toThrow(
      /No openFDA product record/,
    );
  });

  it("rewords a failing openFDA label lookup", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) => {
        if (url.pathname === "/drug/ndc.json") {
          return jsonResponse(fixture("openfda/ndc-zero-match.json"), {
            status: 404,
          });
        }
        return new Response(null, { status: 503 });
      }),
    );

    await expect(
      adapter.getProduct?.("bbbbbbbb-1111-4111-8111-111111111111", {}),
    ).rejects.toThrow(
      /The openFDA label lookup failed: openFDA returned HTTP 503/,
    );
  });

  it("keeps directory actives when no SPL set id can be found", async () => {
    const ndc = fixture<{
      results: Array<{ openfda?: { spl_set_id?: string[] } }>;
    }>("openfda/ndc-brand-lipitor.json");
    const first = ndc.results[0];
    if (first === undefined) throw new Error("fixture has no first record");
    first.openfda = {};
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) => {
        if (url.pathname === "/drug/ndc.json") {
          return jsonResponse(ndc);
        }
        if (url.pathname === "/drug/label.json") {
          return jsonResponse(fixture("openfda/ndc-zero-match.json"), {
            status: 404,
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const record = (await adapter.getProduct?.("58151-155", {
      includeLabelIngredients: true,
    })) as {
      ingredients: IngredientRef[];
      labelIngredientsIncluded: boolean;
    };
    expect(record.labelIngredientsIncluded).toBe(false);
    expect(record.ingredients).toHaveLength(1);
    expect(record.ingredients[0]?.identifiers).toEqual({});
  });

  it("surfaces a bridge failure from the openFDA SPL path", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) =>
        url.pathname === "/drug/ndc.json"
          ? jsonResponse(fixture("openfda/ndc-brand-lipitor.json"))
          : new Response(null, { status: 404 }),
      ),
      {
        getSplXml: async () => {
          throw new Error("DailyMed SPL is unavailable");
        },
      },
    );

    await expect(
      adapter.getProduct?.("58151-155", { includeLabelIngredients: true }),
    ).rejects.toThrow(/DailyMed SPL is unavailable/);
  });

  it("rejects an unusable NLM product id", async () => {
    const adapter = createNlmAdapter(nlmClient(() => new Response(null)));

    await expect(adapter.getProduct?.("not-an-id", {})).rejects.toThrow(
      /Expected a DailyMed SPL set id or an RxNorm rxcui/,
    );
  });

  it("reports a missing RxNorm concept as not found", async () => {
    const adapter = createNlmAdapter(
      nlmClient((url) =>
        url.pathname.endsWith("/properties.json")
          ? jsonResponse({})
          : new Response(null, { status: 404 }),
      ),
    );

    await expect(adapter.getProduct?.("999999", {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rewords a failing DailyMed SPL request", async () => {
    const adapter = createNlmAdapter(
      nlmClient(() => new Response(null, { status: 503 })),
    );

    await expect(adapter.getProduct?.(SPL_SETID, {})).rejects.toThrow(
      /The DailyMed product lookup failed: DailyMed returned HTTP 503/,
    );
  });

  it("parses SPL ingredients for an openFDA label lookup", async () => {
    const xml = textFixture("nlm/dailymed-spl-a1e07d5c.xml");
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) => {
        if (url.pathname === "/drug/ndc.json") {
          return jsonResponse(fixture("openfda/ndc-zero-match.json"), {
            status: 404,
          });
        }
        return jsonResponse(fixture("openfda/label-setid-atorvastatin.json"));
      }),
      { getSplXml: async () => xml },
    );

    const record = (await adapter.getProduct?.(
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
      { includeLabelIngredients: true },
    )) as {
      ingredients: IngredientRef[];
      labelIngredientsIncluded: boolean;
    };
    expect(record.labelIngredientsIncluded).toBe(true);
    expect(record.ingredients.map((item) => item.name)).toEqual([
      "Silver",
      "Water",
    ]);
  });

  it("resolves a set id through the NDC directory and credits the label", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) =>
        url.pathname === "/drug/ndc.json"
          ? jsonResponse(fixture("openfda/ndc-brand-lipitor.json"))
          : new Response(null, { status: 404 }),
      ),
    );

    const record = (await adapter.getProduct?.(
      "a60cc18b-0631-4cf0-b021-9f52224ece65",
      {},
    )) as { product: ProductRef; ingredients: IngredientRef[] };
    expect(record.product.source).toMatchObject({
      database: "openFDA",
      id: "a60cc18b-0631-4cf0-b021-9f52224ece65",
      url: expect.stringContaining("/drug/label.json"),
    });
    expect(record.product.name).toBe("atorvastatin calcium");
    expect(record.product.brand).toBe("Lipitor");
    expect(record.ingredients).toHaveLength(1);
  });

  it("reports a set id with no NDC or label record as not found", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(() =>
        jsonResponse(fixture("openfda/ndc-zero-match.json"), { status: 404 }),
      ),
    );

    await expect(
      adapter.getProduct?.("bbbbbbbb-1111-4111-8111-111111111111", {}),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rewords a failing openFDA NDC product lookup", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(() => new Response(null, { status: 503 })),
    );

    await expect(adapter.getProduct?.("00000-0000", {})).rejects.toThrow(
      /The openFDA product lookup failed: openFDA returned HTTP 503/,
    );
  });

  it("falls back to the label endpoint when an NDC hit has no identity", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) =>
        url.pathname === "/drug/ndc.json"
          ? jsonResponse({ results: [{}] })
          : jsonResponse({
              results: [{ openfda: {} }],
            }),
      ),
    );

    const record = (await adapter.getProduct?.(
      "cccccccc-1111-4111-8111-111111111111",
      {},
    )) as { product: ProductRef; summary?: string };
    expect(record.product.name).toBe(
      "openFDA label cccccccc-1111-4111-8111-111111111111",
    );
    expect(record.product.identifiers).toEqual({
      splSetId: "cccccccc-1111-4111-8111-111111111111",
    });
    expect(record.summary).toBeUndefined();
  });

  it("keeps directory actives with no SPL ingredients and blank rows", async () => {
    const ndc = fixture<{
      results: Array<Record<string, unknown>>;
    }>("openfda/ndc-brand-lipitor.json");
    const first = ndc.results[0];
    if (first === undefined) throw new Error("fixture has no first record");
    first.active_ingredients = [{}, { name: "ACTIVE THING" }];
    delete first.dosage_form;
    delete first.route;

    const adapter = createOpenFdaAdapter(
      openFdaClient((url) =>
        url.pathname === "/drug/ndc.json"
          ? jsonResponse(ndc)
          : new Response(null, { status: 404 }),
      ),
      { getSplXml: async () => "<document/>" },
    );

    const record = (await adapter.getProduct?.("58151-155", {
      includeLabelIngredients: true,
    })) as {
      ingredients: IngredientRef[];
      labelIngredientsIncluded: boolean;
      summary?: string;
    };
    expect(record.labelIngredientsIncluded).toBe(true);
    expect(record.ingredients).toEqual([
      expect.objectContaining({ name: "ACTIVE THING", role: "active" }),
    ]);
    expect(record.summary).toBeUndefined();
  });

  it("handles a directory record with no active ingredients", async () => {
    const ndc = fixture<{ results: Array<Record<string, unknown>> }>(
      "openfda/ndc-brand-lipitor.json",
    );
    const first = ndc.results[0];
    if (first === undefined) throw new Error("fixture has no first record");
    delete first.active_ingredients;

    const adapter = createOpenFdaAdapter(
      openFdaClient((url) =>
        url.pathname === "/drug/ndc.json"
          ? jsonResponse(ndc)
          : new Response(null, { status: 404 }),
      ),
      { getSplXml: async () => "<document/>" },
    );

    const record = (await adapter.getProduct?.("5815115577", {
      includeLabelIngredients: true,
    })) as { ingredients: IngredientRef[]; labelIngredientsIncluded: boolean };
    expect(record.labelIngredientsIncluded).toBe(true);
    expect(record.ingredients).toEqual([]);
  });

  it("reports an NDC record with no identity as not found", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(() => jsonResponse({ results: [{}] })),
    );

    await expect(adapter.getProduct?.("00000-0000", {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it("maps SPL roles, form, and identifiers for an openFDA product", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <component>
    <structuredBody>
      <component>
        <section>
          <subject>
            <manufacturedProduct>
              <manufacturedProduct>
                <name>TEST LABEL</name>
                <ingredient classCode="ADJV">
                  <ingredientSubstance><name>ADJUVANT</name></ingredientSubstance>
                </ingredient>
                <ingredient classCode="ACTI">
                  <quantity><numerator value="5" unit="mg"/></quantity>
                  <ingredientSubstance>
                    <code code="ABCDEFGHIJ" codeSystem="2.16.840.1.113883.4.9"/>
                    <formCode displayName="POWDER"/>
                    <name>ACTIVE THING</name>
                  </ingredientSubstance>
                </ingredient>
              </manufacturedProduct>
            </manufacturedProduct>
          </subject>
        </section>
      </component>
    </structuredBody>
  </component>
</document>`;
    const adapter = createOpenFdaAdapter(
      openFdaClient((url) =>
        url.pathname === "/drug/ndc.json"
          ? jsonResponse(fixture("openfda/ndc-brand-lipitor.json"))
          : new Response(null, { status: 404 }),
      ),
      { getSplXml: async () => xml },
    );

    const record = (await adapter.getProduct?.("58151-155", {
      includeLabelIngredients: true,
    })) as { ingredients: IngredientRef[] };
    expect(record.ingredients[0]).toMatchObject({
      name: "Adjuvant",
      identifiers: {},
    });
    expect(record.ingredients[0]?.role).toBeUndefined();
    expect(record.ingredients[1]).toMatchObject({
      name: "Active Thing",
      role: "active",
      quantity: "5 mg",
      form: "POWDER",
      identifiers: { unii: "ABCDEFGHIJ" },
    });
  });

  it("reports a non-404 openFDA failure while searching the directory", async () => {
    const adapter = createOpenFdaAdapter(
      openFdaClient(() => new Response(null, { status: 503 })),
    );

    await expect(adapter.getProduct?.("58151-155", {})).rejects.toThrow(
      /The openFDA product lookup failed/,
    );
  });

  it("rewords RxNorm concept and NDC failures", async () => {
    const conceptFailure = createNlmAdapter(
      nlmClient(() => new Response(null, { status: 503 })),
    );
    await expect(conceptFailure.getProduct?.("617314", {})).rejects.toThrow(
      /The RxNorm product lookup failed: RxNorm returned HTTP 503/,
    );

    const ndcFailure = createNlmAdapter(
      nlmClient((url) =>
        url.pathname.endsWith("/properties.json")
          ? jsonResponse(fixture("nlm/rxnorm-concept-617314.json"))
          : new Response(null, { status: 503 }),
      ),
    );
    await expect(ndcFailure.getProduct?.("617314", {})).rejects.toThrow(
      /The RxNorm product lookup failed: RxNorm returned HTTP 503/,
    );
  });

  it("maps an RxNorm concept product with its NDCs", async () => {
    const adapter = createNlmAdapter(
      nlmClient((url) => {
        if (url.pathname.endsWith("/properties.json")) {
          return jsonResponse(fixture("nlm/rxnorm-concept-617314.json"));
        }
        if (url.pathname.endsWith("/ndcs.json")) {
          return jsonResponse(fixture("nlm/rxnorm-ndcs-617314.json"));
        }
        return new Response(null, { status: 404 });
      }),
    );

    const record = (await adapter.getProduct?.("617314", {})) as {
      product: ProductRef;
      summary?: string;
      labelIngredientsIncluded: boolean;
    };
    expect(record.product).toMatchObject({
      name: "atorvastatin 10 MG Oral Tablet [Lipitor]",
      identifiers: {
        rxcui: ["617314"],
        ndc: expect.arrayContaining(["58151015577"]),
      },
      source: { database: "RxNorm", id: "617314" },
    });
    expect(record.summary).toBe("RxNorm term type SBD");
    expect(record.labelIngredientsIncluded).toBe(false);
  });

  it("omits NDCs from an RxNorm concept with no crosswalk", async () => {
    const adapter = createNlmAdapter(
      nlmClient((url) =>
        url.pathname.endsWith("/properties.json")
          ? jsonResponse(fixture("nlm/rxnorm-concept-617314.json"))
          : jsonResponse({ ndcGroup: {} }),
      ),
    );

    const record = (await adapter.getProduct?.("617314", {})) as {
      product: ProductRef;
    };
    expect(record.product.identifiers).toEqual({ rxcui: ["617314"] });
  });

  it("maps unrecognized and sparse SPL ingredient rows for DailyMed", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <setId root="${SPL_SETID}"/>
  <component>
    <structuredBody>
      <component>
        <section>
          <subject>
            <manufacturedProduct>
              <manufacturedProduct>
                <name>SPARSE LABEL</name>
                <ingredient classCode="ADJV">
                  <ingredientSubstance><name>ADJUVANT</name></ingredientSubstance>
                </ingredient>
                <ingredient classCode="ACTI">
                  <ingredientSubstance>
                    <formCode displayName="POWDER"/>
                    <name>ACTIVE THING</name>
                  </ingredientSubstance>
                </ingredient>
              </manufacturedProduct>
            </manufacturedProduct>
          </subject>
        </section>
      </component>
    </structuredBody>
  </component>
</document>`;
    const adapter = createNlmAdapter(nlmClient(() => new Response(xml)));

    const record = (await adapter.getProduct?.(SPL_SETID, {})) as {
      ingredients: IngredientRef[];
    };
    expect(record.ingredients[0]).toMatchObject({
      name: "Adjuvant",
      identifiers: {},
    });
    expect(record.ingredients[0]?.role).toBeUndefined();
    expect(record.ingredients[1]).toMatchObject({
      name: "Active Thing",
      role: "active",
      form: "POWDER",
      identifiers: {},
    });
  });

  it("builds a minimal DailyMed product when the SPL has no metadata", async () => {
    const adapter = createNlmAdapter(
      nlmClient(
        () => new Response(`<document><setId root="${SPL_SETID}"/></document>`),
      ),
    );

    const record = (await adapter.getProduct?.(SPL_SETID, {})) as {
      product: ProductRef;
      ingredients: IngredientRef[];
      summary?: string;
      labelIngredientsIncluded: boolean;
    };
    expect(record.product.name).toBe(SPL_SETID);
    expect(record.product.identifiers).toEqual({ splSetId: SPL_SETID });
    expect(record.ingredients).toEqual([]);
    expect(record.summary).toBeUndefined();
    expect(record.labelIngredientsIncluded).toBe(true);
  });
});

describe("productDetailNextSteps", () => {
  const subject = (
    product: ProductRef,
    ingredients: ProductDetailSubject["ingredients"] = [],
  ): ProductDetailSubject => ({ product, ingredients });

  it("suggests resolving the first UNII, then cross-source lookups", () => {
    const steps = productDetailNextSteps(
      subject(
        productRef("openFDA", "Aspirin", {
          ndc: ["00000000001"],
          splSetId: SPL_SETID,
          rxcui: ["1191"],
        }),
        [
          ingredientRef("Aspirin", {
            role: "active",
            identifiers: { unii: "R16CO5Y76E" },
          }),
          ingredientRef("Cellulose", {
            role: "inactive",
            identifiers: { unii: "OP96U8655W" },
          }),
        ],
      ),
    );

    expect(steps.map((step) => step.tool)).toEqual([
      "drugdata_resolve_identifiers",
      "drugdata_get_product",
      "drugdata_get_ingredient",
    ]);
    expect(steps[0]?.input).toEqual({ unii: "R16CO5Y76E" });
    expect(steps[1]?.input).toEqual({
      source: "dailymed",
      id: SPL_SETID,
    });
    expect(steps[1]?.why).toContain("include_label_sections");
    expect(steps[2]?.input).toEqual({ source: "nlm", id: "1191" });
    for (const step of steps) expect(step.why.length).toBeGreaterThan(0);
  });

  it("falls back to NDC resolution, CAS search, and slug lookups", () => {
    const ndcSteps = productDetailNextSteps(
      subject(
        productRef("DailyMed", "Label", {
          ndc: ["00000000001"],
          splSetId: SPL_SETID,
        }),
        [ingredientRef("Unknown", { role: "active" })],
      ),
    );
    expect(ndcSteps).toEqual([
      expect.objectContaining({
        tool: "drugdata_resolve_identifiers",
        input: { ndc: "00000000001" },
      }),
    ]);

    const casSteps = productDetailNextSteps(
      subject(productRef("DSLD", "Supplement", { dsldId: 7 }), [
        ingredientRef("Thing", {
          role: "active",
          identifiers: { cas: ["50-00-0"] },
        }),
      ]),
    );
    expect(casSteps).toEqual([
      expect.objectContaining({
        tool: "drugdata_search_ingredients",
        input: { type: "cas", query: "50-00-0" },
      }),
    ]);

    const slugSteps = productDetailNextSteps(
      subject(productRef("INKEEDecoder", "Cosmetic", { slug: "product" }), [
        ingredientRef("Niacinamide", {
          identifiers: { slug: "niacinamide" },
          source: {
            database: "INKEEDecoder",
            id: "niacinamide",
            url: "https://inkeedecoder.com/ingredients/niacinamide",
            retrievedAt: RETRIEVED_AT,
          },
        }),
      ]),
    );
    expect(slugSteps).toEqual([
      expect.objectContaining({
        tool: "drugdata_get_ingredient",
        input: { source: "inkeedecoder", id: "niacinamide" },
      }),
    ]);
  });

  it("returns no steps when there is nothing to follow up on", () => {
    expect(
      productDetailNextSteps(
        subject(productRef("DSLD", "Bare supplement", { dsldId: 1 }), [
          ingredientRef("No source", { role: "active" }),
        ]),
      ),
    ).toEqual([]);
  });

  it("caps the list at three steps", () => {
    const steps = productDetailNextSteps(
      subject(
        productRef("DailyMed", "Label", {
          ndc: ["00000000001"],
          splSetId: SPL_SETID,
          rxcui: ["1191"],
        }),
        [
          ingredientRef("One", {
            role: "active",
            identifiers: { unii: "ABCDEFGHIJ", cas: ["50-00-0"] },
            source: {
              database: "INKEEDecoder",
              id: "one",
              url: "https://example.test/one",
              retrievedAt: RETRIEVED_AT,
            },
          }),
          ingredientRef("Two", {
            role: "active",
            identifiers: { unii: "ABCDEFGHIJ" },
          }),
        ],
      ),
    );

    expect(steps).toHaveLength(3);
    expect(new Set(steps.map((step) => JSON.stringify(step.input))).size).toBe(
      3,
    );
  });
});
