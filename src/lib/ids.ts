/**
 * Per-source identifier normalization.
 *
 * Every tool takes caller-supplied identifiers — NDCs from a package label,
 * UNIIs from a safety sheet, INKEEDecoder slugs or links from a chat
 * transcript. Upstream APIs disagree about formatting, so this module owns the
 * one canonical spelling per identifier type and leaves the raw value to the
 * tool's error message when it cannot be normalized.
 */

/**
 * NDC segment layouts, as `[labeler, product, package]` widths.
 *
 * The same 10-digit NDC can be written 4-4-2, 5-3-2, or 5-4-1 depending on
 * the labeler, so all three are accepted. The canonical 11-digit form is
 * always 5-4-2, with the short segment zero-padded on the left.
 */
const NDC_LAYOUTS: ReadonlyArray<readonly [number, number, number]> = [
  [5, 4, 2],
  [4, 4, 2],
  [5, 3, 2],
  [5, 4, 1],
];

/** A run of ASCII digits, so a bare value is never mistaken for a layout. */
const DIGITS = /^\d+$/;

/**
 * Normalizes an NDC to the canonical 11-digit form.
 *
 * Accepts a bare 10- or 11-digit value and the three dashed 10-digit labeler
 * layouts (4-4-2, 5-3-2, 5-4-1) plus the canonical dashed 5-4-2 form. Dashed
 * input is padded per segment to 5-4-2; a bare 10-digit value has no segment
 * boundaries, so it is read as 4-4-2 (the layout openFDA uses for NDC-10) and
 * padded with one leading zero.
 *
 * @returns The 11-digit NDC, or `null` when the value is not a recognizable
 *   NDC. Callers treat `null` as "not an NDC", not as an error.
 */
export function normalizeNdc(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (DIGITS.test(trimmed)) {
    if (trimmed.length === 11) return trimmed;
    if (trimmed.length === 10) return `0${trimmed}`;
    return null;
  }

  const segments = trimmed.split("-");
  if (segments.length !== 3) return null;

  const labeler = segments[0] as string;
  const product = segments[1] as string;
  const packageCode = segments[2] as string;
  if (
    !DIGITS.test(labeler) ||
    !DIGITS.test(product) ||
    !DIGITS.test(packageCode)
  ) {
    return null;
  }

  for (const [labelerWidth, productWidth, packageWidth] of NDC_LAYOUTS) {
    if (
      labeler.length === labelerWidth &&
      product.length === productWidth &&
      packageCode.length === packageWidth
    ) {
      return `${labeler.padStart(5, "0")}${product.padStart(4, "0")}${packageCode.padStart(2, "0")}`;
    }
  }

  return null;
}

/** UNIIs are exactly 10 ASCII letters or digits. */
const UNII = /^[A-Za-z0-9]{10}$/;

/**
 * Whether a value has the shape of a UNII.
 *
 * This is a shape check, not a registry lookup: a well-formed but unassigned
 * UNII still passes. Upstream lookups decide whether it exists.
 */
export function isUnii(value: string): boolean {
  return UNII.test(value);
}

/**
 * Hosts accepted in slug arguments.
 *
 * INCIDecoder renamed itself to INKEEDecoder after a trademark dispute with
 * PCPC, the body that owns the INCI nomenclature (see
 * https://inkeedecoder.com/new-name). It is the same site and the same
 * database — old incidecoder.com links redirect to inkeedecoder.com — so both
 * hosts are accepted here. Only the path is used: fetches always go to the
 * configured base URL, so a stale link never contacts the old domain.
 */
const ALLOWED_SLUG_HOSTS = new Set([
  "inkeedecoder.com",
  "www.inkeedecoder.com",
  "incidecoder.com",
  "www.incidecoder.com",
]);

/** Path prefixes that name a single INKEEDecoder entity. */
const SLUG_PATH_TYPES = new Set(["products", "ingredients"]);

/** Drops a query string or fragment; neither identifies the entity. */
function stripQueryAndHash(input: string): string {
  return input.replace(/[?#].*$/, "");
}

/**
 * Rejects the segments URL normalization could collapse: dot segments in raw
 * or percent-encoded form (`%2e`, `%2E`), and anything that decodes to a path
 * separator. A segment whose percent-encoding is malformed is left alone —
 * the URL parser treats it as a literal, so it cannot traverse.
 */
function isUnsafeSegment(segment: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  return (
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\")
  );
}

/**
 * Resolves a caller-supplied INKEEDecoder id to a bare slug.
 *
 * Accepts a bare slug (`"squalane"`), a site path (`"/products/x"` or
 * `"/ingredients/squalane"`), or an absolute or protocol-relative URL on an
 * allowed host. Only the last path segment is returned; the caller's tool
 * decides which endpoint to fetch, so the path type is not echoed back.
 *
 * @throws {Error} When the value is empty, points at another host, has an
 *   unrecognized path shape, or contains a dot segment or encoded path
 *   separator. The message is model-facing and names no client library.
 */
export function normalizeSlug(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'Expected an INKEEDecoder slug, path, or URL, but got an empty value. Pass the slug instead, for example "squalane".',
    );
  }

  let candidate = trimmed;
  // Protocol-relative links ("//inkeedecoder.com/...") come from scraped HTML.
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  }

  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(
        `"${trimmed}" is not a valid URL. Pass the INKEEDecoder slug instead, for example "squalane".`,
      );
    }

    const host = url.hostname.toLowerCase();
    if (!ALLOWED_SLUG_HOSTS.has(host)) {
      throw new Error(
        `"${trimmed}" is not an INKEEDecoder link (host "${host}"). Pass the slug instead — the last segment of the path.`,
      );
    }

    candidate = url.pathname;
  } else {
    candidate = stripQueryAndHash(candidate);
  }

  const segments = candidate.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(
      `"${trimmed}" does not identify an INKEEDecoder product or ingredient. Pass the slug instead, for example "squalane".`,
    );
  }

  for (const segment of segments) {
    if (isUnsafeSegment(segment)) {
      throw new Error(
        `"${trimmed}" is not a usable id — it contains a dot segment or an encoded path separator. Pass the slug directly, for example "squalane".`,
      );
    }
  }

  if (segments.length === 1) return segments[0] as string;

  if (segments.length === 2) {
    const type = segments[0] as string;
    if (SLUG_PATH_TYPES.has(type)) {
      return segments[1] as string;
    }
  }

  throw new Error(
    `"${trimmed}" is not a recognizable INKEEDecoder link. Expected a slug or a path under "/products/" or "/ingredients/", for example "/ingredients/squalane".`,
  );
}
