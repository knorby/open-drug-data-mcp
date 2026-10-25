import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, SOURCE_IDS, type SourceId } from "../src/config.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/constants.js";
import { createTestClient, type TestHarness, textOf } from "./helpers.js";

/**
 * `drugdata_ping` is the diagnostics tool: it reports the server identity and
 * which sources this process will use, without a credential or a network call.
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

interface PingOutput {
  ok: boolean;
  server: { name: string; version: string };
  sources: { id: SourceId; enabled: boolean; configured: boolean }[];
  referenceSources: { umlsConfigured: boolean; pubmedConfigured: boolean };
}

describe("drugdata_ping", () => {
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

  it("reports server identity and source enablement", async () => {
    harness = await createTestClient();

    const result = await harness.client.callTool({
      name: "drugdata_ping",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as PingOutput;
    expect(output.ok).toBe(true);
    expect(output.server).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    expect(output.server.name).toBe("open-drug-data-mcp");
    expect(output.sources).toHaveLength(6);
    expect(output.sources.map((source) => source.id)).toEqual([...SOURCE_IDS]);
    const configured = Object.fromEntries(
      output.sources.map((source) => [source.id, source.configured]),
    );
    expect(configured).toEqual({
      openfda: false,
      cosing: true,
      nlm: true,
      drugcentral: true,
      dsld: false,
      inkeedecoder: true,
    });
    for (const source of output.sources) {
      expect(source.enabled).toBe(true);
    }
    expect(output.referenceSources).toEqual({
      umlsConfigured: false,
      pubmedConfigured: false,
    });
  });

  it("disables the sources named in DRUGDATA_DISABLED_SOURCES", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "openfda, inkeedecoder";
    resetConfig();
    harness = await createTestClient();

    const result = await harness.client.callTool({
      name: "drugdata_ping",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as PingOutput;
    expect(output.sources.map((source) => [source.id, source.enabled])).toEqual(
      [
        ["openfda", false],
        ["cosing", true],
        ["nlm", true],
        ["drugcentral", true],
        ["dsld", true],
        ["inkeedecoder", false],
      ],
    );
    const text = textOf(result);
    expect(text).toContain("openFDA: disabled");
    expect(text).toContain("CosIng: enabled");
  });

  it("reports key configuration without echoing the keys", async () => {
    process.env.OPENFDA_API_KEY = "openfda-secret";
    process.env.DSLD_API_KEY = "dsld-secret";
    resetConfig();
    harness = await createTestClient();

    const result = await harness.client.callTool({
      name: "drugdata_ping",
      arguments: {},
    });

    const output = result.structuredContent as PingOutput;
    const configured = Object.fromEntries(
      output.sources.map((source) => [source.id, source.configured]),
    );
    expect(configured).toEqual({
      openfda: true,
      cosing: true,
      nlm: true,
      drugcentral: true,
      dsld: true,
      inkeedecoder: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("openfda-secret");
    expect(serialized).not.toContain("dsld-secret");
  });

  it("reports UMLS and PubMed reference configuration without echoing keys", async () => {
    process.env.UMLS_API_KEY = "umls-secret";
    process.env.NLM_PUBMED_API_KEY = "pubmed-secret";
    resetConfig();
    harness = await createTestClient();

    const result = await harness.client.callTool({
      name: "drugdata_ping",
      arguments: {},
    });

    const output = result.structuredContent as PingOutput;
    expect(output.referenceSources).toEqual({
      umlsConfigured: true,
      pubmedConfigured: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("umls-secret");
    expect(serialized).not.toContain("pubmed-secret");
  });

  it("echoes an optional message in the text response", async () => {
    harness = await createTestClient();

    const result = await harness.client.callTool({
      name: "drugdata_ping",
      arguments: { message: "hi" },
    });

    expect(textOf(result)).toContain("pong: hi");
  });

  it("still lists tools when configuration is invalid, and reports it", async () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "not-a-source";
    resetConfig();
    harness = await createTestClient();

    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("drugdata_ping");

    const result = await harness.client.callTool({
      name: "drugdata_ping",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("DRUGDATA_DISABLED_SOURCES");
  });
});
