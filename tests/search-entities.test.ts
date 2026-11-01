import { describe, expect, it } from "vitest";
import type {
  DatabaseId,
  IngredientRef,
  ProductRef,
} from "../src/lib/schemas.js";
import {
  ingredientEntitySearchResultSchema,
  productEntitySearchResultSchema,
} from "../src/lib/schemas.js";
import {
  clusterIngredientGroups,
  clusterProductGroups,
  ingredientResolveInput,
} from "../src/sources/search/entities.js";

const date = "2026-10-31T00:00:00.000Z";
function ref(
  database: DatabaseId,
  id: string,
  identifiers: IngredientRef["identifiers"],
): IngredientRef {
  return {
    name: "same name",
    identifiers,
    source: {
      database,
      id,
      url: `https://example.test/${database}/${id}`,
      retrievedAt: date,
    },
  };
}
describe("entity clustering", () => {
  it("validates closed result schemas and retains evidence, provenance and followups", () => {
    const entities = clusterIngredientGroups([
      {
        source: "PubChem",
        items: [ref("PubChem", "2244", { cid: [2244] })],
        page: 1,
        hasMore: false,
      },
    ]);
    const result = {
      query: "aspirin",
      type: "name",
      page: 1,
      entities,
      sources: [
        {
          source: "PubChem",
          status: "ok",
          page: 1,
          hasMore: false,
          resultCount: 1,
        },
      ],
      coverage: {
        entities: 1,
        records: 1,
        resolutionAttempted: 0,
        resolutionCompleted: 0,
        resolutionCapped: false,
      },
      partial: false,
      nextSteps: [],
      truncated: false,
      entitiesOmitted: 0,
      unexpected: "drop",
    };
    expect(ingredientEntitySearchResultSchema.parse(result)).not.toHaveProperty(
      "unexpected",
    );
    expect(
      productEntitySearchResultSchema.parse({
        ...result,
        entities: [],
        category: "medication",
      }).category,
    ).toBe("medication");
  });
  it("joins transitively by strong evidence, retaining conflicts and all record actions", () => {
    const records = [
      ref("openFDA", "A", { unii: "53AXN4NNHX" }),
      ref("RxNorm", "1991302", { unii: "53axn4nnhx", rxcui: ["1991302"] }),
      ref("DrugCentral", "5267", {
        rxcui: ["1991302"],
        cid: [56843331],
        inchiKey: "ONE",
      }),
      ref("PubChem", "56843331", { cid: [56843331], inchiKey: "TWO" }),
    ];
    const entities = clusterIngredientGroups(
      records.map((item) => ({
        source: item.source.database,
        items: [item],
        page: 1,
        hasMore: false,
      })),
    );
    expect(entities).toHaveLength(1);
    const entity = entities[0];
    expect(entity?.records.map((r) => r.source.database)).toEqual([
      "openFDA",
      "RxNorm",
      "DrugCentral",
      "PubChem",
    ]);
    expect(entity?.conflicts).toContainEqual(
      expect.objectContaining({
        field: "inchiKey",
        values: expect.arrayContaining([
          expect.objectContaining({ value: "ONE" }),
          expect.objectContaining({ value: "TWO" }),
        ]),
      }),
    );
    expect(
      entity?.nextSteps.filter((s) => s.tool === "drugdata_get_ingredient"),
    ).toHaveLength(4);
    expect(entity && ingredientResolveInput(entity)).toEqual({
      unii: "53AXN4NNHX",
    });
    expect(entity?.resolution).toBe("skipped");
  });
  it("deduplicates source records without dropping new identifiers or scalar conflicts", () => {
    const a = ref("DrugCentral", "1", {
      unii: "R16CO5Y76E",
      cid: [2244],
      inchiKey: "ONE",
    });
    const b = ref("DrugCentral", "1", { cid: [2], inchiKey: "TWO" });
    const [entity] = clusterIngredientGroups([
      { source: "DrugCentral", items: [a, b], page: 1, hasMore: false },
    ]);
    expect(entity?.records).toHaveLength(1);
    expect(entity?.identifiers.cid).toEqual([2244, 2]);
    expect(entity?.conflicts).toContainEqual(
      expect.objectContaining({ field: "inchiKey" }),
    );
    expect(a.identifiers.cid).toEqual([2244]);
  });
  it("does not join by names, EC numbers or weak candidates", () => {
    const records = [
      ref("CosIng", "a", { ec: ["1"] }),
      ref("INKEEDecoder", "b", { ec: ["1"] }),
    ];
    const entities = clusterIngredientGroups(
      records.map((item) => ({
        source: item.source.database,
        items: [item],
        page: 1,
        hasMore: false,
      })),
    );
    expect(entities).toHaveLength(2);
    expect(entities.map((e) => e.resolution)).toEqual(["skipped", "skipped"]);
  });
  it("only joins products by full package identity, not application or concept", () => {
    const product = (
      database: DatabaseId,
      id: string,
      identifiers: ProductRef["identifiers"],
    ): ProductRef => ({
      name: "same",
      identifiers,
      source: ref(database, id, {}).source,
    });
    const items = [
      product("openFDA", "a", {
        ndc: ["0002-8215-01"],
        rxcui: ["1"],
        applicationNumber: "X",
      }),
      product("DailyMed", "b", { ndc: ["00002821501"] }),
      product("RxNorm", "c", { rxcui: ["1"], applicationNumber: "X" }),
      product("DSLD", "d", { upc: ["0123-4567-8905"] }),
      product("INKEEDecoder", "e", { upc: ["012345678905"] }),
    ];
    const entities = clusterProductGroups(
      items.map((item) => ({
        source: item.source.database,
        items: [item],
        page: 1,
        hasMore: false,
      })),
    );
    expect(entities.map((e) => e.records.length)).toEqual([2, 1, 2]);
    expect(entities[1]?.resolution).toBe("unavailable");
  });
});
