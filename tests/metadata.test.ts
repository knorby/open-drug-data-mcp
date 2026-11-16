import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Pins package.json and server.json to one release version. The Official MCP
 * Registry rejects publishes whose name/version drift from the npm package, so
 * a release that updates only one file fails here instead of at publish time.
 */

const REGISTRY_NAME = "io.github.knorby/open-drug-data-mcp";
const REGISTRY_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  name: string;
  version: string;
  mcpName?: string;
};

const serverUrl = new URL("../server.json", import.meta.url);
const serverJson = (
  existsSync(serverUrl) ? JSON.parse(readFileSync(serverUrl, "utf8")) : {}
) as {
  $schema?: string;
  name?: string;
  version?: string;
  description?: string;
  packages?: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
  }>;
};

describe("distribution metadata consistency", () => {
  it("package.json carries the registry ownership marker", () => {
    expect(pkg.mcpName).toBe(REGISTRY_NAME);
  });

  it("server.json name matches package.json mcpName", () => {
    expect(serverJson.name).toBe(pkg.mcpName);
  });

  it("server.json version matches package.json version", () => {
    expect(serverJson.version).toBe(pkg.version);
  });

  it("server.json references the pinned registry schema", () => {
    expect(serverJson.$schema).toBe(REGISTRY_SCHEMA);
  });

  it("server.json npm package entry matches package.json name and version", () => {
    expect(serverJson.packages).toHaveLength(1);
    const entry = serverJson.packages?.[0];
    expect(entry?.registryType).toBe("npm");
    expect(entry?.identifier).toBe(pkg.name);
    expect(entry?.version).toBe(pkg.version);
    expect(entry?.transport).toEqual({ type: "stdio" });
  });

  it("server.json description fits the registry's 100-character limit", () => {
    expect(serverJson.description?.length).toBeLessThanOrEqual(100);
  });
});
