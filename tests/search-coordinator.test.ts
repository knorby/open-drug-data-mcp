import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngredientRef } from "../src/lib/schemas.js";
import type { IdentityResolver } from "../src/sources/identity/chain.js";
import { createRegistry } from "../src/sources/registry.js";
import { createSearchCoordinator } from "../src/sources/search/coordinator.js";

const ref = (id: string): IngredientRef => ({
  name: id,
  identifiers: { unii: id.padEnd(10, "X") },
  source: {
    database: "openFDA",
    id,
    url: `https://example.test/${id}`,
    retrievedAt: "2026-10-31T00:00:00.000Z",
  },
});
const emptyResolver: IdentityResolver = {
  resolve: async () => ({
    kind: "ingredient",
    graph: { subject: {}, identifiers: {}, links: [], candidates: [] },
  }),
};
function registry(count = 6) {
  return createRegistry(
    [
      {
        id: "openfda",
        databases: ["openFDA"],
        productSearchTypes: [],
        ingredientSearchTypes: ["name"],
        productCategories: [],
        searchIngredients: async () => [
          {
            source: "openFDA",
            items: Array.from({ length: count }, (_, i) => ref(String(i))),
            page: 1,
            hasMore: false,
          },
        ],
      },
    ],
    [],
  );
}
afterEach(() => vi.useRealTimers());
describe("search coordinator", () => {
  it("returns healthy initial clusters without unsolicited resolution", async () => {
    const resolve = vi.fn(emptyResolver.resolve);
    const result = await createSearchCoordinator({
      registry: registry(),
      resolver: { resolve },
      timeoutMs: 45000,
    }).searchIngredients({ type: "name", query: "test", page: 1 });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.coverage).toEqual({
      entities: 6,
      records: 6,
      resolutionAttempted: 0,
      resolutionCompleted: 0,
      resolutionCapped: false,
    });
    expect(result.partial).toBe(false);
    expect(result.entities[0]?.nextSteps).toContainEqual(
      expect.objectContaining({ tool: "drugdata_resolve_identifiers" }),
    );
  });
  it("keeps database order when enrichment combines earlier clusters", async () => {
    const dc = {
      ...ref("74"),
      source: { ...ref("74").source, database: "DrugCentral" as const },
    };
    const fda = ref("0");
    const pc = {
      ...ref("2244"),
      identifiers: fda.identifiers,
      source: { ...ref("2244").source, database: "PubChem" as const },
    };
    const reg = createRegistry(
      [
        {
          id: "openfda",
          databases: ["openFDA", "DrugCentral", "PubChem"],
          ingredientSearchTypes: ["name"],
          productSearchTypes: [],
          productCategories: [],
          searchIngredients: async () =>
            [fda, dc, pc].map((record) => ({
              source: record.source.database,
              items: [record],
              page: 1,
              hasMore: false,
            })),
        },
      ],
      [],
    );
    const result = await createSearchCoordinator({
      registry: reg,
      timeoutMs: 45000,
      resolver: {
        resolve: async () => ({
          kind: "ingredient",
          graph: {
            subject: {},
            identifiers: {},
            candidates: [],
            links: [
              { ...dc.source, matchedVia: "unii", confidence: "derived" },
            ],
          },
        }),
      },
    }).searchIngredients({
      type: "name",
      query: "test",
      page: 1,
      resolveIdentities: true,
    });
    expect(
      result.entities[0]?.records.map((record) => record.source.database),
    ).toEqual(["openFDA", "DrugCentral", "PubChem"]);
  });
  it("retains enrichment evidence and source failures on the entity", async () => {
    const result = await createSearchCoordinator({
      registry: registry(1),
      timeoutMs: 45000,
      resolver: {
        resolve: async () => ({
          kind: "ingredient",
          graph: {
            subject: {},
            identifiers: { cid: [2244] },
            candidates: [],
            links: [
              {
                database: "PubChem",
                id: "2244",
                url: "https://pubchem.ncbi.nlm.nih.gov/compound/2244",
                retrievedAt: "2026-10-31T00:00:00.000Z",
                matchedVia: "cid",
                confidence: "derived",
              },
            ],
            errors: [
              {
                database: "CosIng",
                message: "CosIng is temporarily unavailable.",
              },
            ],
          },
        }),
      },
    }).searchIngredients({
      type: "name",
      query: "test",
      page: 1,
      resolveIdentities: true,
    });
    expect(result.entities[0]).toHaveProperty("errors", [
      { database: "CosIng", message: "CosIng is temporarily unavailable." },
    ]);
    expect(result.entities[0]?.evidence).toContainEqual({
      kind: "PubChem:id",
      value: "2244",
      confidence: "derived",
    });
    expect(result.partial).toBe(true);
  });
  it("reports the resolution cap even when enrichment merges every initial entity", async () => {
    const target = ref("5").source;
    const result = await createSearchCoordinator({
      registry: registry(),
      timeoutMs: 45000,
      resolver: {
        resolve: async () => ({
          kind: "ingredient",
          graph: {
            subject: {},
            identifiers: {},
            candidates: [],
            links: [{ ...target, matchedVia: "unii", confidence: "derived" }],
          },
        }),
      },
    }).searchIngredients({
      type: "name",
      query: "test",
      page: 1,
      resolveIdentities: true,
    });
    expect(result.entities).toHaveLength(1);
    expect(result.coverage.resolutionCapped).toBe(true);
    expect(result.partial).toBe(true);
  });
  it("recomputes the preferred action from enriched identifiers", async () => {
    const reg = createRegistry(
      [
        {
          id: "openfda",
          databases: ["openFDA"],
          ingredientSearchTypes: ["name"],
          productSearchTypes: [],
          productCategories: [],
          searchIngredients: async () => [
            {
              source: "openFDA",
              items: [{ ...ref("aspirin"), identifiers: {} }],
              page: 1,
              hasMore: false,
            },
          ],
        },
      ],
      [],
    );
    const resolver: IdentityResolver = {
      resolve: async () => ({
        kind: "ingredient",
        graph: {
          subject: {},
          identifiers: { unii: "R16CO5Y76E" },
          links: [],
          candidates: [],
        },
      }),
    };
    const result = await createSearchCoordinator({
      registry: reg,
      resolver,
      timeoutMs: 45000,
    }).searchIngredients({
      type: "name",
      query: "aspirin",
      page: 1,
      resolveIdentities: true,
    });
    expect(
      result.entities[0]?.nextSteps.find(
        (step) => step.tool === "drugdata_resolve_identifiers",
      )?.input,
    ).toEqual({ unii: "R16CO5Y76E" });
  });
  it("stops the resolver queue at expiry and handles late rejections", async () => {
    vi.useFakeTimers();
    const rejects: ((reason: Error) => void)[] = [];
    const resolver: IdentityResolver = {
      resolve: () => new Promise((_resolve, reject) => rejects.push(reject)),
    };
    const promise = createSearchCoordinator({
      registry: registry(),
      resolver,
      timeoutMs: 45000,
    }).searchIngredients({
      type: "name",
      query: "test",
      page: 1,
      resolveIdentities: true,
    });
    await vi.advanceTimersByTimeAsync(45000);
    const result = await promise;
    expect(result.coverage.resolutionAttempted).toBe(3);
    expect(result.coverage.resolutionCompleted).toBe(0);
    expect(
      result.entities
        .slice(0, 3)
        .every((entity) => entity.resolution === "partial"),
    ).toBe(true);
    const before = JSON.stringify(result);
    for (const reject of rejects) reject(new Error("late"));
    await vi.advanceTimersByTimeAsync(1);
    expect(rejects).toHaveLength(3);
    expect(JSON.stringify(result)).toBe(before);
  });
  it("returns an unavailable product as success and preserves category in pagination", async () => {
    const reg = createRegistry(
      [
        {
          id: "dsld",
          databases: ["DSLD"],
          productSearchTypes: ["name"],
          ingredientSearchTypes: [],
          productCategories: ["supplement"],
          searchProducts: async () => [
            {
              source: "DSLD",
              items: [{ ...ref("product"), identifiers: {} }],
              page: 2,
              hasMore: true,
            },
          ],
        },
      ],
      [],
    );
    const result = await createSearchCoordinator({
      registry: reg,
      resolver: emptyResolver,
      timeoutMs: 45000,
    }).searchProducts({
      type: "name",
      query: "vitamin",
      category: "supplement",
      page: 2,
    });
    expect(result.entities[0]?.resolution).toBe("unavailable");
    expect(result.partial).toBe(false);
    expect(result.coverage.resolutionAttempted).toBe(0);
    expect(result.nextSteps[0]?.input).toEqual({
      type: "name",
      query: "vitamin",
      category: "supplement",
      page: 3,
    });
  });
  it("marks failed source groups while keeping zero matches normal", async () => {
    const reg = createRegistry(
      [
        {
          id: "openfda",
          databases: ["openFDA"],
          productSearchTypes: [],
          ingredientSearchTypes: ["name"],
          productCategories: [],
          searchIngredients: async () => {
            throw new Error("failure");
          },
        },
        {
          id: "cosing",
          databases: ["CosIng"],
          productSearchTypes: [],
          ingredientSearchTypes: ["name"],
          productCategories: [],
          searchIngredients: async () => [
            { source: "CosIng", items: [], page: 1, hasMore: false },
          ],
        },
      ],
      [],
    );
    const reported: string[] = [];
    await reg.searchIngredients(
      "name",
      "none",
      { page: 1 },
      undefined,
      (groups) => reported.push(...groups.map((group) => group.source)),
    );
    expect(reported).toContain("openFDA");
    const result = await createSearchCoordinator({
      registry: reg,
      resolver: emptyResolver,
      timeoutMs: 45000,
    }).searchIngredients({ type: "name", query: "none", page: 1 });
    expect(result.entities).toEqual([]);
    expect(result.sources.map((source) => source.status)).toEqual([
      "error",
      "ok",
    ]);
    expect(result.partial).toBe(true);
  });
  it("propagates caller cancellation promptly", async () => {
    const controller = new AbortController();
    const promise = createSearchCoordinator({
      registry: registry(),
      resolver: { resolve: () => new Promise(() => {}) },
      timeoutMs: 45000,
    }).searchIngredients(
      { type: "name", query: "none", page: 1 },
      controller.signal,
    );
    const assertion = expect(promise).rejects.toThrow();
    controller.abort();
    await assertion;
  });
  it("publishes settled groups before slower adapters and preserves aggregate ordering", async () => {
    let finish: (groups: []) => void = () => {};
    const reported: string[] = [];
    const reg = createRegistry(
      [
        {
          id: "cosing",
          databases: ["CosIng"],
          ingredientSearchTypes: ["name"],
          productSearchTypes: [],
          productCategories: [],
          searchIngredients: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
        {
          id: "openfda",
          databases: ["openFDA"],
          ingredientSearchTypes: ["name"],
          productSearchTypes: [],
          productCategories: [],
          searchIngredients: async () => [
            { source: "openFDA", items: [], page: 1, hasMore: false },
          ],
        },
      ],
      [],
    );
    const pending = reg.searchIngredients(
      "name",
      "test",
      { page: 1 },
      undefined,
      (groups) => reported.push(...groups.map((g) => g.source)),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(reported).toEqual(["openFDA"]);
    finish([]);
    expect((await pending).map((g) => g.source)).toEqual(["openFDA"]);
  });
  it("merges linked entities and retains enrichment-only chemical conflicts without inflating original records", async () => {
    const dc = {
      ...ref("5267"),
      identifiers: { unii: "53AXN4NNHX", inchiKey: "ONE" },
      source: { ...ref("5267").source, database: "DrugCentral" as const },
    };
    const pc = {
      ...ref("56843331"),
      identifiers: { cid: [56843331], inchiKey: "TWO" },
      source: { ...ref("56843331").source, database: "PubChem" as const },
    };
    const reg = createRegistry(
      [
        {
          id: "drugcentral",
          databases: ["DrugCentral"],
          productSearchTypes: [],
          ingredientSearchTypes: ["name"],
          productCategories: [],
          searchIngredients: async () => [
            { source: "DrugCentral", items: [dc], page: 1, hasMore: false },
          ],
        },
      ],
      [],
    );
    const resolver: IdentityResolver = {
      resolve: async () => ({
        kind: "ingredient",
        graph: {
          subject: {},
          identifiers: { cid: [56843331] },
          links: [
            {
              database: "PubChem",
              id: "56843331",
              url: pc.source.url,
              matchedVia: "cid",
              confidence: "derived",
            },
          ],
          candidates: [],
          records: [dc, pc],
        },
      }),
    };
    const result = await createSearchCoordinator({
      registry: reg,
      resolver,
      timeoutMs: 45000,
    }).searchIngredients({
      type: "name",
      query: "semaglutide",
      page: 1,
      resolveIdentities: true,
    });
    expect(result.entities[0]?.records).toHaveLength(1);
    expect(result.entities[0]?.identifiers.cid).toEqual([56843331]);
    expect(result.entities[0]?.conflicts).toContainEqual(
      expect.objectContaining({ field: "inchiKey" }),
    );
  });
  it("joins separately found records using confident resolver evidence and deduplicates conflicts", async () => {
    const dc = {
      ...ref("5267"),
      identifiers: { unii: "53AXN4NNHX", inchiKey: "ONE" },
      source: { ...ref("5267").source, database: "DrugCentral" as const },
    };
    const pc = {
      ...ref("56843331"),
      identifiers: { cid: [56843331], inchiKey: "TWO" },
      source: { ...ref("56843331").source, database: "PubChem" as const },
    };
    const reg = createRegistry(
      [
        {
          id: "drugcentral",
          databases: ["DrugCentral"],
          ingredientSearchTypes: ["name"],
          productSearchTypes: [],
          productCategories: [],
          searchIngredients: async () => [
            { source: "DrugCentral", items: [dc], page: 1, hasMore: false },
          ],
        },
        {
          id: "nlm",
          databases: ["PubChem"],
          ingredientSearchTypes: ["name"],
          productSearchTypes: [],
          productCategories: [],
          searchIngredients: async () => [
            { source: "PubChem", items: [pc], page: 1, hasMore: false },
          ],
        },
      ],
      [],
    );
    const resolver: IdentityResolver = {
      resolve: async () => ({
        kind: "ingredient",
        graph: {
          subject: {},
          identifiers: { unii: "53AXN4NNHX", cid: [56843331] },
          links: [
            {
              database: "PubChem",
              id: "56843331",
              url: pc.source.url,
              confidence: "derived",
              matchedVia: "cid",
            },
          ],
          candidates: [],
          records: [dc, pc],
        },
      }),
    };
    const result = await createSearchCoordinator({
      registry: reg,
      resolver,
      timeoutMs: 45000,
    }).searchIngredients({
      type: "name",
      query: "semaglutide",
      page: 1,
      resolveIdentities: true,
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.records).toHaveLength(2);
    expect(result.entities[0]?.conflicts).toHaveLength(1);
    expect(result.entities[0]?.conflicts[0]?.values).toHaveLength(2);
  });
  it("resolves at most five entities with concurrency three", async () => {
    let active = 0,
      max = 0;
    const resolver: IdentityResolver = {
      resolve: async () => {
        active++;
        max = Math.max(max, active);
        await Promise.resolve();
        active--;
        return emptyResolver.resolve({ unii: "R16CO5Y76E" });
      },
    };
    const result = await createSearchCoordinator({
      registry: registry(),
      resolver,
      timeoutMs: 45000,
    }).searchIngredients({
      type: "name",
      query: "test",
      page: 1,
      resolveIdentities: true,
    });
    expect(result.coverage).toEqual({
      entities: 6,
      records: 6,
      resolutionAttempted: 5,
      resolutionCompleted: 5,
      resolutionCapped: true,
    });
    expect(max).toBe(3);
    expect(result.entities.map((e) => e.resolution)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
      "skipped",
    ]);
    expect(result.partial).toBe(true);
  });
  it("preserves completed raw groups on deadline and ignores late settlement", async () => {
    vi.useFakeTimers();
    let finish: (value: []) => void = () => {};
    const reg = createRegistry(
      [
        {
          id: "openfda",
          databases: ["openFDA"],
          productSearchTypes: [],
          ingredientSearchTypes: ["name"],
          productCategories: [],
          searchIngredients: async () => [
            { source: "openFDA", items: [ref("A")], page: 1, hasMore: false },
          ],
        },
        {
          id: "cosing",
          databases: ["CosIng"],
          productSearchTypes: [],
          ingredientSearchTypes: ["name"],
          productCategories: [],
          searchIngredients: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      ],
      [],
    );
    const promise = createSearchCoordinator({
      registry: reg,
      resolver: emptyResolver,
      timeoutMs: 45000,
    }).searchIngredients({ type: "name", query: "test", page: 1 });
    await vi.advanceTimersByTimeAsync(45000);
    const result = await promise;
    expect(result.entities).toHaveLength(1);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ source: "CosIng", status: "timeout" }),
    );
    expect(result.coverage.resolutionAttempted).toBe(0);
    expect(result.partial).toBe(true);
    const before = JSON.stringify(result);
    finish([]);
    await Promise.resolve();
    expect(JSON.stringify(result)).toBe(before);
  });
  it("isolates resolver failures without dropping source success", async () => {
    const resolver: IdentityResolver = {
      resolve: async () => {
        throw new Error("@knorby/private-client failed");
      },
    };
    const result = await createSearchCoordinator({
      registry: registry(1),
      resolver,
      timeoutMs: 45000,
    }).searchIngredients({
      type: "name",
      query: "test",
      page: 1,
      resolveIdentities: true,
    });
    expect(result.entities[0]?.resolution).toBe("partial");
    expect(result.entities[0]?.records).toHaveLength(1);
    expect(result.sources[0]?.status).toBe("ok");
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-client");
  });
});
