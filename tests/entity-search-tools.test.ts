import { afterEach, expect, it } from "vitest";
import {
  type IngredientRef,
  ingredientEntitySearchResultSchema,
  productEntitySearchResultSchema,
} from "../src/lib/schemas.js";
import { createServer } from "../src/server.js";
import type { IdentityResolver } from "../src/sources/identity/chain.js";
import { createRegistry } from "../src/sources/registry.js";
import { createTestClient, type TestHarness, textOf } from "./helpers.js";

let harness: TestHarness | undefined;
it("joins product NDC/SPL/UPC evidence but not a shared RxCUI", async () => {
  const records = [
    ref("openFDA", "ndc", {}),
    ref("DailyMed", "spl", {}),
    ref("INKEEDecoder", "slug", {}),
    ref("openFDA", "other", {}),
    ref("RxNorm", "123", {}),
  ].map((record, index) => ({
    ...record,
    identifiers:
      [
        { ndc: ["0002-8215-01"], splSetId: "SPL" },
        { splSetId: "SPL", upc: ["123456789012"] },
        { upc: ["123456789012"] },
        { rxcui: ["123"] },
        { rxcui: ["123"] },
      ][index] ?? {},
  }));
  const registry = createRegistry(
    [
      {
        id: "openfda",
        databases: ["openFDA", "DailyMed", "INKEEDecoder", "RxNorm"],
        productSearchTypes: ["name"],
        ingredientSearchTypes: [],
        productCategories: [],
        searchProducts: async () =>
          records.map((record) => ({
            source: record.source.database,
            items: [record],
            page: 1,
            hasMore: false,
          })),
      },
    ],
    [],
  );
  // Aggregate duplicate source groups as a real adapter does.
  const adapterRegistry = {
    ...registry,
    searchProducts: async () => [
      {
        source: "openFDA" as const,
        items: [records[0], records[3]].filter(
          (record): record is NonNullable<typeof record> =>
            record !== undefined,
        ),
        page: 1,
        hasMore: false,
      },
      ...records
        .filter((record) => record.source.database !== "openFDA")
        .map((record) => ({
          source: record.source.database,
          items: [record],
          page: 1,
          hasMore: false,
        })),
    ],
  };
  const resolver: IdentityResolver = {
    resolve: async () => ({
      kind: "product",
      links: [],
      candidates: [],
      ingredients: [],
    }),
  };
  harness = await createTestClient(() =>
    createServer({ registry: adapterRegistry, resolver }),
  );
  const result = await harness.client.callTool({
    name: "drugdata_search_products",
    arguments: { type: "name", query: "product" },
  });
  const output = productEntitySearchResultSchema.parse(
    result.structuredContent,
  );
  expect(output.entities).toHaveLength(3);
  expect(output.entities[0]?.records).toHaveLength(3);
  expect(
    output.entities[0]?.nextSteps.filter(
      (step) => step.tool === "drugdata_get_product",
    ),
  ).toHaveLength(3);
  expect(output.entities[2]?.nextSteps[0]?.tool).toBe(
    "drugdata_get_ingredient",
  );
});
it("keeps a completed empty product page with more results non-partial", async () => {
  const registry = createRegistry(
    [
      {
        id: "dsld",
        databases: ["DSLD"],
        productSearchTypes: ["name"],
        ingredientSearchTypes: [],
        productCategories: ["supplement"],
        searchProducts: async () => [
          { source: "DSLD", items: [], page: 1, hasMore: true },
        ],
      },
    ],
    [],
  );
  harness = await createTestClient(() => createServer({ registry }));
  const result = await harness.client.callTool({
    name: "drugdata_search_products",
    arguments: { type: "name", query: "vitamin", category: "supplement" },
  });
  const output = productEntitySearchResultSchema.parse(
    result.structuredContent,
  );
  expect(output.partial).toBe(false);
  expect(output.sources[0]?.status).toBe("ok");
  expect(output.nextSteps[0]?.input.page).toBe(2);
  expect(textOf(result)).not.toContain("No source covers");
});
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});
const ref = (
  database: IngredientRef["source"]["database"],
  id: string,
  identifiers: IngredientRef["identifiers"],
): IngredientRef => ({
  name: "semaglutide",
  identifiers,
  source: {
    database,
    id,
    url: `https://example.test/${database}/${id}`,
    retrievedAt: "2026-10-31T00:00:00.000Z",
  },
});
it.each(["markdown", "json"])(
  "serves attributed ingredient entities with per-record lookups in %s",
  async (response_format) => {
    const records = [
      ref("openFDA", "53AXN4NNHX", { unii: "53AXN4NNHX" }),
      ref("RxNorm", "1991302", { unii: "53AXN4NNHX", rxcui: ["1991302"] }),
      ref("DrugCentral", "5267", {
        rxcui: ["1991302"],
        cid: [56843331],
        inchiKey: "ONE",
      }),
      ref("PubChem", "56843331", { cid: [56843331], inchiKey: "TWO" }),
    ];
    const registry = createRegistry(
      records.map((record, i) => ({
        id: String(i),
        databases: [record.source.database],
        productSearchTypes: [],
        ingredientSearchTypes: ["name"],
        productCategories: [],
        searchIngredients: async () => [
          {
            source: record.source.database,
            items: [record],
            page: 2,
            hasMore: true,
          },
        ],
      })),
      [],
    );
    const resolver: IdentityResolver = {
      resolve: async () => ({
        kind: "ingredient",
        graph: {
          subject: { name: "semaglutide" },
          identifiers: { unii: "53AXN4NNHX", cid: [56843331] },
          links: [
            {
              database: "PubChem",
              id: "56843331",
              url: records[3]?.source.url ?? "",
              confidence: "derived",
              matchedVia: "cid",
            },
          ],
          candidates: [],
        },
      }),
    };
    harness = await createTestClient(() =>
      createServer({ registry, resolver }),
    );
    const result = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: {
        type: "name",
        query: "semaglutide",
        resolve_identities: true,
        page: 2,
        response_format,
      },
    });
    expect(result.isError).toBeFalsy();
    const output = ingredientEntitySearchResultSchema.parse(
      result.structuredContent,
    );
    expect(output.entities).toHaveLength(1);
    const entity = output.entities[0];
    expect(entity?.records).toHaveLength(4);
    expect(entity?.links).toHaveLength(1);
    expect(entity?.identifiers.cid).toEqual([56843331]);
    expect(entity?.conflicts[0]?.field).toBe("inchiKey");
    expect(
      entity?.nextSteps.filter(
        (step) => step.tool === "drugdata_get_ingredient",
      ),
    ).toHaveLength(4);
    expect(output.nextSteps[0]?.input).toEqual({
      type: "name",
      query: "semaglutide",
      page: 3,
    });
    if (response_format === "json")
      expect(JSON.parse(textOf(result))).toEqual(output);
    else expect(textOf(result)).toContain("Conflict: inchiKey");
  },
);
it("bounds ingredient entities without corrupting ids, provenance or retained actions", async () => {
  const records = Array.from({ length: 300 }, (_, i) => ({
    ...ref("DrugCentral", String(i + 1), { structId: i + 1 }),
    name: `Ingredient ${i}`,
    summary: "Long description ".repeat(500),
  }));
  const registry = createRegistry(
    [
      {
        id: "drugcentral",
        databases: ["DrugCentral"],
        productSearchTypes: [],
        ingredientSearchTypes: ["name"],
        productCategories: [],
        searchIngredients: async () => [
          { source: "DrugCentral", items: records, page: 1, hasMore: false },
        ],
      },
    ],
    [],
  );
  const resolver: IdentityResolver = {
    resolve: async () => {
      throw new Error("offline");
    },
  };
  harness = await createTestClient(() => createServer({ registry, resolver }));
  const result = await harness.client.callTool({
    name: "drugdata_search_ingredients",
    arguments: { type: "name", query: "large", response_format: "json" },
  });
  const output = ingredientEntitySearchResultSchema.parse(
    result.structuredContent,
  );
  expect(JSON.stringify(output).length).toBeLessThanOrEqual(25000);
  expect(output.coverage.records).toBe(300);
  expect(output.entities.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.content)).toContain("Response truncated");
  for (const entity of output.entities)
    for (const step of entity.nextSteps.filter(
      (step) => step.tool === "drugdata_get_ingredient",
    ))
      expect(
        entity.records.some((record) => record.source.id === step.input.id),
      ).toBe(true);
});
