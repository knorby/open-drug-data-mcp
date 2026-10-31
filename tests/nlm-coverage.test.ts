import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import { ingredientEntitySearchResultSchema } from "../src/lib/schemas.js";
import {
  createTestClient,
  jsonResponse,
  type TestHarness,
  textOf,
} from "./helpers.js";

/**
 * The NLM coverage matrix.
 *
 * `@knorby/nlm-drugs-client` exposes fourteen namespaces; this file drives
 * every one of them through the real MCP tools with the default wiring —
 * the shared client, lazy configuration, and the real handlers — with only
 * `fetch` stubbed to fixture-shaped responses. A namespace that only exists
 * in unit tests is not covered; this test is the proof the whole client is
 * wired in.
 */

const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
  "UMLS_API_KEY",
  "NLM_PUBMED_API_KEY",
  "NLM_PUBMED_EMAIL",
  "NLM_PUBMED_TOOL",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/xml" },
  });
}

/**
 * Routes every host the NLM client contacts to a fixture-shaped response.
 *
 * The bodies mirror the upstream parse shapes documented in the client:
 * RxNav id groups, DailyMed SPL pages, wsearch XML, the E-utilities JSON,
 * the MedlinePlus Connect feed, UTS results, ClinicalTrials.gov studies,
 * and PUG REST compounds.
 */
function routedFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    switch (url.hostname) {
      case "rxnav.nlm.nih.gov":
        if (url.pathname === "/REST/rxcui.json") {
          return jsonResponse({ idGroup: { rxnormId: ["1191"] } });
        }
        if (url.pathname === "/REST/Prescribe/rxcui.json") {
          return jsonResponse({ idGroup: { rxnormId: ["1191"] } });
        }
        if (url.pathname === "/REST/Prescribe/rxcui/1191/properties.json") {
          return jsonResponse({
            properties: { rxcui: "1191", name: "Aspirin", tty: "IN" },
          });
        }
        if (url.pathname === "/REST/rxclass/class/byName.json") {
          return jsonResponse({
            rxclassMinConceptList: {
              rxclassMinConcept: [
                {
                  classId: "N02BA",
                  className: "Salicylic acids",
                  classType: "ATC1-4",
                },
              ],
            },
          });
        }
        if (url.pathname === "/REST/RxTerms/rxcui/1191/allinfo.json") {
          return jsonResponse({
            rxtermsProperties: {
              rxcui: "1191",
              displayName: "aspirin",
              fullName: "aspirin 81 MG Oral Tablet",
            },
          });
        }
        if (url.pathname === "/REST/rxcui/1191/properties.json") {
          return jsonResponse({
            properties: { rxcui: "1191", name: "Aspirin", tty: "IN" },
          });
        }
        if (url.pathname === "/REST/rxcui/1191/ndcs.json") {
          return jsonResponse({ ndcGroup: {} });
        }
        break;
      case "dailymed.nlm.nih.gov":
        if (url.pathname === "/dailymed/services/v2/spls.json") {
          return jsonResponse({
            data: [
              {
                setid: "a1e07d5c-2056-46f3-8737-f03ed0b4bae8",
                title: "Aspirin",
                spl_version: 12,
              },
            ],
            metadata: { current_page: 1, total_pages: 1, total_elements: 1 },
          });
        }
        break;
      case "id.nlm.nih.gov":
        if (url.pathname === "/mesh/lookup/descriptor") {
          return jsonResponse([
            {
              resource: "http://id.nlm.nih.gov/mesh/D014810",
              label: "Aspirin",
            },
          ]);
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
      case "wsearch.nlm.nih.gov":
        if (url.pathname === "/ws/query") {
          const isGenetics = url.searchParams.get("db") === "ghr";
          return isGenetics
            ? xmlResponse(
                `<search_results count="1"><result><url>https://medlineplus.gov/genetics/gene/BRCA1</url></result></search_results>`,
              )
            : xmlResponse(
                `<nlmSearchResult><count>1</count><list><document url="https://medlineplus.gov/aspirin.html"><content name="title">Aspirin</content></document></list></nlmSearchResult>`,
              );
        }
        break;
      case "connect.medlineplus.gov":
        if (url.pathname === "/service") {
          return jsonResponse({
            feed: {
              entry: [
                {
                  title: { _value: "Aspirin" },
                  link: [
                    { href: "https://medlineplus.gov/druginfo/meds/a682878" },
                  ],
                },
              ],
            },
          });
        }
        break;
      case "uts-ws.nlm.nih.gov":
        if (url.pathname === "/rest/search/current") {
          return jsonResponse({
            result: {
              results: [{ ui: "C0004057", name: "Aspirin", rootSource: "MSH" }],
            },
          });
        }
        break;
      case "clinicaltrials.gov":
        if (url.pathname === "/api/v2/studies") {
          return jsonResponse({
            studies: [
              {
                protocolSection: {
                  identificationModule: {
                    nctId: "NCT00000001",
                    briefTitle: "Aspirin study",
                  },
                },
              },
            ],
            totalCount: 1,
          });
        }
        break;
      case "pubchem.ncbi.nlm.nih.gov":
        if (url.pathname === "/rest/pug/compound/name/aspirin/cids/JSON") {
          return jsonResponse({ IdentifierList: { CID: [2244] } });
        }
        if (url.pathname.startsWith("/rest/pug/compound/cid/2244/property/")) {
          return jsonResponse({
            PropertyTable: {
              Properties: [
                {
                  CID: 2244,
                  IUPACName: "2-acetyloxybenzoic acid",
                  MolecularFormula: "C9H8O4",
                  MolecularWeight: "180.16",
                  InChIKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
                },
              ],
            },
          });
        }
        break;
      default:
        break;
    }
    throw new Error(
      `unexpected coverage-matrix request: ${url.hostname}${url.pathname}`,
    );
  }) as unknown as typeof fetch;
}

describe("NLM coverage matrix", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
    process.env.UMLS_API_KEY = "matrix-test-key";
    resetConfig();
    vi.stubGlobal("fetch", routedFetch());
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    vi.unstubAllGlobals();
    clearEnv();
    resetConfig();
    resetClients();
  });

  it("serves rxNorm, dailyMed, identifiers, and rxTerms through the existing tools", async () => {
    harness = await createTestClient();

    // rxNorm + dailyMed: the product search fan-out.
    const products = await harness.client.callTool({
      name: "drugdata_search_products",
      arguments: { type: "name", query: "aspirin" },
    });
    const productGroups = (
      products.structuredContent as {
        groups: { source: string; items: unknown[] }[];
      }
    ).groups;
    const sources = productGroups.map((group) => group.source);
    expect(sources).toContain("RxNorm");
    expect(sources).toContain("DailyMed");

    // identifiers: the UNII bridge routes through rxNorm findRxcuiById.
    const resolved = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "unii", query: "R16CO5Y76E" },
    });
    const ingredientRecords = ingredientEntitySearchResultSchema
      .parse(resolved.structuredContent)
      .entities.flatMap((entity) => entity.records);
    expect(
      ingredientRecords.filter((record) => record.source.database === "RxNorm"),
    ).toHaveLength(1);

    // rxTerms: the RxNorm ingredient profile embeds the presentation.
    const ingredient = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "nlm", id: "1191" },
    });
    const profile = (
      ingredient.structuredContent as {
        profile: {
          rxTerm?: { displayName: string; source: { database: string } };
        };
      }
    ).profile;
    expect(profile.rxTerm?.displayName).toBe("aspirin");
    expect(profile.rxTerm?.source.database).toBe("RxTerms");
  });

  it("serves every reference source through drugdata_search_references", async () => {
    harness = await createTestClient();

    const cases: ReadonlyArray<{
      source: string;
      expected: string;
    }> = [
      { source: "prescribable", expected: "Aspirin" },
      { source: "rxclass", expected: "Salicylic acids" },
      { source: "mesh", expected: "Aspirin" },
      { source: "pubmed", expected: "Aspirin use and outcomes" },
      { source: "medlineplus", expected: "Aspirin" },
      { source: "medlineplus_genetics", expected: "medlineplus.gov/genetics" },
      { source: "medlineplus_connect", expected: "Aspirin" },
      { source: "umls", expected: "Aspirin" },
      { source: "clinicaltrials", expected: "Aspirin study" },
    ];

    for (const { source, expected } of cases) {
      const result = await harness.client.callTool({
        name: "drugdata_search_references",
        arguments: { source, query: "aspirin", limit: 5 },
      });
      expect(result.isError, source).toBeFalsy();
      const output = result.structuredContent as {
        groups: { items: unknown[]; error?: string }[];
      };
      const group = output.groups[0];
      expect(group?.error, source).toBeUndefined();
      expect(group?.items.length ?? 0, source).toBeGreaterThan(0);
      expect(textOf(result), source).toContain(expected);
    }
  });

  it("serves pubChem through the ingredient fan-out and lookups", async () => {
    harness = await createTestClient();

    const searched = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "name", query: "aspirin" },
    });
    const records = ingredientEntitySearchResultSchema
      .parse(searched.structuredContent)
      .entities.flatMap((entity) => entity.records);
    const pubchem = records.filter(
      (record) => record.source.database === "PubChem",
    );
    expect(pubchem).toHaveLength(1);
    expect(pubchem[0]?.name).toBe("aspirin");

    const byCid = await harness.client.callTool({
      name: "drugdata_search_ingredients",
      arguments: { type: "cid", query: "2244" },
    });
    const cidRecords = ingredientEntitySearchResultSchema
      .parse(byCid.structuredContent)
      .entities.flatMap((entity) => entity.records);
    expect(
      cidRecords.filter((record) => record.source.database === "PubChem"),
    ).toHaveLength(1);

    const looked = await harness.client.callTool({
      name: "drugdata_get_ingredient",
      arguments: { source: "pubchem", id: "2244" },
    });
    const profile = (
      looked.structuredContent as {
        profile: { chemistry?: { molecularFormula?: string } };
      }
    ).profile;
    expect(profile.chemistry?.molecularFormula).toBe("C9H8O4");
    expect(textOf(looked)).toContain("### Chemistry");
  });
});
