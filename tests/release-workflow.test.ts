import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the release workflow's registry-publication contract. Registry
 * publication must survive a skipped or failed release job, verify the npm
 * artifact, and read back the stored registry record before succeeding.
 */
const workflowUrl = new URL(
  "../.github/workflows/release.yml",
  import.meta.url,
);
const workflow = existsSync(workflowUrl)
  ? readFileSync(workflowUrl, "utf8")
  : "";

const registryJobStart = workflow.indexOf("  mcp-registry:\n");
const registryJob =
  registryJobStart === -1 ? "" : workflow.slice(registryJobStart);
const releaseJob =
  registryJobStart === -1
    ? workflow.slice(workflow.indexOf("  release:\n"))
    : workflow.slice(workflow.indexOf("  release:\n"), registryJobStart);

describe("release workflow registry contract", () => {
  it("runs registry publication after any release outcome", () => {
    expect(workflow).toContain("  mcp-registry:\n    needs: [check, release]");
    expect(workflow).toContain(
      "if: always() && needs.check.result == 'success'",
    );
    expect(registryJob).not.toContain("needs.release.result == 'success'");
  });

  it("keeps registry publication least-privileged and environment-free", () => {
    expect(registryJob).toContain("contents: read");
    expect(registryJob).toContain("id-token: write");
    expect(registryJob).not.toMatch(/\n {4}environment:/);
    expect(registryJob).not.toContain(
      "id-token: write # OIDC trusted publishing + provenance",
    );
  });

  it("skips an existing version and fails unexpected registry statuses", () => {
    expect(registryJob).toContain(
      "steps.registry.outputs.published == 'false'",
    );
    expect(registryJob).toContain("published=true");
    expect(registryJob).toContain("published=false");
    expect(registryJob).toContain("200");
    expect(registryJob).toContain("404");
  });

  it("uses a pinned, verified publisher and verifies the published record", () => {
    expect(registryJob).toContain("MCP_PUBLISHER_VERSION: v1.8.9");
    expect(registryJob).not.toContain("releases/latest");
    expect(registryJob).toContain("cosign verify-blob");
    expect(registryJob.indexOf("./mcp-publisher validate")).toBeLessThan(
      registryJob.indexOf("./mcp-publisher login github-oidc"),
    );
    expect(
      registryJob.indexOf("./mcp-publisher login github-oidc"),
    ).toBeLessThan(registryJob.indexOf("./mcp-publisher publish"));
    expect(registryJob.indexOf("./mcp-publisher publish")).toBeLessThan(
      registryJob.indexOf("--output registry.json"),
    );
  });

  it("checks npm ownership and leaves registry steps out of the release job", () => {
    expect(registryJob).toContain("mcpName");
    expect(registryJob).toContain("npm.json");
    expect(releaseJob).not.toContain("./mcp-publisher");
  });

  it("accepts registry-omitted false defaults without accepting package drift", () => {
    expect(registryJob).toContain(
      "node scripts/check-registry-record.mjs server.json registry.json",
    );

    const directory = mkdtempSync(join(tmpdir(), "registry-record-"));
    const localPath = join(directory, "server.json");
    const registryPath = join(directory, "registry.json");
    const scriptPath = new URL(
      "../scripts/check-registry-record.mjs",
      import.meta.url,
    ).pathname;

    const localServer = {
      name: "io.github.knorby/open-drug-data-mcp",
      version: "0.1.0",
      packages: [
        {
          registryType: "npm",
          identifier: "@knorby/open-drug-data-mcp",
          version: "0.1.0",
          transport: { type: "stdio" },
          environmentVariables: [
            {
              name: "DRUGDATA_TIMEOUT_MS",
              description: "Per-request timeout in milliseconds.",
              isRequired: false,
              format: "number",
              isSecret: false,
            },
          ],
        },
      ],
    };
    const normalizedByRegistry = {
      server: {
        name: "io.github.knorby/open-drug-data-mcp",
        version: "0.1.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@knorby/open-drug-data-mcp",
            version: "0.1.0",
            transport: { type: "stdio" },
            environmentVariables: [
              {
                name: "DRUGDATA_TIMEOUT_MS",
                description: "Per-request timeout in milliseconds.",
                format: "number",
              },
            ],
          },
        ],
      },
    };

    writeFileSync(localPath, JSON.stringify(localServer));
    writeFileSync(registryPath, JSON.stringify(normalizedByRegistry));
    const accepted = spawnSync(process.execPath, [
      scriptPath,
      localPath,
      registryPath,
    ]);
    expect(accepted.status).toBe(0);

    const driftedByRegistry = {
      ...normalizedByRegistry,
      server: {
        ...normalizedByRegistry.server,
        packages: normalizedByRegistry.server.packages.map((pkg) => ({
          ...pkg,
          environmentVariables: pkg.environmentVariables.map((variable) => ({
            ...variable,
            isSecret: true,
          })),
        })),
      },
    };
    writeFileSync(registryPath, JSON.stringify(driftedByRegistry));
    const rejected = spawnSync(
      process.execPath,
      [scriptPath, localPath, registryPath],
      { encoding: "utf8" },
    );
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("published registry packages differs");
  });
});
