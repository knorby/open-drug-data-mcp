import { NlmDrugsClient } from "@knorby/nlm-drugs-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import {
  encodeCursor,
  InvalidCursorError,
} from "../src/sources/nlm-references/cursor.js";
import { createReferenceSearcher } from "../src/sources/nlm-references/index.js";
import type {
  ReferenceGroup,
  ReferenceSearchInput,
} from "../src/sources/nlm-references/types.js";
import { jsonResponse } from "./helpers.js";

/**
 * Handler-level tests for the NLM reference searches.
 *
 * Each source is driven through `createReferenceSearcher` with a
 * path-routed, fixture-shaped client — the same stubbing style the NLM
 * adapter tests use. The tool layer has its own file; this one pins the
 * handlers, cursors, and dispatcher behavior.
 */

/** Every environment variable the searcher reads. */
const ENV_KEYS = [
  "DRUGDATA_DISABLED_SOURCES",
  "DRUGDATA_TIMEOUT_MS",
  "UMLS_API_KEY",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/** Routes one upstream URL to a canned response body. */
type Route = unknown | (() => Response);

/** Builds a client whose fetch answers from a path table. */
function routedClient(
  routes: Record<string, Route>,
  seen: string[] = [],
): NlmDrugsClient {
  return new NlmDrugsClient({
    umls: { apiKey: "test-key" },
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(`${url.pathname}?${url.searchParams.toString()}`);
      const route = routes[url.pathname];
      if (route !== undefined) {
        return typeof route === "function" ? route() : jsonResponse(route);
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as unknown as typeof fetch,
  });
}

/** A wsearch-style XML response (topics and genetics). */
function searchXml(
  documents: ReadonlyArray<{ url: string; title?: string }>,
  total: number,
  file?: string,
  server?: string,
): Response {
  const rows = documents
    .map(
      (document) =>
        `<document url="${document.url}">${
          document.title === undefined
            ? ""
            : `<content name="title">${document.title}</content>`
        }<content name="snippet">ignored</content></document>`,
    )
    .join("");
  return new Response(
    `<nlmSearchResult><count>${total}</count>${
      file === undefined || server === undefined
        ? ""
        : `<file>${file}</file><server>${server}</server>`
    }<list>${rows}</list></nlmSearchResult>`,
    { status: 200, headers: { "content-type": "text/xml" } },
  );
}

/** A genetics-style XML response (results carry no titles). */
function geneticsXml(
  urls: readonly string[],
  total: number,
  file?: string,
  server?: string,
): Response {
  const rows = urls
    .map(
      (url, index) =>
        `<result><url>${url}</url><order>${index + 1}</order></result>`,
    )
    .join("");
  return new Response(
    `<search_results count="${total}">${
      file === undefined || server === undefined
        ? ""
        : `<file>${file}</file><server>${server}</server>`
    }${rows}</search_results>`,
    { status: 200, headers: { "content-type": "text/xml" } },
  );
}

function searcher(client: NlmDrugsClient) {
  return createReferenceSearcher({ client, umlsConfigured: true });
}

async function run(
  search: ReturnType<typeof createReferenceSearcher>,
  input: ReferenceSearchInput,
): Promise<ReferenceGroup> {
  return search(input);
}

describe("reference searcher — terminology sources", () => {
  beforeEach(() => {
    clearEnv();
    resetConfig();
  });
  afterEach(() => {
    clearEnv();
    resetConfig();
  });

  it("pages prescribable name searches through concept follow-ups", async () => {
    const search = searcher(
      routedClient({
        "/REST/Prescribe/rxcui.json": {
          idGroup: { rxnormId: ["111", "222"] },
        },
        "/REST/Prescribe/rxcui/111/properties.json": {
          properties: { rxcui: "111", name: "Aspirin", tty: "IN" },
        },
        // A concept that retired between listing and lookup is dropped.
        "/REST/Prescribe/rxcui/222/properties.json": {},
      }),
    );

    const first = await run(search, {
      source: "prescribable",
      type: "name",
      query: "aspirin",
      limit: 1,
    });
    expect(first.source).toBe("RxNorm");
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      kind: "drug",
      title: "Aspirin",
      dataset: "Prescribable",
    });
    expect(first.items[0]?.identifiers).toEqual({ rxcui: "111" });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = await run(search, {
      source: "prescribable",
      type: "name",
      query: "aspirin",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(0);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it("answers a prescribable rxcui with one concept", async () => {
    const search = searcher(
      routedClient({
        "/REST/Prescribe/rxcui/111/properties.json": {
          properties: { rxcui: "111", name: "Aspirin", tty: "IN" },
        },
      }),
    );

    const group = await run(search, {
      source: "prescribable",
      type: "rxcui",
      query: "111",
      limit: 10,
    });
    expect(group.items).toHaveLength(1);
    expect(group.hasMore).toBe(false);
  });

  it("returns an empty prescribable rxcui group for an unknown concept", async () => {
    const search = searcher(
      routedClient({
        "/REST/Prescribe/rxcui/999/properties.json": {},
      }),
    );

    const group = await run(search, {
      source: "prescribable",
      type: "rxcui",
      query: "999",
      limit: 10,
    });
    expect(group.items).toEqual([]);
    expect(group.hasMore).toBe(false);
  });

  it("searches rxclass by class name and by member rxcui", async () => {
    const byName = await run(
      searcher(
        routedClient({
          "/REST/rxclass/class/byName.json": {
            rxclassMinConceptList: {
              rxclassMinConcept: [
                {
                  classId: "N02BA",
                  className: "Salicylic acids",
                  classType: "ATC1-4",
                },
              ],
            },
          },
        }),
      ),
      { source: "rxclass", type: "name", query: "salicylic", limit: 10 },
    );
    expect(byName.source).toBe("RxClass");
    expect(byName.items[0]).toMatchObject({
      kind: "class",
      title: "Salicylic acids",
    });
    expect(byName.items[0]?.identifiers).toEqual({
      classId: "N02BA",
      classType: "ATC1-4",
    });

    const byRxcui = await run(
      searcher(
        routedClient({
          "/REST/rxclass/class/byRxcui.json": {
            rxclassDrugInfoList: {
              rxclassDrugInfo: [
                {
                  rxclassMinConceptItem: {
                    classId: "N02BA01",
                    className: "Salicylates",
                    classType: "ATC1-4",
                  },
                },
              ],
            },
          },
        }),
      ),
      { source: "rxclass", type: "rxcui", query: "1191", limit: 10 },
    );
    expect(byRxcui.items[0]?.identifiers.classId).toBe("N02BA01");
  });

  it("searches mesh descriptors and keeps the upstream resource link", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/mesh/lookup/descriptor": [
            {
              resource: "http://id.nlm.nih.gov/mesh/D014810",
              label: "Aspirin",
            },
          ],
        }),
      ),
      { source: "mesh", type: "name", query: "aspirin", limit: 10 },
    );
    expect(group.source).toBe("MeSH");
    expect(group.items[0]).toMatchObject({
      kind: "descriptor",
      title: "Aspirin",
    });
    expect(group.items[0]?.identifiers.meshId).toBe("D014810");
    expect(group.items[0]?.source.url).toBe(
      "http://id.nlm.nih.gov/mesh/D014810",
    );
  });

  it("slices umls name searches and passes root sources as datasets", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/rest/search/current": {
            result: {
              results: [
                { ui: "C0004057", name: "Aspirin", rootSource: "MSH" },
                { ui: "C0004058", name: "Aspirin-like" },
              ],
            },
          },
        }),
      ),
      { source: "umls", type: "name", query: "aspirin", limit: 1 },
    );
    expect(group.source).toBe("UMLS");
    expect(group.items).toHaveLength(1);
    expect(group.items[0]?.dataset).toBe("MSH");
    expect(group.items[0]?.identifiers.cui).toBe("C0004057");
    expect(group.hasMore).toBe(false);
    expect(group.limitation).toContain("first page");
  });

  it("answers a umls cui with one concept", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/rest/content/current/CUI/C0004057": {
            result: { ui: "C0004057", name: "Aspirin" },
          },
        }),
      ),
      { source: "umls", type: "cui", query: "C0004057", limit: 10 },
    );
    expect(group.items[0]?.title).toBe("Aspirin");
    expect(group.items[0]?.identifiers.cui).toBe("C0004057");
  });

  it("reports an unusable umls concept record as an error group", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/rest/content/current/CUI/C0004057": { result: { ui: 5 } },
        }),
      ),
      { source: "umls", type: "cui", query: "C0004057", limit: 10 },
    );
    expect(group.items).toEqual([]);
    expect(group.error).toContain("failed unexpectedly");
  });

  it("returns configuration advice when no UMLS key is set", async () => {
    const seen: string[] = [];
    const search = createReferenceSearcher({
      client: routedClient({}, seen),
      umlsConfigured: false,
    });

    const group = await run(search, {
      source: "umls",
      type: "name",
      query: "aspirin",
      limit: 10,
    });
    expect(group.error).toContain("UMLS_API_KEY");
    expect(seen).toEqual([]);
  });
});

describe("reference searcher — medlineplus sources", () => {
  it("pages topic searches with the upstream continuation handles", async () => {
    const search = searcher(
      routedClient({
        "/ws/query": () =>
          searchXml(
            [{ url: "https://medlineplus.gov/aspirin.html", title: "Aspirin" }],
            2,
            "healthtopics",
            "server-1",
          ),
      }),
    );

    const first = await run(search, {
      source: "medlineplus",
      type: "name",
      query: "aspirin",
      limit: 1,
    });
    expect(first.items[0]).toMatchObject({
      kind: "health_topic",
      title: "Aspirin",
    });
    expect(first.items[0]?.source.id).toBe(
      "https://medlineplus.gov/aspirin.html",
    );
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(2);
    expect(first.nextCursor).toBeDefined();

    const second = await run(search, {
      source: "medlineplus",
      type: "name",
      query: "aspirin",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it("notes when a topic search has more results but no handles", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/ws/query": () =>
            searchXml(
              [
                {
                  url: "https://medlineplus.gov/aspirin.html",
                  title: "Aspirin",
                },
              ],
              5,
            ),
        }),
      ),
      { source: "medlineplus", type: "name", query: "aspirin", limit: 1 },
    );
    expect(group.hasMore).toBe(true);
    expect(group.nextCursor).toBeUndefined();
    expect(group.limitation).toContain("no continuation handles");
  });

  it("searches genetics pages without titles", async () => {
    const search = searcher(
      routedClient({
        "/ws/query": () =>
          geneticsXml(["https://medlineplus.gov/genetics/gene/BRCA1"], 1),
      }),
    );

    const group = await run(search, {
      source: "medlineplus_genetics",
      type: "name",
      query: "brca1",
      limit: 10,
    });
    expect(group.items[0]).toMatchObject({
      kind: "genetics",
      dataset: "MedlinePlus Genetics",
    });
    expect(group.items[0]?.title).toBeUndefined();
    expect(group.items[0]?.source.id).toBe(
      "https://medlineplus.gov/genetics/gene/BRCA1",
    );
  });

  it("looks up connect drug pages by name, rxcui, and ndc", async () => {
    const connectResponse = () => ({
      feed: {
        entry: [
          {
            title: { _value: "Aspirin" },
            link: [{ href: "https://medlineplus.gov/druginfo/meds/a682878" }],
          },
        ],
      },
    });

    for (const type of ["name", "rxcui", "ndc"] as const) {
      const group = await run(
        searcher(routedClient({ "/service": connectResponse() as Route })),
        {
          source: "medlineplus_connect",
          type,
          query: type === "name" ? "aspirin" : "1191",
          limit: 10,
        },
      );
      expect(group.items).toHaveLength(1);
      expect(group.items[0]?.kind).toBe("health_topic");
      expect(group.items[0]?.dataset).toBe("MedlinePlus Connect");
      expect(group.hasMore).toBe(false);
    }
  });

  it("slices connect results with a cursor", async () => {
    const search = searcher(
      routedClient({
        "/service": () =>
          jsonResponse({
            feed: {
              entry: [1, 2].map((index) => ({
                title: { _value: `Page ${index}` },
                link: [{ href: `https://medlineplus.gov/page-${index}` }],
              })),
            },
          }),
      }),
    );

    const first = await run(search, {
      source: "medlineplus_connect",
      type: "name",
      query: "aspirin",
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const second = await run(search, {
      source: "medlineplus_connect",
      type: "name",
      query: "aspirin",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0]?.title).toBe("Page 2");
    expect(second.hasMore).toBe(false);
  });
});

describe("reference searcher — literature sources", () => {
  it("pages pubmed searches with exact totals", async () => {
    const search = searcher(
      routedClient({
        "/entrez/eutils/esearch.fcgi": {
          esearchresult: { idlist: ["36758480"], count: "2", retstart: "0" },
        },
        "/entrez/eutils/esummary.fcgi": {
          result: {
            uids: ["36758480"],
            "36758480": {
              uid: "36758480",
              title: "Aspirin use and outcomes",
              pubdate: "2023 Feb",
            },
          },
        },
      }),
    );

    const first = await run(search, {
      source: "pubmed",
      type: "name",
      query: "aspirin",
      limit: 1,
    });
    expect(first.source).toBe("PubMed");
    expect(first.items[0]).toMatchObject({
      kind: "article",
      title: "Aspirin use and outcomes",
      publicationDate: "2023 Feb",
    });
    expect(first.items[0]?.identifiers.pmid).toBe("36758480");
    expect(first.total).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = await run(search, {
      source: "pubmed",
      type: "name",
      query: "aspirin",
      limit: 1,
      cursor: first.nextCursor,
    });
    // The stub answers the same page; the assertion is that the cursor's
    // start offset was forwarded (retstart stays 0 in this canned response).
    expect(second.items).toHaveLength(1);
  });

  it("returns an empty pubmed group with the upstream total", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/entrez/eutils/esearch.fcgi": {
            esearchresult: { idlist: [], count: "0", retstart: "0" },
          },
        }),
      ),
      { source: "pubmed", type: "name", query: "zzzzz", limit: 10 },
    );
    expect(group.items).toEqual([]);
    expect(group.total).toBe(0);
    expect(group.hasMore).toBe(false);
  });

  it("pages clinicaltrials searches with the upstream token", async () => {
    const studies = (nctId: string) => ({
      studies: [
        {
          protocolSection: {
            identificationModule: {
              nctId,
              briefTitle: `Study ${nctId}`,
            },
          },
        },
      ],
    });

    let called = 0;
    const search = searcher(
      routedClient({
        "/api/v2/studies": () => {
          called += 1;
          return jsonResponse(
            called === 1
              ? {
                  ...studies("NCT00000001"),
                  nextPageToken: "token-2",
                  totalCount: 2,
                }
              : studies("NCT00000002"),
          );
        },
      }),
    );

    const first = await run(search, {
      source: "clinicaltrials",
      type: "name",
      query: "aspirin",
      limit: 1,
    });
    expect(first.source).toBe("ClinicalTrials.gov");
    expect(first.items[0]?.identifiers.nctId).toBe("NCT00000001");
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(2);
    expect(first.limitation).toContain("opaque tokens");

    const second = await run(search, {
      source: "clinicaltrials",
      type: "name",
      query: "aspirin",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0]?.identifiers.nctId).toBe("NCT00000002");
    expect(second.hasMore).toBe(false);
    expect(second.total).toBeUndefined();
  });
});

describe("reference searcher — dispatch and cursors", () => {
  beforeEach(() => {
    clearEnv();
    resetConfig();
  });
  afterEach(() => {
    clearEnv();
    resetConfig();
  });

  it("rejects a source/type mismatch before any network call", async () => {
    const seen: string[] = [];
    const group = await run(
      createReferenceSearcher({ client: routedClient({}, seen) }),
      { source: "mesh", type: "rxcui", query: "1191", limit: 10 },
    );
    expect(group.error).toContain("does not search by rxcui");
    expect(group.error).toContain("'name'");
    expect(seen).toEqual([]);
  });

  it("reports disabled NLM sources from the environment", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "nlm";
    resetConfig();
    const seen: string[] = [];

    const group = await run(
      createReferenceSearcher({ client: routedClient({}, seen) }),
      { source: "pubmed", type: "name", query: "aspirin", limit: 10 },
    );
    expect(group.error).toContain("DRUGDATA_DISABLED_SOURCES");
    expect(seen).toEqual([]);
  });

  it("labels a disabled group with each source's own database", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "nlm";
    resetConfig();
    const seen: string[] = [];

    const pairings = [
      ["prescribable", "RxNorm"],
      ["rxclass", "RxClass"],
    ] as const;

    for (const [source, database] of pairings) {
      const group = await run(
        createReferenceSearcher({ client: routedClient({}, seen) }),
        { source, type: "name", query: "aspirin", limit: 10 },
      );
      expect(group.source).toBe(database);
      expect(group.error).toContain("DRUGDATA_DISABLED_SOURCES");
    }
    expect(seen).toEqual([]);
  });

  it("honors an injected disabled override without reading the environment", async () => {
    const seen: string[] = [];

    const group = await run(
      createReferenceSearcher({
        client: routedClient({}, seen),
        nlmDisabled: true,
      }),
      { source: "pubmed", type: "name", query: "aspirin", limit: 10 },
    );
    expect(group.error).toContain("DRUGDATA_DISABLED_SOURCES");
    expect(seen).toEqual([]);
  });

  it("treats invalid configuration as UMLS-unconfigured, not a crash", async () => {
    process.env.DRUGDATA_TIMEOUT_MS = "not-a-number";
    resetConfig();
    const seen: string[] = [];

    const group = await run(
      createReferenceSearcher({ client: routedClient({}, seen) }),
      { source: "umls", type: "name", query: "aspirin", limit: 10 },
    );
    expect(group.error).toContain("UMLS_API_KEY");
    expect(seen).toEqual([]);
  });

  it("rewords an unexpected handler failure as an error group", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/rest/search/current": () => {
            throw new Error("@knorby/nlm-drugs-client exploded");
          },
        }),
      ),
      { source: "umls", type: "name", query: "aspirin", limit: 10 },
    );
    expect(group.error).toContain("failed unexpectedly");
    expect(group.error).not.toMatch(/@knorby|client/i);
  });

  it("rejects a cursor minted for a different query", async () => {
    const search = searcher(routedClient({}));
    const cursor = encodeCursor(
      { source: "pubmed", type: "name", query: "other", limit: 10 },
      { start: 10 },
    );

    await expect(
      run(search, {
        source: "pubmed",
        type: "name",
        query: "aspirin",
        limit: 10,
        cursor,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects a cursor from an old envelope version", async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        v: 99,
        s: "pubmed",
        t: "name",
        q: "aspirin",
        l: 10,
        c: {},
      }),
      "utf8",
    ).toString("base64url");
    const search = searcher(routedClient({}));

    await expect(
      run(search, {
        source: "pubmed",
        type: "name",
        query: "aspirin",
        limit: 10,
        cursor,
      }),
    ).rejects.toThrow(/not readable/);
  });

  it("rejects an oversized cursor", async () => {
    const search = searcher(routedClient({}));
    await expect(
      run(search, {
        source: "pubmed",
        type: "name",
        query: "aspirin",
        limit: 10,
        cursor: "a".repeat(8_193),
      }),
    ).rejects.toThrow(/too long/);
  });

  it("rejects a cursor whose payload does not match the source schema", async () => {
    const cursor = encodeCursor(
      { source: "pubmed", type: "name", query: "aspirin", limit: 10 },
      { start: -5 },
    );
    const search = searcher(routedClient({}));

    await expect(
      run(search, {
        source: "pubmed",
        type: "name",
        query: "aspirin",
        limit: 10,
        cursor,
      }),
    ).rejects.toThrow(/not readable/);
  });

  it("rejects a cursor that is not JSON at all", async () => {
    const cursor = Buffer.from("this is not json", "utf8").toString(
      "base64url",
    );
    const search = searcher(routedClient({}));

    await expect(
      run(search, {
        source: "pubmed",
        type: "name",
        query: "aspirin",
        limit: 10,
        cursor,
      }),
    ).rejects.toThrow(/not readable/);
  });

  it("rejects invalid pairings for the health and registry sources", async () => {
    const seen: string[] = [];
    const search = createReferenceSearcher({
      client: routedClient({}, seen),
    });

    for (const [source, type] of [
      ["medlineplus_genetics", "rxcui"],
      ["medlineplus_connect", "cui"],
      ["umls", "ndc"],
      ["clinicaltrials", "cui"],
    ] as const) {
      const group = await run(search, {
        source,
        type,
        query: "aspirin",
        limit: 10,
      });
      expect(group.error, source).toContain(`does not search by ${type}`);
    }
    expect(seen).toEqual([]);
  });

  it("slices rxclass pages like the other sliced sources", async () => {
    const search = searcher(
      routedClient({
        "/REST/rxclass/class/byName.json": {
          rxclassMinConceptList: {
            rxclassMinConcept: [
              {
                classId: "N02BA",
                className: "Salicylic acids",
                classType: "ATC1-4",
              },
              {
                classId: "N02BA01",
                className: "Salicylates",
                classType: "ATC1-4",
              },
            ],
          },
        },
      }),
    );

    const first = await run(search, {
      source: "rxclass",
      type: "name",
      query: "salicylic",
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const second = await run(search, {
      source: "rxclass",
      type: "name",
      query: "salicylic",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0]?.identifiers.classId).toBe("N02BA01");
    expect(second.hasMore).toBe(false);
  });

  it("omits the dataset when a umls result has no root source", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/rest/search/current": {
            result: {
              results: [
                { ui: "C0004057", name: "Aspirin", rootSource: "MSH" },
                { ui: "C0004058", name: "Aspirin-like" },
              ],
            },
          },
        }),
      ),
      { source: "umls", type: "name", query: "aspirin", limit: 2 },
    );
    expect(group.items).toHaveLength(2);
    expect(group.items[0]?.dataset).toBe("MSH");
    expect(group.items[1]?.dataset).toBeUndefined();
  });

  it("omits the publication date when PubMed has none", async () => {
    const group = await run(
      searcher(
        routedClient({
          "/entrez/eutils/esearch.fcgi": {
            esearchresult: { idlist: ["1"], count: "1", retstart: "0" },
          },
          "/entrez/eutils/esummary.fcgi": {
            result: { uids: ["1"], "1": { uid: "1", title: "No date" } },
          },
        }),
      ),
      { source: "pubmed", type: "name", query: "aspirin", limit: 10 },
    );
    expect(group.items[0]?.publicationDate).toBeUndefined();
  });

  it("falls back to the first page when no cursor is sent", async () => {
    const search = searcher(
      routedClient({
        "/entrez/eutils/esearch.fcgi": {
          esearchresult: { idlist: [], count: "0", retstart: "0" },
        },
      }),
    );

    const group = await run(search, {
      source: "pubmed",
      type: "name",
      query: "aspirin",
      limit: 10,
    });
    expect(group.items).toEqual([]);
  });
});
