import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import type { ReferenceSearcher } from "../src/sources/nlm-references/index.js";
import type { ReferenceGroup } from "../src/sources/nlm-references/types.js";
import { createTestClient, type TestHarness, textOf } from "./helpers.js";

/**
 * Tool-level tests for `drugdata_search_references`.
 *
 * The searcher is injected as a stub, so these pin the tool boundary: the
 * pre-network pairing check, both output formats, cursor passthrough, error
 * and empty rendering, and next-step derivation. Handler behavior lives in
 * nlm-references.test.ts.
 */

/** A happy group for a PubMed-style answer. */
function articleGroup(): ReferenceGroup {
  return {
    source: "PubMed",
    items: [
      {
        kind: "article",
        title: "Aspirin use and outcomes",
        publicationDate: "2023 Feb",
        source: {
          database: "PubMed",
          id: "36758480",
          url: "https://pubmed.ncbi.nlm.nih.gov/36758480/",
          retrievedAt: "2026-10-22T00:00:00.000Z",
        },
        identifiers: { pmid: "36758480" },
      },
      {
        kind: "article",
        title: "Aspirin and platelets",
        source: {
          database: "PubMed",
          id: "36758481",
          url: "https://pubmed.ncbi.nlm.nih.gov/36758481/",
          retrievedAt: "2026-10-22T00:00:00.000Z",
        },
        identifiers: { pmid: "36758481" },
      },
    ],
    hasMore: true,
    nextCursor: "opaque-cursor",
    total: 42,
  };
}

/** Connects a client whose server uses the given searcher. */
async function start(searcher: ReferenceSearcher): Promise<TestHarness> {
  return createTestClient(() => createServer({ referenceSearch: searcher }));
}

/** A searcher stub that answers every call with one group. */
function staticSearcher(
  group: ReferenceGroup,
): ReferenceSearcher & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const searcher: ReferenceSearcher & { calls: unknown[][] } = async (
    input,
    signal,
  ) => {
    calls.push([input, signal]);
    return group;
  };
  searcher.calls = calls;
  return searcher;
}

describe("search_references tool", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn()); // the tool must not fetch
  });
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    vi.unstubAllGlobals();
  });

  it("renders a reference list in markdown", async () => {
    harness = await start(staticSearcher(articleGroup()));

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "pubmed", query: "aspirin" },
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("## PubMed references");
    expect(text).toContain('Searched by name for "aspirin".');
    expect(text).toContain("**Aspirin use and outcomes**");
    expect(text).toContain("- Identifiers: PMID: 36758480");
    expect(text).toContain("- Published: 2023 Feb");
    expect(text).toContain("https://pubmed.ncbi.nlm.nih.gov/36758480/");
    expect(text).toContain("More results available");
    expect(text).toContain("Total upstream matches: 42");
  });

  it("notes when the response text was bounded", async () => {
    const base = articleGroup();
    const group: ReferenceGroup = {
      ...base,
      items: base.items.map((item, index) =>
        index === 0 ? { ...item, title: "x".repeat(40_000) } : item,
      ),
    };
    harness = await start(staticSearcher(group));

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "pubmed", query: "aspirin" },
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Some fields were shortened");
    expect(text).toContain("25,000");
    expect(text.length).toBeLessThan(40_000);
    const output = result.structuredContent as { truncated: boolean };
    expect(output.truncated).toBe(true);
  });

  it("returns the structured result and a guidance block in json format", async () => {
    harness = await start(
      staticSearcher({ source: "PubMed", items: [], hasMore: false }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: {
        source: "pubmed",
        query: "zzzz",
        response_format: "json",
      },
    });

    expect(result.isError).toBeFalsy();
    const blocks = result.content as { type: string; text: string }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.text).toContain("No matches found");
    const output = result.structuredContent as {
      groups: ReferenceGroup[];
      truncated: boolean;
    };
    expect(output.groups).toHaveLength(1);
    expect(output.groups[0]?.items).toEqual([]);
    expect(output.truncated).toBe(false);
  });

  it("omits the guidance block in json format when items were found", async () => {
    harness = await start(staticSearcher(articleGroup()));

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: {
        source: "pubmed",
        query: "aspirin",
        response_format: "json",
      },
    });

    expect(result.isError).toBeFalsy();
    const blocks = result.content as { type: string; text: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain("Aspirin use and outcomes");
    const output = result.structuredContent as { truncated: boolean };
    expect(output.truncated).toBe(false);
  });

  it("forwards the caller's arguments and signal to the searcher", async () => {
    const searcher = staticSearcher(articleGroup());
    harness = await start(searcher);

    await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: {
        source: "rxclass",
        type: "rxcui",
        query: "1191",
        limit: 5,
        cursor: "opaque-cursor",
      },
    });

    expect(searcher.calls).toHaveLength(1);
    expect(searcher.calls[0]?.[0]).toEqual({
      source: "rxclass",
      type: "rxcui",
      query: "1191",
      limit: 5,
      cursor: "opaque-cursor",
    });
  });

  it("rejects a source/type mismatch before calling the searcher", async () => {
    const searcher = staticSearcher(articleGroup());
    harness = await start(searcher);

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "mesh", type: "rxcui", query: "1191" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not search by rxcui");
    expect(textOf(result)).toContain("'name'");
    expect(searcher.calls).toEqual([]);
  });

  it("renders an error group with a warning line", async () => {
    harness = await start(
      staticSearcher({
        source: "UMLS",
        items: [],
        hasMore: false,
        error: "UMLS needs an API key. Set UMLS_API_KEY.",
      }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "umls", query: "aspirin" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("⚠ UMLS: UMLS needs an API key");
  });

  it("renders a limitation note and a cursor-less hasMore line", async () => {
    harness = await start(
      staticSearcher({
        source: "RxClass",
        items: [],
        hasMore: true,
        limitation: "This source reports no result totals.",
      }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "rxclass", query: "salicylic" },
    });

    const text = textOf(result);
    expect(text).toContain("_Note: This source reports no result totals._");
    expect(text).toContain("no continuation token");
  });

  it("suggests the ingredient lookup for references that carry an rxcui", async () => {
    harness = await start(
      staticSearcher({
        source: "RxNorm",
        items: [
          {
            kind: "drug",
            title: "Aspirin",
            source: {
              database: "RxNorm",
              id: "1191",
              url: "https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=1191",
              retrievedAt: "2026-10-22T00:00:00.000Z",
            },
            identifiers: { rxcui: "1191" },
            dataset: "Prescribable",
          },
        ],
        hasMore: false,
      }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "prescribable", query: "aspirin" },
    });

    const text = textOf(result);
    expect(text).toContain("**Next steps**");
    expect(text).toContain("drugdata_get_ingredient");
    expect(text).toContain("Dataset: Prescribable");
  });

  it("returns an isError result when the searcher fails unexpectedly", async () => {
    harness = await start(async () => {
      throw new Error("@knorby/nlm-drugs-client exploded");
    });

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "pubmed", query: "aspirin" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("failed unexpectedly");
    expect(textOf(result)).not.toMatch(/@knorby|client/i);
  });

  it("renders an empty markdown result with a no-matches line", async () => {
    harness = await start(
      staticSearcher({ source: "MeSH", items: [], hasMore: false }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "mesh", query: "zzzz" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No matches from MeSH.");
  });

  it("renders an untitled reference with a placeholder", async () => {
    harness = await start(
      staticSearcher({
        source: "MedlinePlus",
        items: [
          {
            kind: "genetics",
            source: {
              database: "MedlinePlus",
              id: "https://medlineplus.gov/genetics/gene/BRCA1",
              url: "https://medlineplus.gov/genetics/gene/BRCA1",
              retrievedAt: "2026-10-22T00:00:00.000Z",
            },
            identifiers: {},
          },
        ],
        hasMore: false,
      }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "medlineplus_genetics", query: "brca1" },
    });

    expect(textOf(result)).toContain("**(untitled)**");
  });

  it("guides on an error group in json format too", async () => {
    harness = await start(
      staticSearcher({
        source: "UMLS",
        items: [],
        hasMore: false,
        error: "UMLS needs an API key. Set UMLS_API_KEY.",
      }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: {
        source: "umls",
        query: "aspirin",
        response_format: "json",
      },
    });

    const blocks = result.content as { type: string; text: string }[];
    expect(blocks[1]?.text).toContain("UMLS_API_KEY");
  });

  it("deduplicates and caps rxcui-driven next steps", async () => {
    const reference = (rxcui: string) => ({
      kind: "drug" as const,
      title: `Concept ${rxcui}`,
      source: {
        database: "RxNorm" as const,
        id: rxcui,
        url: `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${rxcui}`,
        retrievedAt: "2026-10-22T00:00:00.000Z",
      },
      identifiers: { rxcui },
    });
    harness = await start(
      staticSearcher({
        source: "RxNorm",
        items: [
          reference("1"),
          reference("1"),
          reference("2"),
          reference("3"),
          reference("4"),
        ],
        hasMore: false,
      }),
    );

    const result = await harness.client.callTool({
      name: "drugdata_search_references",
      arguments: { source: "prescribable", query: "aspirin" },
    });

    const output = result.structuredContent as {
      nextSteps: { input: { id: string } }[];
    };
    expect(output.nextSteps.map((step) => step.input.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});
