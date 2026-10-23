import { describe, expect, it } from "vitest";
import { isUnii, normalizeNdc, normalizeSlug } from "../src/lib/ids.js";

describe("normalizeNdc", () => {
  it("pads a 4-4-2 labeler NDC to the canonical 5-4-2 form", () => {
    expect(normalizeNdc("0093-1046-01")).toBe("00093104601");
  });

  it("pads a 5-3-2 labeler NDC to the canonical 5-4-2 form", () => {
    expect(normalizeNdc("00093-104-61")).toBe("00093010461");
  });

  it("pads a 5-4-1 labeler NDC to the canonical 5-4-2 form", () => {
    expect(normalizeNdc("00093-1046-1")).toBe("00093104601");
  });

  it("accepts an already-canonical dashed 5-4-2 NDC", () => {
    expect(normalizeNdc("00093-1046-01")).toBe("00093104601");
  });

  it("passes an 11-digit bare NDC through unchanged", () => {
    expect(normalizeNdc("00093010461")).toBe("00093010461");
  });

  it("treats a 10-digit bare NDC as 4-4-2 and pads it", () => {
    expect(normalizeNdc("0093104601")).toBe("00093104601");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNdc("  0093-1046-01  ")).toBe("00093104601");
  });

  it("returns null for empty, malformed, or unparseable input", () => {
    for (const input of [
      "",
      "   ",
      "hello",
      "0093-1046",
      "009310460",
      "0093-1046-001",
      "009-3104-601",
      "0093-1046-0",
      "0093-1046-01-1",
      "0a93-1046-01",
      "0093-10a6-01",
      "0093-1046-0a",
      "12345",
      "000931046011",
      "１２３４５６７８９０",
    ]) {
      expect(normalizeNdc(input), input).toBeNull();
    }
  });
});

describe("isUnii", () => {
  it("accepts a 10-character alphanumeric UNII", () => {
    expect(isUnii("A1B2C3D4E5")).toBe(true);
  });

  it("rejects values that are not 10 alphanumeric characters", () => {
    expect(isUnii("hello")).toBe(false);
    expect(isUnii("A1B2C3D4E")).toBe(false);
    expect(isUnii("A1B2C3D4E56")).toBe(false);
    expect(isUnii("A1B2C3D4-5")).toBe(false);
    expect(isUnii("")).toBe(false);
  });
});

describe("normalizeSlug", () => {
  it("returns a bare slug unchanged", () => {
    expect(normalizeSlug("squalane")).toBe("squalane");
  });

  it("strips the query string and fragment from a bare slug", () => {
    expect(normalizeSlug("squalane?utm=1#top")).toBe("squalane");
  });

  it("takes the slug from a site path", () => {
    expect(normalizeSlug("/products/the-ordinary-retinol")).toBe(
      "the-ordinary-retinol",
    );
    expect(normalizeSlug("/ingredients/squalane/")).toBe("squalane");
  });

  it("strips an allowed URL down to its slug", () => {
    expect(normalizeSlug("https://inkeedecoder.com/products/x")).toBe("x");
    expect(normalizeSlug("http://inkeedecoder.com/products/x?ref=1#top")).toBe(
      "x",
    );
  });

  it("accepts protocol-relative links from scraped HTML", () => {
    expect(normalizeSlug("//inkeedecoder.com/products/x")).toBe("x");
  });

  it("rejects dot segments and encoded path separators", () => {
    for (const input of [
      "..",
      "../products/x",
      "/products/../ingredients/x",
      "/products/%2e%2e",
      "/products/a%2Fb",
      "/products/a%5Cb",
      "foo\\bar",
    ]) {
      expect(() => normalizeSlug(input), input).toThrow(
        /dot segment|separator/,
      );
    }
  });

  it("rejects an empty value", () => {
    expect(() => normalizeSlug("   ")).toThrow(/empty/);
  });

  it("rejects links to hosts other than INKEEDecoder", () => {
    expect(() => normalizeSlug("https://example.com/products/x")).toThrow(
      /not an INKEEDecoder link/,
    );
    // The site's former domain is not accepted either: it redirects to the
    // current one, so callers can be told to pass the slug instead.
    expect(() =>
      normalizeSlug("https://www.incidecoder.com/ingredients/squalane"),
    ).toThrow(/not an INKEEDecoder link/);
    expect(() =>
      normalizeSlug("https://incidecoder.com/ingredients/squalane"),
    ).toThrow(/not an INKEEDecoder link/);
  });

  it("rejects a malformed URL", () => {
    expect(() => normalizeSlug("https://[")).toThrow(/not a valid URL/);
  });

  it("rejects paths that do not identify a product or ingredient", () => {
    expect(() => normalizeSlug("/")).toThrow(/does not identify/);
    expect(() => normalizeSlug("https://inkeedecoder.com/")).toThrow(
      /does not identify/,
    );
    expect(() => normalizeSlug("/brands/the-ordinary")).toThrow(
      /not a recognizable/,
    );
    expect(() => normalizeSlug("/products/x/y")).toThrow(/not a recognizable/);
  });

  it("leaves malformed percent-encoding alone because it cannot traverse", () => {
    expect(normalizeSlug("bad%zz")).toBe("bad%zz");
  });
});
