import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Config,
  readConfig,
  resetConfig,
  SOURCE_IDS,
} from "../src/config.js";
import { DEFAULT_TIMEOUT_MS } from "../src/constants.js";

const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function readOk(): Config {
  const result = readConfig();
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

describe("readConfig", () => {
  beforeEach(() => {
    clearEnv();
    resetConfig();
  });

  afterEach(() => {
    clearEnv();
    resetConfig();
  });

  it("applies defaults when no variables are set", () => {
    const config = readOk();

    expect(config.OPENFDA_API_KEY).toBeUndefined();
    expect(config.DSLD_API_KEY).toBeUndefined();
    expect(config.DRUGDATA_TIMEOUT_MS).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.DRUGDATA_DISABLED_SOURCES).toEqual([]);
    expect(SOURCE_IDS).toHaveLength(6);
  });

  it("parses keys, a timeout, and a comma-separated disabled list", () => {
    process.env.OPENFDA_API_KEY = "  openfda-key  ";
    process.env.DSLD_API_KEY = "dsld-key";
    process.env.DRUGDATA_TIMEOUT_MS = "45000";
    process.env.DRUGDATA_DISABLED_SOURCES = " OpenFDA , ,inkeedecoder ";

    const config = readOk();

    expect(config.OPENFDA_API_KEY).toBe("openfda-key");
    expect(config.DSLD_API_KEY).toBe("dsld-key");
    expect(config.DRUGDATA_TIMEOUT_MS).toBe(45_000);
    expect(config.DRUGDATA_DISABLED_SOURCES).toEqual([
      "openfda",
      "inkeedecoder",
    ]);
  });

  it("treats blank keys as unset", () => {
    process.env.OPENFDA_API_KEY = "   ";
    process.env.DSLD_API_KEY = "";

    const config = readOk();

    expect(config.OPENFDA_API_KEY).toBeUndefined();
    expect(config.DSLD_API_KEY).toBeUndefined();
  });

  it("treats a blank timeout as unset", () => {
    process.env.DRUGDATA_TIMEOUT_MS = "   ";

    const config = readOk();

    expect(config.DRUGDATA_TIMEOUT_MS).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("rejects a timeout that is not a positive integer", () => {
    process.env.DRUGDATA_TIMEOUT_MS = "0";

    const result = readConfig();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a configuration error");
    expect(result.error).toContain("DRUGDATA_TIMEOUT_MS");
  });

  it("rejects unknown source ids", () => {
    process.env.DRUGDATA_DISABLED_SOURCES = "openfda,not-a-source";

    const result = readConfig();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a configuration error");
    expect(result.error).toContain("DRUGDATA_DISABLED_SOURCES");
  });

  it("caches until resetConfig clears it", () => {
    const first = readOk();
    process.env.OPENFDA_API_KEY = "later-key";

    expect(readOk()).toBe(first);

    resetConfig();
    const second = readOk();
    expect(second).not.toBe(first);
    expect(second.OPENFDA_API_KEY).toBe("later-key");
  });
});
