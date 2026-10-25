import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo, logWarn } from "../src/lib/log.js";

/** Logging is stderr-only: stdout carries the JSON-RPC stream. */
describe("logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes info lines to stderr", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logInfo("hello");

    expect(write).toHaveBeenCalledWith("hello\n");
  });

  it("prefixes warnings", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logWarn("slow");

    expect(write).toHaveBeenCalledWith("warn: slow\n");
  });

  it("prefixes errors and appends a cause's stack", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logError("failed", new Error("boom"));

    const line = String(write.mock.calls[0]?.[0]);
    expect(line.startsWith("error: failed ")).toBe(true);
    expect(line).toContain("boom");
  });

  it("falls back to the message when a cause has no stack", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const cause = new Error("no stack here");
    cause.stack = undefined;

    logError("failed", cause);

    expect(write).toHaveBeenCalledWith("error: failed no stack here\n");
  });

  it("ignores a cause that is not an Error", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logError("failed", "a string");

    expect(write).toHaveBeenCalledWith("error: failed\n");
  });
});
