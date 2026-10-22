import { describe, expect, it } from "vitest";
import { CHARACTER_LIMIT } from "../src/constants.js";
import {
  applyCharacterLimit,
  boundStructured,
  morePagesNote,
  truncationNote,
} from "../src/lib/format.js";

describe("applyCharacterLimit", () => {
  it("returns text within the limit unchanged", () => {
    expect(applyCharacterLimit("short", 100)).toBe("short");
  });

  it("truncates text over the limit and appends an actionable note", () => {
    const bounded = applyCharacterLimit("x".repeat(200), 100);

    expect(bounded.length).toBeLessThanOrEqual(100);
    expect(bounded).toContain("[Response truncated.");
    expect(bounded).toContain("read a later page");
    expect(bounded.startsWith("x")).toBe(true);
  });

  it("uses CHARACTER_LIMIT by default", () => {
    const bounded = applyCharacterLimit("x".repeat(CHARACTER_LIMIT + 1));

    expect(bounded.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(bounded).toContain("[Response truncated.");
  });

  it("does not keep content when the limit is smaller than the note", () => {
    const bounded = applyCharacterLimit("x".repeat(30), 20);

    expect(bounded.startsWith("x")).toBe(false);
    expect(bounded).toContain("[Response truncated.");
  });
});

describe("boundStructured", () => {
  it("leaves a value within the limit untouched", () => {
    const value = { a: 1, list: ["x", "y"] };

    const result = boundStructured(value, 1_000);

    expect(result.truncated).toBe(false);
    expect(result.value).toBe(value);
  });

  it("shortens long strings and trims arrays without dropping fields or changing types", () => {
    const long = "x".repeat(30_000);
    const value = {
      name: long,
      short: "hello",
      n: 42,
      ok: true,
      nil: null,
      nested: { deep: long },
      list: Array.from({ length: 300 }, (_, index) => index),
    };

    const result = boundStructured(value);

    expect(result.truncated).toBe(true);
    const bounded = result.value as typeof value;
    expect(bounded.name.endsWith("…[truncated]")).toBe(true);
    expect(bounded.name.length).toBeLessThan(long.length);
    expect(bounded.short).toBe("hello");
    expect(bounded.n).toBe(42);
    expect(bounded.ok).toBe(true);
    expect(bounded.nil).toBeNull();
    expect(bounded.nested.deep.endsWith("…[truncated]")).toBe(true);
    expect(bounded.list).toHaveLength(200);
    expect(bounded.list[0]).toBe(0);
    expect(JSON.stringify(result.value).length).toBeLessThanOrEqual(
      CHARACTER_LIMIT,
    );
  });

  it("steps down progressively until the value fits", () => {
    const value = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `field${index}`,
        "x".repeat(9_000),
      ]),
    );

    const result = boundStructured(value);

    expect(result.truncated).toBe(true);
    const bounded = result.value as Record<string, string>;
    expect(bounded.field0?.length).toBeLessThanOrEqual(2_000 + 15);
    expect(JSON.stringify(result.value).length).toBeLessThanOrEqual(
      CHARACTER_LIMIT,
    );
  });

  it("reports truncation even when oversized keys keep the value over the limit", () => {
    const value = { ["k".repeat(30_000)]: 1 };

    const result = boundStructured(value, 1_000);

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.value).length).toBeGreaterThan(1_000);
  });
});

describe("truncationNote", () => {
  it("names the default limit", () => {
    expect(truncationNote()).toContain("25,000-character");
  });

  it("names a custom limit", () => {
    expect(truncationNote(1_000)).toContain("1,000-character");
  });
});

describe("morePagesNote", () => {
  it("points at the next page when more results exist", () => {
    expect(morePagesNote(true, 3)).toContain("page: 3");
  });

  it("is empty when there are no more results", () => {
    expect(morePagesNote(false, 3)).toBe("");
  });
});
