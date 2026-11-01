import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { CHARACTER_LIMIT } from "../src/constants.js";
import {
  ingredientEntitySearchResultSchema,
  type ProductRef,
  productEntitySearchResultSchema,
} from "../src/lib/schemas.js";
import { createServer } from "../src/server.js";
import { createRegistry } from "../src/sources/registry.js";
import {
  clusterProductGroups,
  type EntitySearchResult,
} from "../src/sources/search/entities.js";
import {
  boundEntitySearch,
  entityJsonBlocks,
  renderEntitySearch,
} from "../src/tools/entity-search-support.js";
import { createTestClient } from "./helpers.js";

function input(count = 1): EntitySearchResult<ProductRef> {
  const records: ProductRef[] = Array.from({ length: count }, (_, i) => ({
    name: `Zepbound ${i}`,
    category: "medication",
    identifiers: { ndc: [`0002-015${i}-01`] },
    source: {
      database: "openFDA",
      id: `0002-015${i}`,
      url: `https://example.test/${i}`,
      retrievedAt: "2026-10-31T00:00:00.000Z",
    },
  }));
  return {
    query: "Zepbound",
    type: "name",
    page: 1,
    entities: clusterProductGroups([
      { source: "openFDA", items: records, page: 1, hasMore: false },
    ]),
    sources: [],
    coverage: {
      entities: count,
      records: count,
      resolutionAttempted: 0,
      resolutionCompleted: 0,
      resolutionCapped: false,
    },
    partial: false,
    truncated: false,
    entitiesOmitted: 0,
    nextSteps: [],
  };
}

it("keeps a small and exactly fitting result unchanged", () => {
  const value = input();
  expect(boundEntitySearch(value, "product").value).toBe(value);
  value.query = "x".repeat(
    CHARACTER_LIMIT - JSON.stringify(value).length + value.query.length,
  );
  expect(JSON.stringify(value).length).toBe(CHARACTER_LIMIT);
  expect(boundEntitySearch(value, "product")).toEqual({
    value,
    truncated: false,
  });
});

it("slims evidence before dropping records and reports omissions in both formats", () => {
  const value = input(2);
  const first = value.entities[0];
  assert(first);
  first.evidence = [
    { kind: "ndc", value: "x".repeat(30000), confidence: "direct" },
  ];
  const original = structuredClone(value);
  const { value: output } = boundEntitySearch(value, "product");
  expect(output.entities).toHaveLength(2);
  expect(output.entities[0]?.records).toEqual(original.entities[0]?.records);
  expect(output.entities[0]?.omitted).toEqual({ evidence: 1 });
  expect(output).toMatchObject({
    partial: true,
    truncated: true,
    entitiesOmitted: 0,
  });
  expect(value).toEqual(original);
  expect(productEntitySearchResultSchema.parse(output)).toEqual(output);
  const context = { kind: "product" as const, hasCategory: false };
  expect(
    JSON.parse(entityJsonBlocks(output, context, true)[0]?.text ?? ""),
  ).toEqual(output);
  expect(renderEntitySearch(output, context, true, (r) => r.name)).toContain(
    '"evidence":1',
  );
});

it("caps summaries without removing later-stage collections", () => {
  const value = input();
  const first = value.entities[0];
  assert(first?.records[0]);
  first.records[0].summary = "s".repeat(30000);
  const { value: output } = boundEntitySearch(value, "product");
  expect(output.entities[0]?.omitted).toEqual({ summaries: 1 });
  expect(output.entities[0]?.records[0]?.summary?.length).toBe(500);
  expect(output.entities[0]?.evidence).toEqual(first.evidence);
});

it("omits trailing entities but never the final oversized entity", () => {
  const value = input(2);
  const [first, second] = value.entities;
  assert(first && second);
  first.name = "x".repeat(18000);
  second.name = "y".repeat(18000);
  const { value: output } = boundEntitySearch(value, "product");
  expect(output.entities).toHaveLength(1);
  expect(output.coverage.entities).toBe(2);
  expect(output).toMatchObject({
    partial: true,
    truncated: true,
    entitiesOmitted: 1,
  });
  expect(JSON.stringify(output).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
});

it("removes trailing records with their stale lookup actions", () => {
  const value = input();
  const first = value.entities[0];
  assert(first?.records[0]);
  first.records.push({
    ...first.records[0],
    name: "x".repeat(30000),
    source: { ...first.records[0].source, id: "gone" },
  });
  first.nextSteps.push({
    tool: "drugdata_get_product",
    input: { source: "openfda", id: "gone" },
    why: "lookup",
  });
  const { value: output } = boundEntitySearch(value, "product");
  expect(output.entities[0]?.omitted).toMatchObject({
    records: 1,
    nextSteps: 1,
  });
  expect(output.entities[0]?.nextSteps.some((s) => s.input.id === "gone")).toBe(
    false,
  );
});

it("caps identifier arrays and preserves retained spellings and source lookups", () => {
  const value = input();
  const first = value.entities[0];
  assert(first?.records[0]);
  const ids = Array.from({ length: 100 }, (_, i) => `${i}${"0".repeat(400)}`);
  first.identifiers.rxcui = ids;
  first.records[0].identifiers.rxcui = ids;
  const { value: output } = boundEntitySearch(value, "product");
  expect(output.entities[0]?.identifiers.rxcui).toEqual(ids.slice(0, 10));
  expect(output.entities[0]?.omitted).toMatchObject({
    recordIdentifiers: 90,
    identifiers: 90,
  });
  expect(output.entities[0]?.nextSteps[0]?.input.id).toBe("0002-0150");
  expect(output.entities[0]?.records[0]?.source.url).toBe(
    "https://example.test/0",
  );
});

it("returns a minimal shell and counts pathological error and identifier loss", () => {
  const value = input();
  const first = value.entities[0];
  assert(first?.records[0]);
  first.identifiers.splSetId = "x".repeat(30000);
  first.records[0].identifiers.splSetId = "x".repeat(30000);
  first.errors = [{ database: "RxNorm", message: "x".repeat(30000) }];
  const { value: output } = boundEntitySearch(value, "product");
  expect(output.entities).toHaveLength(1);
  expect(output.entities[0]).toMatchObject({
    records: [],
    identifiers: {},
    nextSteps: [],
    omitted: {
      records: 1,
      errors: 1,
      identifiers: 2,
      recordIdentifiers: 2,
      nextSteps: 2,
    },
  });
  expect(JSON.stringify(output).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
});

it("rejects an unrepresentable minimal shell instead of returning empty success", () => {
  const value = input();
  const first = value.entities[0];
  assert(first);
  first.name = "x".repeat(30000);
  expect(() => boundEntitySearch(value, "product")).toThrow(/cannot fit/);
});

for (const field of ["candidates", "links", "conflicts"] as const) {
  it(`bounds oversized ${field} without dropping records`, () => {
    const value = input();
    const first = value.entities[0];
    assert(first);
    if (field === "links")
      first.links = [
        {
          database: "RxNorm",
          id: "1",
          url: `https://example.test/${"x".repeat(30000)}`,
          confidence: "derived",
          matchedVia: "ndc",
        },
      ];
    if (field === "candidates")
      first.candidates = [
        {
          database: "RxNorm",
          matchedVia: "ndc",
          reason: "x".repeat(30000),
          options: [],
        },
      ];
    if (field === "conflicts")
      first.conflicts = [{ field: "x".repeat(30000), values: [] }];
    const output = boundEntitySearch(value, "product").value;
    expect(output.entities[0]?.records).toEqual(first.records);
    expect(output.entities[0]?.omitted?.[field]).toBe(1);
    expect(output.partial).toBe(true);
  });
}
it("bounds an ingredient result and preserves its source lookup", () => {
  const value = input();
  const first = value.entities[0];
  assert(first?.records[0]);
  const ingredient = {
    ...first,
    identifiers: { cid: [2244] },
    records: [
      {
        ...first.records[0],
        source: {
          ...first.records[0].source,
          database: "PubChem" as const,
          id: "2244",
        },
        identifiers: { cid: [2244] },
      },
    ],
    evidence: [
      { kind: "cid", value: "x".repeat(30000), confidence: "direct" as const },
    ],
  };
  const output = boundEntitySearch(
    { ...value, entities: [ingredient] },
    "ingredient",
  ).value;
  expect(ingredientEntitySearchResultSchema.parse(output).truncated).toBe(true);
  expect(output.entities[0]?.records[0]?.source.id).toBe("2244");
});

for (const response_format of ["json", "markdown"] as const) {
  for (const oversized of ["name", "summary"] as const) {
    it(`exposes bounded ${oversized} through a real MCP ${response_format} call`, async () => {
      const record = input().entities[0]?.records[0];
      assert(record);
      const registry = createRegistry(
        [
          {
            id: "openfda",
            databases: ["openFDA"],
            ingredientSearchTypes: [],
            productSearchTypes: ["name"],
            productCategories: ["medication"],
            searchProducts: async () => [
              {
                source: "openFDA",
                items: [
                  {
                    ...record,
                    [oversized]: "x".repeat(30000),
                  },
                ],
                page: 1,
                hasMore: false,
              },
            ],
          },
        ],
        [],
      );
      const harness = await createTestClient(() =>
        createServer({
          registry,
          resolver: {
            resolve: async () => ({
              kind: "product",
              links: [],
              ingredients: [],
              candidates: [],
            }),
          },
        }),
      );
      try {
        const result = await harness.client.callTool({
          name: "drugdata_search_products",
          arguments: { type: "name", query: "Zepbound", response_format },
        });
        if (oversized === "name") {
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result.content)).toContain("cannot fit");
        } else {
          expect(result.isError).toBeFalsy();
          const output = productEntitySearchResultSchema.parse(
            result.structuredContent,
          );
          expect(output.entities[0]?.omitted).toEqual({ summaries: 1 });
          expect(output.partial).toBe(true);
          expect(JSON.stringify(result.content)).toContain("summaries");
        }
      } finally {
        await harness.close();
      }
    });
  }
}
