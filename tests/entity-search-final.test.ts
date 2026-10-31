import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { searchNextSteps } from "../src/lib/next-steps.js";
import {
  type IngredientRef,
  resolveIdentifiersResultSchema,
} from "../src/lib/schemas.js";
import { createServer } from "../src/server.js";
import type { IdentityResolver } from "../src/sources/identity/chain.js";
import { createRegistry } from "../src/sources/registry.js";
import { createSearchCoordinator } from "../src/sources/search/coordinator.js";
import {
  clusterIngredientGroups,
  type EntitySearchResult,
  ingredientResolveInput,
  recordIdentityKeys,
} from "../src/sources/search/entities.js";
import {
  boundEntitySearch,
  entityJsonBlocks,
  renderEntitySearch,
} from "../src/tools/entity-search-support.js";
import { jsonTextBlocks } from "../src/tools/search-support.js";
import { createTestClient, textOf } from "./helpers.js";

const record: IngredientRef = {
  name: "aspirin",
  identifiers: { cid: [2244] },
  source: {
    database: "PubChem",
    id: "2244",
    url: "https://pubchem.ncbi.nlm.nih.gov/compound/2244",
    retrievedAt: "2026-10-31T00:00:00.000Z",
  },
};
const group = {
  source: "PubChem" as const,
  items: [record],
  page: 1,
  hasMore: false,
};
const emptyResolver: IdentityResolver = {
  resolve: async () => ({
    kind: "ingredient",
    graph: { subject: {}, identifiers: {}, links: [], candidates: [] },
  }),
};
const registry = createRegistry(
  [
    {
      id: "nlm",
      databases: ["PubChem"],
      ingredientSearchTypes: ["name"],
      productSearchTypes: [],
      productCategories: [],
      searchIngredients: async () => [group],
    },
  ],
  [],
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetConfig();
});

it("rejects malformed strong keys without grouping records by them", () => {
  expect(
    recordIdentityKeys(
      {
        ...record,
        identifiers: {
          cid: [-1, Number.MAX_SAFE_INTEGER + 1],
          rxcui: ["0", "abc"],
          cas: ["not-a-cas"],
        },
      },
      "ingredient",
    ),
  ).toEqual([]);
  expect(
    recordIdentityKeys({ ...record, identifiers: { upc: ["bad"] } }, "product"),
  ).toEqual([]);
  const entities = clusterIngredientGroups([
    {
      ...group,
      items: [
        { ...record, identifiers: { cas: ["50-78-2"] } },
        {
          ...record,
          name: " ",
          identifiers: {},
          source: { ...record.source, id: "empty" },
        },
      ],
    },
  ]);
  const [casEntity, blankEntity] = entities;
  assert(casEntity && blankEntity);
  expect(ingredientResolveInput(casEntity)).toEqual({ cas: "50-78-2" });
  expect(ingredientResolveInput(blankEntity)).toBeUndefined();
});
it("keeps legacy JSON blocks parseable and suggests the PubChem record", () => {
  const context = { kind: "ingredient" as const, hasCategory: false };
  const [block] = jsonTextBlocks({ groups: [group] }, context);
  assert(block);
  expect(JSON.parse(block.text)).toEqual({ groups: [group] });
  expect(
    jsonTextBlocks({ groups: [{ ...group, items: [] }] }, context),
  ).toHaveLength(2);
  expect(searchNextSteps("name", [group])).toContainEqual(
    expect.objectContaining({
      tool: "drugdata_get_ingredient",
      input: { source: "pubchem", id: "2244" },
    }),
  );
});
it("renders an empty timed-out search as unavailable, not a successful miss", () => {
  const result: EntitySearchResult<IngredientRef> = {
    query: "aspirin",
    type: "name",
    page: 1,
    entities: [],
    sources: [
      {
        source: "PubChem",
        status: "timeout",
        page: 1,
        hasMore: false,
        resultCount: 0,
      },
    ],
    coverage: {
      entities: 0,
      records: 0,
      resolutionAttempted: 0,
      resolutionCompleted: 0,
      resolutionCapped: false,
    },
    partial: true,
    nextSteps: [],
  };
  const context = { kind: "ingredient" as const, hasCategory: false };
  expect(entityJsonBlocks(result, context, false)).toHaveLength(2);
  expect(
    renderEntitySearch(result, context, false, (value) => value.name),
  ).toContain("Search deadline exceeded.");
  expect(
    boundEntitySearch({
      ...result,
      sources: result.sources.map((source) => ({
        ...source,
        status: "error",
        error: "x".repeat(30000),
      })),
    }).value.sources[0]?.error,
  ).toHaveLength(500);
});
for (const name of [
  "drugdata_search_ingredients",
  "drugdata_search_products",
]) {
  for (const injectedResolver of [false, true]) {
    it(`${name} reports invalid configuration with resolver injected=${injectedResolver}`, async () => {
      vi.stubEnv("DRUGDATA_SEARCH_TIMEOUT_MS", "0");
      resetConfig();
      const harness = await createTestClient(() =>
        createServer({
          registry,
          ...(injectedResolver ? { resolver: emptyResolver } : {}),
        }),
      );
      try {
        const result = await harness.client.callTool({
          name,
          arguments: { query: "aspirin", type: "name" },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Invalid environment configuration");
      } finally {
        await harness.close();
      }
    });
  }
}
it("accepts a CID through the real tool and returns its source lookup", async () => {
  const resolver: IdentityResolver = {
    resolve: async (input) => ({
      kind: "ingredient",
      graph: {
        subject: { name: "aspirin" },
        identifiers: { cid: [Number(input.cid)] },
        links: [{ ...record.source, matchedVia: "cid", confidence: "direct" }],
        candidates: [],
      },
    }),
  };
  const harness = await createTestClient(() => createServer({ resolver }));
  try {
    const result = await harness.client.callTool({
      name: "drugdata_resolve_identifiers",
      arguments: { cid: "2244" },
    });
    expect(result.isError).not.toBe(true);
    expect(
      resolveIdentifiersResultSchema.parse(result.structuredContent),
    ).toHaveProperty("graph.identifiers.cid", [2244]);
    expect(JSON.stringify(result.structuredContent)).toContain(
      '"source":"pubchem","id":"2244"',
    );
  } finally {
    await harness.close();
  }
});
it("does not treat product ingredients as ingredient-graph identity patches", async () => {
  const result = await createSearchCoordinator({
    registry,
    timeoutMs: 45000,
    resolver: {
      resolve: async () => ({
        kind: "product",
        links: [],
        candidates: [],
        ingredients: [{ ...record, identifiers: { unii: "R16CO5Y76E" } }],
      }),
    },
  }).searchIngredients({ type: "name", query: "aspirin", page: 1 });
  expect(result.entities[0]?.identifiers).toEqual({ cid: [2244] });
});
it("ignores a resolution that fulfills after the search deadline", async () => {
  vi.useFakeTimers();
  let finish!: (
    value: Awaited<ReturnType<IdentityResolver["resolve"]>>,
  ) => void;
  const pending = createSearchCoordinator({
    registry,
    timeoutMs: 10,
    resolver: {
      resolve: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  }).searchIngredients({ type: "name", query: "aspirin", page: 1 });
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  const snapshot = JSON.stringify(result);
  finish(await emptyResolver.resolve({ cid: "2244" }));
  await vi.advanceTimersByTimeAsync(1);
  expect(result.coverage.resolutionCompleted).toBe(0);
  expect(JSON.stringify(result)).toBe(snapshot);
});
