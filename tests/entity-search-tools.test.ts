import { afterEach, expect, it } from "vitest";
import {
  type IngredientRef,
  ingredientEntitySearchResultSchema,
} from "../src/lib/schemas.js";
import { createServer } from "../src/server.js";
import type { IdentityResolver } from "../src/sources/identity/chain.js";
import { createRegistry } from "../src/sources/registry.js";
import { createTestClient, type TestHarness, textOf } from "./helpers.js";

let harness: TestHarness | undefined;
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
