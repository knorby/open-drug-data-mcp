import { readFileSync } from "node:fs";

/**
 * Shared constants.
 *
 * `SERVER_VERSION` is read from `package.json` at load time. This module sits
 * one directory below the package root in both layouts it runs in — `src/`
 * during development and `dist/` once bundled — so the read keeps working
 * everywhere. Deriving it means a `changeset version` bump cannot leave the
 * version a host sees stale; the fallback keeps the server usable if the file
 * is unreadable.
 */

/** Server name advertised to hosts during initialization. */
export const SERVER_NAME = "open-drug-data-mcp";

/** Server version advertised to hosts, derived from `package.json`. */
export const SERVER_VERSION = readPackageVersion();

/**
 * The one-line disclaimer every agent-facing discovery surface carries.
 *
 * It appears verbatim in the server `instructions` (handed to a host at
 * initialization), the `server://info` resource, and the research prompt, so a
 * model sees it whichever path it reads first. The full boilerplate and source
 * terms live in `docs/SOURCES.md`.
 */
export const DISCLAIMER =
  "Informational/research use only — not medical advice; see docs/SOURCES.md for source terms.";

/**
 * Maximum characters a tool response may contain before it is bounded — the
 * text block by truncation, and `structuredContent` by `boundStructured`.
 */
export const CHARACTER_LIMIT = 25_000;

/** Default timeout for outgoing API calls, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_SEARCH_TIMEOUT_MS = 45_000;

/**
 * Reads the `version` field from a package manifest.
 *
 * `read` is injectable so tests can exercise the fallbacks without touching
 * the real manifest. Every failure — unreadable file, malformed JSON, a
 * missing or empty version — yields `"0.0.0"` rather than throwing: the
 * server must still boot when its manifest is unavailable.
 *
 * @internal Exported for tests; callers should use {@link SERVER_VERSION}.
 */
export function readPackageVersion(
  read: () => string = () =>
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
): string {
  try {
    const pkg = JSON.parse(read()) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
