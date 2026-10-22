import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHARACTER_LIMIT,
  DEFAULT_TIMEOUT_MS,
  readPackageVersion,
  SERVER_NAME,
  SERVER_VERSION,
} from "../src/constants.js";

describe("constants", () => {
  it("advertises the package identity", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(SERVER_NAME).toBe("open-drug-data-mcp");
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(CHARACTER_LIMIT).toBe(25_000);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it("reads the version from a manifest", () => {
    expect(readPackageVersion(() => '{"version":"1.2.3"}')).toBe("1.2.3");
  });

  it("falls back when the version is missing, empty, or not a string", () => {
    expect(readPackageVersion(() => "{}")).toBe("0.0.0");
    expect(readPackageVersion(() => '{"version":""}')).toBe("0.0.0");
    expect(readPackageVersion(() => '{"version":42}')).toBe("0.0.0");
  });

  it("falls back when the manifest cannot be read or parsed", () => {
    expect(
      readPackageVersion(() => {
        throw new Error("unreadable");
      }),
    ).toBe("0.0.0");
    expect(readPackageVersion(() => "not json")).toBe("0.0.0");
  });
});
