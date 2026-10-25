/**
 * Barcode and typed-code parsing.
 *
 * Scans and typed codes do not map one-to-one onto the identifiers upstream
 * databases index: a GS1 DataMatrix carries a GTIN with an embedded NDC, a
 * package label prints an NDC in one of three segment layouts, and a retail
 * code may be stored digits-only or space-grouped. This module is the single
 * boundary between those raw payloads and the candidate lists an adapter can
 * query. Everything here is pure: no network, no configuration, and malformed
 * input becomes `unknown` rather than a throw.
 */

import { normalizeNdc } from "../../lib/ids.js";

/** GS1 group separator (ASCII 29) between variable-length AI fields. */
const GS = "\u001d";

/** AIM symbology identifier scanners prepend (`]d2`, `]C1`, `]Q3`, …). */
const AIM_PREFIX = /^\][A-Za-z][0-9]/;

/** A complete GTIN-14 typed or read without an Application Identifier. */
const BARE_GTIN = /^\d{14}$/;

/** A bare 10-digit NDC has no segment boundaries to disambiguate. */
const BARE_NDC_10 = /^\d{10}$/;

/** AI 01 followed by its fixed-length 14-digit GTIN, at a group start. */
const AI01_GTIN = /^01(\d{14})/;

/**
 * Everything a retail code may contain: digits and spaces. Hyphens mean the
 * caller typed an NDC layout; a malformed one is not a retail code.
 */
const RETAIL_INPUT = /^[\d\s]+$/;

/** What a raw scan or typed identifier turned out to be. */
export type BarcodeParse =
  | { kind: "ndc"; ndcCandidates: string[] }
  | { kind: "upc"; upc: string; upcVariants: string[] }
  | { kind: "unknown"; raw: string };

/**
 * Parses a scanned or typed code into query candidates.
 *
 * - GS1 AI 01 with a US drug GTIN yields the embedded NDC-10 and every
 *   dashed layout openFDA might store it in.
 * - A dashed or bare NDC is normalized to the canonical 11-digit form and
 *   expanded into dashed layout candidates; a bare 10-digit value also keeps
 *   its 5-3-2 and 5-4-1 readings, since it has no segment boundaries.
 * - A 3-prefixed UPC-A carries an NDC-10 and yields NDC candidates.
 * - Any other UPC-A/EAN-13 (or retail digit string) yields its digits and
 *   the space-grouped form DSLD stores.
 * - Everything else is `unknown`; this function never throws.
 */
export function parseBarcodeInput(raw: string): BarcodeParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "unknown", raw };

  const gtin = gtinFromInput(trimmed);
  if (gtin !== null) {
    const ndc = ndcFromProductCode(gtin);
    if (ndc !== null) return ndcParse(ndc);
    // Consumer units (indicator 0) carry a 13-digit EAN. Other indicator
    // digits mark cases and pallets, which no consumer index keys on.
    return gtin.startsWith("0")
      ? upcParse(gtin.slice(1))
      : { kind: "unknown", raw };
  }

  const ndc = normalizeNdc(trimmed);
  if (ndc !== null) {
    // normalizeNdc reads bare 10 digits as 4-4-2. Keep that canonical
    // candidate set but also probe the 5-3-2 and 5-4-1 readings.
    return ndcParse(ndc, BARE_NDC_10.test(trimmed) ? trimmed : undefined);
  }

  if (RETAIL_INPUT.test(trimmed)) {
    // The regex guarantees at least one digit after trimming.
    const digits = trimmed.replace(/\D/g, "");
    const productNdc = ndcFromProductCode(digits);
    return productNdc !== null ? ndcParse(productNdc) : upcParse(digits);
  }

  return { kind: "unknown", raw };
}

/**
 * Recovers a GTIN from parenthesized GS1 text, a raw AI stream, or a bare
 * 14-digit value.
 *
 * Only AI 01 is needed: expiry, lot, and serial identify a package, not a
 * product, and no v1 tool consumes them. AI 01 is matched at the start of an
 * input or of a separator-delimited group, which is where DSCSA encoders put
 * it. A malformed or absent GTIN returns `null` so the caller can try the
 * typed-NDC and retail readings of the same input.
 */
function gtinFromInput(input: string): string | null {
  let value = input;

  const aim = AIM_PREFIX.exec(value);
  if (aim !== null) value = value.slice(aim[0].length);

  while (value.startsWith(GS)) value = value.slice(1);

  const parenthesized = /\(01\)(\d{14})/.exec(value)?.[1];
  if (parenthesized !== undefined) return parenthesized;

  if (BARE_GTIN.test(value)) return value;

  // Space-grouped GTINs ("0003 66741394 17") are the same product code.
  const compact = value.replace(/\s+/g, "");
  if (BARE_GTIN.test(compact)) return compact;

  for (const group of value.split(GS)) {
    const streamed = AI01_GTIN.exec(group)?.[1];
    if (streamed !== undefined) return streamed;
  }

  return null;
}

/**
 * NDC-10 embedded in a US drug product code.
 *
 * A GTIN-14 carries it in positions 4–13, after the indicator digit and the
 * `03` GS1 US drug prefix. A UPC-A starting with `3` carries it in positions
 * 2–11. A 13-digit EAN beginning `03` is deliberately not treated as a drug
 * code: that prefix space is shared with ordinary GS1 US consumer items, so
 * a bare EAN-13 cannot distinguish them.
 *
 * @returns The 10-digit NDC, or `null` when the code does not carry one.
 */
export function ndcFromProductCode(code: string): string | null {
  if (!/^\d+$/.test(code)) return null;
  if (code.length === 14 && code.slice(1, 3) === "03") return code.slice(3, 13);
  if (code.length === 12 && code.startsWith("3")) return code.slice(1, 11);
  return null;
}

/**
 * Every dashed layout openFDA might store an NDC in.
 *
 * A 10-digit NDC has three possible labeler layouts (4-4-2, 5-3-2, 5-4-1);
 * each also has a zero-padded 5-4-2 conversion. A canonical 11-digit NDC is
 * already 5-4-2, so it contributes its typed form plus the un-padded
 * variants. OpenFDA stores the labeler's own spelling, so the query ORs all
 * of them rather than guessing.
 */
function ndcCandidates(digits: string): string[] {
  const d = digits.replace(/\D/g, "");
  const forms = new Set<string>();
  const add = (labeler: string, product: string, pkg: string): void => {
    forms.add(`${labeler}-${product}-${pkg}`);
  };

  if (d.length === 10) {
    add(d.slice(0, 4), d.slice(4, 8), d.slice(8));
    add(d.slice(0, 5), d.slice(5, 8), d.slice(8));
    add(d.slice(0, 5), d.slice(5, 9), d.slice(9));
    add(`0${d.slice(0, 4)}`, d.slice(4, 8), d.slice(8));
    add(d.slice(0, 5), `0${d.slice(5, 8)}`, d.slice(8));
    add(d.slice(0, 5), d.slice(5, 9), `0${d.slice(9)}`);
  }

  if (d.length === 11) {
    add(d.slice(0, 5), d.slice(5, 9), d.slice(9));
    add(d.slice(1, 5), d.slice(5, 9), d.slice(9));
    add(d.slice(0, 5), d.slice(6, 9), d.slice(9));
    add(d.slice(0, 5), d.slice(5, 9), d.slice(10));
  }

  return [...forms];
}

/**
 * The forms a retail code is probed in: digits-only first, then the
 * space-grouped spelling when the code is long enough to have one.
 *
 * DSLD's barcode search uses the same order and grouping, so a scan matches
 * records stored either way.
 */
function upcVariants(digits: string): string[] {
  const grouped = groupBarcode(digits);
  return grouped.length === 0 ? [digits] : [digits, grouped];
}

/**
 * Space-groups a UPC-A or EAN-13 the way DSLD stores some `upcSku` values:
 * 1-5-5-1 for 12 digits and 1-5-6-1 for 13. Shorter codes have no grouped
 * spelling and return an empty string.
 */
function groupBarcode(digits: string): string {
  if (digits.length !== 12 && digits.length !== 13) return "";
  return `${digits.slice(0, 1)} ${digits.slice(1, 6)} ${digits.slice(6, -1)} ${digits.slice(-1)}`;
}

/**
 * Builds an NDC result. `extraDigits` adds the 10-digit candidate families
 * for a bare NDC, whose segment boundaries normalization cannot recover.
 */
function ndcParse(digits: string, extraDigits?: string): BarcodeParse {
  const candidates = ndcCandidates(digits);
  if (extraDigits !== undefined) {
    for (const candidate of ndcCandidates(extraDigits)) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return { kind: "ndc", ndcCandidates: candidates };
}

/** Builds a retail-code result with its digits and grouped spelling. */
function upcParse(digits: string): BarcodeParse {
  return { kind: "upc", upc: digits, upcVariants: upcVariants(digits) };
}
