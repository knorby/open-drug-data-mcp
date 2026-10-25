import { describe, expect, it } from "vitest";
import {
  ndcFromProductCode,
  parseBarcodeInput,
} from "../src/sources/identity/barcode.js";

/**
 * Barcode input is the boundary between a scan or a typed code and the
 * upstream identifiers a search can use. These tests pin the three outcomes
 * and the candidate sets each one has to carry:
 *
 * - a drug GTIN or typed NDC becomes dashed NDC candidates for openFDA;
 * - a retail UPC/EAN becomes digits plus the spaced form DSLD stores;
 * - anything else is `unknown`, never a throw.
 */

describe("parseBarcodeInput", () => {
  describe("GS1 DataMatrix AI 01", () => {
    it("extracts the embedded NDC-10 from a US drug GTIN", () => {
      expect(
        parseBarcodeInput("(01)00312345678901(17)271231(10)LOT2025A"),
      ).toEqual({
        kind: "ndc",
        ndcCandidates: [
          "1234-5678-90", // 4-4-2
          "12345-678-90", // 5-3-2
          "12345-6789-0", // 5-4-1
          "01234-5678-90", // 4-4-2 padded to 5-4-2
          "12345-0678-90", // 5-3-2 padded to 5-4-2
          "12345-6789-00", // 5-4-1 padded to 5-4-2
        ],
      });
    });

    it("accepts an AIM symbology prefix and group separators", () => {
      expect(parseBarcodeInput("]d20100312345678901\u001d10LOT2025A")).toEqual({
        kind: "ndc",
        ndcCandidates: [
          "1234-5678-90",
          "12345-678-90",
          "12345-6789-0",
          "01234-5678-90",
          "12345-0678-90",
          "12345-6789-00",
        ],
      });
    });

    it("strips a leading group separator before AI 01", () => {
      expect(parseBarcodeInput("\u001d0100312345678901")).toMatchObject({
        kind: "ndc",
      });
    });

    it("finds AI 01 in a later separator-delimited group", () => {
      expect(
        parseBarcodeInput("10LOT2025A\u001d0100312345678901"),
      ).toMatchObject({ kind: "ndc" });
    });

    it("treats a bare 14-digit US drug GTIN as a GTIN", () => {
      expect(parseBarcodeInput("00312345678901")).toMatchObject({
        kind: "ndc",
        ndcCandidates: expect.arrayContaining(["1234-5678-90"]),
      });
    });

    it("returns the consumer EAN carried by an explicit consumer GTIN", () => {
      expect(parseBarcodeInput("(01)00036674139417")).toEqual({
        kind: "upc",
        upc: "0036674139417",
        upcVariants: ["0036674139417", "0 03667 413941 7"],
      });
    });

    it("reduces a bare consumer GTIN-14 to its carried EAN", () => {
      expect(parseBarcodeInput("00036674139417")).toEqual({
        kind: "upc",
        upc: "0036674139417",
        upcVariants: ["0036674139417", "0 03667 413941 7"],
      });
    });

    it("returns unknown for an explicit non-drug case GTIN", () => {
      expect(parseBarcodeInput("(01)12345678901234")).toEqual({
        kind: "unknown",
        raw: "(01)12345678901234",
      });
    });

    it("ignores a parenthesized AI 01 without a full GTIN", () => {
      expect(parseBarcodeInput("(01)123")).toEqual({
        kind: "unknown",
        raw: "(01)123",
      });
    });
  });

  describe("typed NDCs", () => {
    it("keeps the typed dashed layout among the candidates", () => {
      expect(parseBarcodeInput("0093-1046-01")).toEqual({
        kind: "ndc",
        ndcCandidates: [
          "00093-1046-01", // canonical 5-4-2
          "0093-1046-01", // typed 4-4-2
          "00093-046-01",
          "00093-1046-1",
        ],
      });
    });

    it("normalizes a 5-3-2 entry and its padded layout", () => {
      expect(parseBarcodeInput("58151-155-77")).toEqual({
        kind: "ndc",
        ndcCandidates: [
          "58151-0155-77",
          "8151-0155-77",
          "58151-155-77", // typed 5-3-2
          "58151-0155-7",
        ],
      });
    });

    it("normalizes a 5-4-1 entry and its unpadded layout", () => {
      expect(parseBarcodeInput("58151-1557-7")).toEqual({
        kind: "ndc",
        ndcCandidates: [
          "58151-1557-07",
          "8151-1557-07",
          "58151-557-07",
          "58151-1557-7", // typed 5-4-1
        ],
      });
    });

    it("keeps the 5-3-2 and 5-4-1 readings of a bare 10-digit NDC", () => {
      expect(parseBarcodeInput("5815115577")).toEqual({
        kind: "ndc",
        ndcCandidates: [
          // Canonical 4-4-2 reading and its un-padded variants.
          "05815-1155-77",
          "5815-1155-77",
          "05815-155-77",
          "05815-1155-7",
          // Alternative 5-3-2 and 5-4-1 readings.
          "58151-155-77",
          "58151-1557-7",
          "58151-0155-77",
          "58151-1557-07",
        ],
      });
    });

    it("accepts a bare 11-digit NDC as 5-4-2", () => {
      expect(parseBarcodeInput("05815115577")).toEqual({
        kind: "ndc",
        ndcCandidates: [
          "05815-1155-77",
          "5815-1155-77",
          "05815-155-77",
          "05815-1155-7",
        ],
      });
    });

    it("trims surrounding whitespace before parsing", () => {
      expect(parseBarcodeInput("  0093-1046-01  ")).toMatchObject({
        kind: "ndc",
        ndcCandidates: expect.arrayContaining(["0093-1046-01"]),
      });
    });
  });

  describe("UPC and EAN", () => {
    it("keeps a short digits-only code as a single variant", () => {
      expect(parseBarcodeInput("3607349")).toEqual({
        kind: "upc",
        upc: "3607349",
        upcVariants: ["3607349"],
      });
    });

    it("adds the GS1-spaced form of a UPC-A", () => {
      expect(parseBarcodeInput("033674139417")).toEqual({
        kind: "upc",
        upc: "033674139417",
        upcVariants: ["033674139417", "0 33674 13941 7"],
      });
    });

    it("adds the GS1-spaced form of an EAN-13", () => {
      expect(parseBarcodeInput("0366741394177")).toEqual({
        kind: "upc",
        upc: "0366741394177",
        upcVariants: ["0366741394177", "0 36674 139417 7"],
      });
    });

    it("normalizes an already-spaced UPC to digits plus its spaced form", () => {
      expect(parseBarcodeInput("0 33674 13941 7")).toEqual({
        kind: "upc",
        upc: "033674139417",
        upcVariants: ["033674139417", "0 33674 13941 7"],
      });
    });

    it("derives NDC candidates from a 3-prefixed UPC-A", () => {
      expect(parseBarcodeInput("312345678905")).toEqual({
        kind: "ndc",
        ndcCandidates: [
          "1234-5678-90",
          "12345-678-90",
          "12345-6789-0",
          "01234-5678-90",
          "12345-0678-90",
          "12345-6789-00",
        ],
      });
    });
  });

  describe("unknown input", () => {
    it("returns unknown, preserving the original raw value", () => {
      for (const raw of [
        "",
        "   ",
        "hello-world",
        "abc123",
        "(17)271231",
        "0093-1046",
      ]) {
        expect(parseBarcodeInput(raw)).toEqual({ kind: "unknown", raw });
      }
    });

    it("returns unknown for a bare non-drug, non-consumer GTIN-14", () => {
      expect(parseBarcodeInput("12345678901234")).toEqual({
        kind: "unknown",
        raw: "12345678901234",
      });
      expect(parseBarcodeInput("1234 5678 9012 34")).toEqual({
        kind: "unknown",
        raw: "1234 5678 9012 34",
      });
    });

    it("returns unknown when only separators remain", () => {
      expect(parseBarcodeInput("---")).toEqual({
        kind: "unknown",
        raw: "---",
      });
    });

    it("returns unknown for an AIM prefix without a GTIN", () => {
      expect(parseBarcodeInput("]d2hello")).toEqual({
        kind: "unknown",
        raw: "]d2hello",
      });
    });
  });
});

describe("ndcFromProductCode", () => {
  it("extracts the NDC from a US drug GTIN-14", () => {
    expect(ndcFromProductCode("10312345678902")).toBe("1234567890");
  });

  it("extracts the NDC from a 3-prefixed UPC-A", () => {
    expect(ndcFromProductCode("312345678905")).toBe("1234567890");
  });

  it("ignores product codes without the US drug prefix", () => {
    expect(ndcFromProductCode("04312345678902")).toBeNull();
    expect(ndcFromProductCode("033674139417")).toBeNull();
    expect(ndcFromProductCode("0366741394177")).toBeNull();
  });

  it("rejects non-digit input", () => {
    expect(ndcFromProductCode("31234abc")).toBeNull();
  });
});
