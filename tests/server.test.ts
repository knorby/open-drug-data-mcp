import { readFileSync } from "node:fs";
import {
  CosingClient,
  type FetchLike as CosingFetch,
} from "@knorby/eu-cosing-client";
import { createInkeedecoderClient } from "@knorby/inkeedecoder-client";
import {
  DsldClient,
  type FetchLike as DsldFetch,
} from "@knorby/nih-dsld-client";
import { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import {
  OpenFdaClient,
  type FetchLike as OpenFdaFetch,
} from "@knorby/openfda-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig, SOURCE_IDS, SOURCE_LABELS } from "../src/config.js";
import { DISCLAIMER, SERVER_NAME, SERVER_VERSION } from "../src/constants.js";
import { createServer } from "../src/server.js";
import { createCosingAdapter } from "../src/sources/cosing.js";
import { createDsldAdapter } from "../src/sources/dsld.js";
import type { IdentityResolver } from "../src/sources/identity/chain.js";
import { createInkeedecoderAdapter } from "../src/sources/inkeedecoder.js";
import { createReferenceSearcher } from "../src/sources/nlm-references/index.js";
import { createOpenFdaAdapter } from "../src/sources/openfda.js";
import { createRegistry } from "../src/sources/registry.js";
import type { Registry, SourceAdapter } from "../src/sources/types.js";
import {
  createTestClient,
  jsonResponse,
  type TestHarness,
  textOf,
} from "./helpers.js";

/**
 * Server assembly: the primitives a host discovers before any tool call.
 *
 * These tests drive a real MCP client against the full `createServer()` wiring.
 * Two things are pinned beyond the obvious list calls: the tool order (the
 * 2026-07-28 spec's SHOULD, so a client's cache stays stable) and the sourcing
 * policy at the outermost boundary — every tool is called, serialized, and
 * scanned for a package name that must never reach a model.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url);
const RETRIEVED_AT = "2026-10-22T00:00:00.000Z";
const SPL_SETID = "a1e07d5c-2056-46f3-8737-f03ed0b4bae8";

const TOOL_ORDER = [
  "drugdata_ping",
  "drugdata_search_products",
  "drugdata_search_ingredients",
  "drugdata_get_product",
  "drugdata_get_ingredient",
  "drugdata_resolve_identifiers",
  "drugdata_search_references",
] as const;

const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;
}

function textFixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

/**
 * The adapters' injectable fetch, routed by upstream host to captured
 * fixtures. One handler serves all four real adapters in the sweep.
 */
function sweepFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    switch (url.hostname) {
      case "api.fda.gov":
        if (url.pathname === "/drug/ndc.json") {
          return jsonResponse(fixture("openfda/ndc-brand-lipitor.json"));
        }
        if (url.pathname === "/other/unii.json") {
          return jsonResponse(fixture("openfda/unii-crosswalk-glycerin.json"));
        }
        if (url.pathname === "/other/substance.json") {
          return jsonResponse(fixture("openfda/substance-unii-glycerin.json"));
        }
        break;
      case "api.ods.od.nih.gov":
        if (url.pathname.endsWith("/v9/search-filter")) {
          return jsonResponse(fixture("dsld/search-labels-vitamin.json"));
        }
        break;
      case "webgate.ec.europa.eu":
        return jsonResponse(fixture("cosing/ingredient-text-niacinamide.json"));
      case "inkeedecoder.com":
        if (url.pathname === "/search") {
          return html(textFixture("inkeedecoder/search-niacinamide.html"));
        }
        break;
      case "eutils.ncbi.nlm.nih.gov":
        if (url.pathname === "/entrez/eutils/esearch.fcgi") {
          return jsonResponse({
            esearchresult: { idlist: ["36758480"], count: "1", retstart: "0" },
          });
        }
        if (url.pathname === "/entrez/eutils/esummary.fcgi") {
          return jsonResponse({
            result: {
              uids: ["36758480"],
              "36758480": {
                uid: "36758480",
                title: "Aspirin use and outcomes",
                pubdate: "2023 Feb",
              },
            },
          });
        }
        break;
      default:
        break;
    }

    throw new Error(`unexpected sweep request: ${url.hostname}${url.pathname}`);
  }) as unknown as typeof fetch;
}

/**
 * An adapter that fails the way a broken source module might: its rejection
 * text carries a package name. Boundaries author model-facing errors — the
 * registry and tool layers route it through `toUserMessage`, which logs the
 * raw text to stderr and returns generic actionable text — and this adapter
 * also owns the DailyMed/RxNorm lookups so the sweep exercises the lookup
 * error path as well as the search fan-out.
 */
function rejectingAdapter(): SourceAdapter {
  const reject = () => {
    throw new Error("The @knorby/example-client request failed.");
  };
  return {
    id: "rejecting",
    databases: ["DailyMed", "RxNorm"],
    productSearchTypes: ["name"],
    ingredientSearchTypes: ["name"],
    productCategories: ["medication"],
    searchProducts: reject,
    searchIngredients: reject,
    getProduct: reject,
    getIngredient: reject,
  };
}

/** A registry of real adapters over captured fixtures plus the rejecting one. */
function sweepRegistry(): Registry {
  const fetch = sweepFetch();
  return createRegistry(
    [
      createOpenFdaAdapter(
        new OpenFdaClient({
          fetch: fetch as unknown as OpenFdaFetch,
          timeoutMs: 5_000,
        }),
      ),
      createDsldAdapter(
        new DsldClient({
          fetch: fetch as unknown as DsldFetch,
          timeoutMs: 5_000,
        }),
      ),
      createCosingAdapter(
        new CosingClient({
          fetch: fetch as unknown as CosingFetch,
          timeoutMs: 5_000,
        }),
      ),
      createInkeedecoderAdapter(
        createInkeedecoderClient({
          fetch,
          requestIntervalMs: 0,
          timeoutMs: 5_000,
        }),
      ),
      rejectingAdapter(),
    ],
    [],
  );
}

/** A resolver with the graph shape a real chain returns, for the sweep. */
function sweepResolver(): IdentityResolver {
  return {
    async resolve() {
      return {
        kind: "ingredient",
        graph: {
          subject: { name: "Glycerin" },
          identifiers: { unii: "PDC6A3C0OX", cas: ["56-81-5"] },
          links: [
            {
              database: "openFDA",
              id: "PDC6A3C0OX",
              url: "https://api.fda.gov/drug/substance.json?search=unii:PDC6A3C0OX",
              matchedVia: "unii",
              confidence: "direct",
            },
          ],
          candidates: [
            {
              database: "CosIng",
              matchedVia: "name",
              reason: "name-match",
              options: [
                {
                  name: "Glycerin",
                  identifiers: { cas: ["56-81-5"] },
                  source: {
                    database: "CosIng",
                    id: "12345",
                    url: "https://ec.europa.eu/growth/tools-databases/cosing/details/12345",
                    retrievedAt: RETRIEVED_AT,
                  },
                },
              ],
            },
          ],
        },
      };
    },
  };
}

/** Connects a client to the full server, optionally with test dependencies. */
function connect(
  deps: Parameters<typeof createServer>[0] = {},
): Promise<TestHarness> {
  return createTestClient(() => createServer(deps));
}

describe("server assembly", () => {
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
  });

  it("exposes exactly the seven drugdata tools in the fixed order", async () => {
    harness = await connect();

    const { tools } = await harness.client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_ORDER]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(tool.annotations?.openWorldHint).toBeTypeOf("boolean");
    }
  });

  it("lists tools in the same order on every call", async () => {
    harness = await connect();

    const first = await harness.client.listTools();
    const second = await harness.client.listTools();

    expect(first.tools.map((tool) => tool.name)).toEqual(
      second.tools.map((tool) => tool.name),
    );
  });

  it("hands the host instructions for the search, resolve, and fetch loop", async () => {
    harness = await connect();

    const instructions =
      harness.client.getInstructions() ??
      harness.client.getDiscoverResult()?.instructions;

    expect(instructions).toBeTypeOf("string");
    for (const expected of [
      "search",
      "resolve",
      "get",
      "nextSteps",
      "free text",
      "brand",
      "category",
      "source+id",
      "selectively fetch",
      "PubChem",
      "cid",
      "partial",
      "timeout",
      "entities",
      "NDC",
      "UNII",
      "RxCUI",
      "CAS",
      "EC",
      "INCI",
      "setid",
      "structId",
      "links",
      "candidates",
      "page",
      "hasMore",
      "cite",
      "deep link",
      "only the brand",
      "only the ingredient",
      "Natrol",
      "melatonin",
      DISCLAIMER,
    ]) {
      expect(instructions).toContain(expected);
    }
    expect(instructions).not.toMatch(/@knorby|-client/i);
    expect(instructions).toContain("resolve_identities");
  });

  it("registers a research_drug prompt that threads the input and context", async () => {
    harness = await connect();

    const { prompts } = await harness.client.listPrompts();
    const prompt = prompts.find((entry) => entry.name === "research_drug");
    expect(prompt).toBeDefined();
    expect(prompt?.arguments).toEqual([
      expect.objectContaining({ name: "name_or_identifier", required: true }),
      expect.objectContaining({ name: "context" }),
    ]);

    const { messages } = await harness.client.getPrompt({
      name: "research_drug",
      arguments: {
        name_or_identifier: "atorvastatin",
        context: "Compare it with rosuvastatin.",
      },
    });
    const first = messages[0]?.content;
    const text = first?.type === "text" ? first.text : "";

    expect(text).toContain("atorvastatin");
    expect(text).toContain("Compare it with rosuvastatin.");
    expect(text).toContain("drugdata_search_products");
    expect(text).toContain("drugdata_resolve_identifiers");
    expect(text).toContain("drugdata_get_product");
    expect(text).toContain("links");
    expect(text).toContain("candidates");
    for (const expected of [
      "free text",
      "brand",
      "category",
      "source+id",
      "selectively fetch",
      "PubChem",
      "cid",
      "partial",
      "timeout",
      "entities",
      "only the brand",
      "only the ingredient",
      "Natrol",
      "melatonin",
    ])
      expect(text).toContain(expected);
    expect(text).toContain(DISCLAIMER);
    expect(text).not.toMatch(/@knorby|-client/i);

    const plain = await harness.client.getPrompt({
      name: "research_drug",
      arguments: { name_or_identifier: "aspirin" },
    });
    const plainContent = plain.messages[0]?.content;
    const plainText = plainContent?.type === "text" ? plainContent.text : "";
    expect(plainText).toContain("aspirin");
    expect(plainText).not.toContain("User context:");
  });

  it("documents source+id lookups and the PubChem CID key", async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    for (const name of ["drugdata_get_product", "drugdata_get_ingredient"]) {
      const tool = tools.find((tool) => tool.name === name);
      expect(tool?.description).toContain("source+id");
      expect(tool?.description).toContain("selectively fetch");
    }
    expect(
      JSON.stringify(
        tools.find((tool) => tool.name === "drugdata_get_ingredient")
          ?.inputSchema.properties?.id,
      ),
    ).toContain("PubChem CID");
    const product = tools.find((tool) => tool.name === "drugdata_get_product");
    expect(product?.description).toContain("when supplied by the source");
    expect(product?.description).toContain("include_label_ingredients: true");
    expect(product?.description).toContain("drugdata_resolve_identifiers");
    const search = tools.find(
      (tool) => tool.name === "drugdata_search_products",
    );
    for (const term of [
      "only the brand",
      "only the ingredient",
      "Natrol",
      "melatonin",
    ]) {
      expect(search?.description).toContain(term);
    }
  });

  it("serves server://info with the disclaimer and enabled sources", async () => {
    harness = await connect();

    const info = await readInfo(harness);

    expect(info.name).toBe(SERVER_NAME);
    expect(info.version).toBe(SERVER_VERSION);
    expect(info.transport).toBe("stdio");
    expect(info.disclaimer).toBe(DISCLAIMER);
    expect(info.configError).toBeNull();
    expect(info.searchTimeoutMs).toBe(45000);
    expect(info.sources).toEqual(
      SOURCE_IDS.map((id) => ({
        id,
        database: SOURCE_LABELS[id],
        enabled: true,
      })),
    );
    expect(JSON.stringify(info)).not.toMatch(/@knorby|-client/i);
  });

  it("reports a broken configuration in server://info instead of hiding it", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "not-a-source";
    resetConfig();
    harness = await connect();

    const info = await readInfo(harness);

    expect(info.sources).toEqual([]);
    expect(info.configError).toContain("Invalid environment configuration");
    expect(info.disclaimer).toBe(DISCLAIMER);
  });

  it("still lists tools when every source is disabled and ping reports them", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = SOURCE_IDS.join(",");
    resetConfig();
    harness = await connect();

    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_ORDER]);

    const result = await harness.client.callTool({
      name: "drugdata_ping",
      arguments: {},
    });
    const output = result.structuredContent as {
      sources: { enabled: boolean }[];
    };
    expect(output.sources).toHaveLength(SOURCE_IDS.length);
    expect(output.sources.every((source) => !source.enabled)).toBe(true);
    expect(textOf(result)).toContain("0 of 6 sources enabled");
  });

  it("never surfaces a package name from any tool", async () => {
    harness = await connect({
      registry: sweepRegistry(),
      resolver: sweepResolver(),
      referenceSearch: createReferenceSearcher({
        client: new NlmDrugsClient({
          fetch: sweepFetch() as unknown as typeof fetch,
        }),
      }),
    });

    const calls = [
      harness.client.callTool({ name: "drugdata_ping", arguments: {} }),
      harness.client.callTool({
        name: "drugdata_search_products",
        arguments: { type: "name", query: "vitamin" },
      }),
      harness.client.callTool({
        name: "drugdata_search_ingredients",
        arguments: { type: "name", query: "niacinamide" },
      }),
      harness.client.callTool({
        name: "drugdata_get_product",
        arguments: { source: "openfda", id: "58151-155-77" },
      }),
      harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "openfda", id: "PDC6A3C0OX" },
      }),
      harness.client.callTool({
        name: "drugdata_resolve_identifiers",
        arguments: { unii: "PDC6A3C0OX" },
      }),
      // The rejecting adapter owns these two databases.
      harness.client.callTool({
        name: "drugdata_get_product",
        arguments: { source: "dailymed", id: SPL_SETID },
      }),
      harness.client.callTool({
        name: "drugdata_get_ingredient",
        arguments: { source: "nlm", id: "1191" },
      }),
      harness.client.callTool({
        name: "drugdata_search_references",
        arguments: { source: "pubmed", type: "name", query: "aspirin" },
      }),
    ];

    const results = await Promise.all(calls);
    for (const result of results) {
      expect(result.content.length).toBeGreaterThan(0);
    }

    interface Group {
      error?: string;
    }
    const productGroups = results[1]?.structuredContent as {
      sources: Group[];
    };
    const ingredientGroups = results[2]?.structuredContent as {
      sources: Group[];
    };
    expect(
      productGroups.sources.some((group) => group.error?.includes("upstream")),
    ).toBe(true);
    expect(
      ingredientGroups.sources.some((group) =>
        group.error?.includes("upstream"),
      ),
    ).toBe(true);
    expect(results[6]?.isError).toBe(true);
    expect(results[7]?.isError).toBe(true);

    const references = results[8]?.structuredContent as {
      groups: { items: unknown[] }[];
    };
    expect(references.groups[0]?.items).toHaveLength(1);

    const serialized = JSON.stringify(results);
    expect(serialized).not.toMatch(/@knorby/i);
    expect(serialized).not.toMatch(/-client\b/i);
    expect(serialized).not.toMatch(/"client"/i);
  });

  /**
   * Protocol posture: era handling belongs to the SDK.
   *
   * This inline snapshot records the SDK's actual `server/discover` answer.
   * The server registers no discover handler and performs no negotiation of
   * its own — @modelcontextprotocol/server owns both, defaulting to the
   * legacy 2025-11-25 exchange while answering the modern probe. If an SDK
   * upgrade changes this shape, the snapshot changes and must be reviewed
   * deliberately: a silent era change would matter to every host.
   */
  it("records the SDK's server/discover behavior", async () => {
    harness = await connect();

    let observed:
      | {
          ok: true;
          supportedVersions: string[];
          capabilities: unknown;
          hasInstructions: boolean;
        }
      | { ok: false; code?: unknown; message: string };

    try {
      const discovered = await harness.client.discover();
      observed = {
        ok: true,
        supportedVersions: discovered.supportedVersions,
        capabilities: discovered.capabilities,
        hasInstructions: discovered.instructions?.includes(DISCLAIMER) ?? false,
      };
    } catch (error) {
      observed = {
        ok: false,
        code:
          typeof error === "object" && error !== null
            ? (error as { code?: unknown }).code
            : undefined,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    expect(observed).toMatchInlineSnapshot(`
      {
        "capabilities": {
          "prompts": {
            "listChanged": true,
          },
          "resources": {
            "listChanged": true,
          },
          "tools": {
            "listChanged": true,
          },
        },
        "hasInstructions": true,
        "ok": true,
        "supportedVersions": [
          "2026-07-28",
        ],
      }
    `);
  });
});

interface InfoDocument {
  searchTimeoutMs: number | null;
  name: string;
  version: string;
  transport: string;
  sources: { id: string; database: string; enabled: boolean }[];
  disclaimer: string;
  configError: string | null;
}

/** Reads and parses the `server://info` document. */
async function readInfo(harness: TestHarness): Promise<InfoDocument> {
  const result = await harness.client.readResource({ uri: "server://info" });
  const contents = result.contents as { text?: string }[];
  return JSON.parse(contents[0]?.text ?? "{}") as InfoDocument;
}
