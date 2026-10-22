import type { CallToolResult } from "@modelcontextprotocol/server";
import { readConfig } from "../config.js";
import { sanitizeSourceText, toUserMessage } from "../lib/errors.js";
import { formatJson } from "../lib/format.js";
import type { NextStep } from "../lib/schemas.js";
import { cosingAdapter } from "../sources/cosing.js";
import { drugcentralAdapter } from "../sources/drugcentral.js";
import { dsldAdapter } from "../sources/dsld.js";
import { inkeedecoderAdapter } from "../sources/inkeedecoder.js";
import { nlmAdapter } from "../sources/nlm.js";
import { openfdaAdapter } from "../sources/openfda.js";
import { createRegistry } from "../sources/registry.js";
import type {
  IngredientGroup,
  ProductGroup,
  Registry,
  SourceAdapter,
} from "../sources/types.js";

/**
 * Shared plumbing for the two unified search tools.
 *
 * Both tools need the same four things before they can render a result: a
 * registry (injected by tests or built from process configuration), safe error
 * text, source-grouped output with scrubbed error messages, and the same
 * conventions for empty results, identifiers, and next-step rendering.
 */

/** Every adapter a search fans out over, in the server's fixed order. */
const SEARCH_ADAPTERS: readonly SourceAdapter[] = [
  openfdaAdapter,
  cosingAdapter,
  nlmAdapter,
  drugcentralAdapter,
  dsldAdapter,
  inkeedecoderAdapter,
];

/** The registry to use, or the configuration error that prevents building one. */
export type RegistryResolution =
  | { ok: true; registry: Registry }
  | { ok: false; error: string };

/**
 * Resolves the registry for a search call.
 *
 * Tests pass their own registry; production builds one from the current
 * configuration on every call so `DRUGDATA_DISABLED_SOURCES` and keys are read
 * lazily rather than at import time. A configuration error is returned as
 * text, never thrown: `tools/list` must keep working when the environment is
 * wrong.
 */
export function resolveRegistry(registry?: Registry): RegistryResolution {
  if (registry !== undefined) return { ok: true, registry };

  const config = readConfig();
  if (!config.ok) return { ok: false, error: config.error };

  return {
    ok: true,
    registry: createRegistry(
      [...SEARCH_ADAPTERS],
      config.config.DRUGDATA_DISABLED_SOURCES,
    ),
  };
}

/** A returned tool error whose text names only upstream databases. */
export function toolError(error: unknown, context: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: sanitizeSourceText(toUserMessage(error, context)),
      },
    ],
    isError: true,
  };
}

/** A returned tool error built from ready-made, model-facing text. */
export function messageError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: sanitizeSourceText(message) }],
    isError: true,
  };
}

/** Whether a group carries a failure instead of results. */
interface ErrorCarrier {
  error?: string;
}

/**
 * Scrubs client-library references from every group error.
 *
 * Adapters normally reword failures, but the registry forwards an adapter's
 * rejection text verbatim. This is the last gate before the text reaches the
 * model, so the sourcing policy holds even for an adapter bug.
 */
export function sanitizeGroups<T extends ErrorCarrier>(
  groups: readonly T[],
): T[] {
  return groups.map((group) =>
    group.error === undefined
      ? group
      : { ...group, error: sanitizeSourceText(group.error) },
  );
}

/** What the caller needs to know to word empty-result guidance correctly. */
export interface ZeroResultsContext {
  /** Which search tool produced the result. */
  kind: "product" | "ingredient";
  /** Whether the product search actually used a category filter. */
  hasCategory: boolean;
}

/**
 * Guidance appended when a search returned no items at all.
 *
 * Empty results are normal, so the tool succeeds; the note distinguishes four
 * situations the agent should react to differently: a filter that excluded
 * every source, a total outage, a partial outage, and ordinary zero matches.
 * Advice is tool-specific: only the product tool accepts a category filter,
 * and an ingredient search can suggest a name search as a fallback.
 */
export function zeroResultsNote(
  groups: readonly ErrorCarrier[],
  context: ZeroResultsContext,
): string {
  if (groups.length === 0) {
    const filter =
      context.kind === "product" && context.hasCategory ? " and filter" : "";
    return `No source covers this search type${filter}. Check DRUGDATA_DISABLED_SOURCES with drugdata_ping, or try a different type.`;
  }
  if (groups.every((group) => group.error !== undefined)) {
    return "Every searched source failed. Retry, or run drugdata_ping to check the configuration.";
  }
  if (groups.some((group) => group.error !== undefined)) {
    return "No matches from the sources that answered. Retry to include the source(s) that failed.";
  }
  if (context.kind === "ingredient") {
    return "No matches found. Try a different search type or a name search, or a shorter or broader query.";
  }
  return context.hasCategory
    ? "No matches found. Try a different type, a shorter or broader query, or remove the category filter."
    : "No matches found. Try a different type or a shorter or broader query.";
}

/**
 * Text blocks for a JSON result: the compact JSON first, then optional
 * guidance as a separate block. Guidance is never appended to the JSON
 * string, so `JSON.parse` always succeeds.
 */
export function jsonTextBlocks(
  value: { groups: readonly (ProductGroup | IngredientGroup)[] },
  context: ZeroResultsContext,
): Array<{ type: "text"; text: string }> {
  const blocks: Array<{ type: "text"; text: string }> = [
    { type: "text", text: formatJson(value) },
  ];
  if (itemCount(value.groups) === 0) {
    blocks.push({
      type: "text",
      text: zeroResultsNote(value.groups, context),
    });
  }
  return blocks;
}

/** A label and zod-safe key for one identifier field. */
export type IdentifierField<T> = readonly [
  key: keyof T & string,
  label: string,
];

/** Renders one scalar, number list, or string list identifier. */
function compactIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return text.length > 0 ? text : undefined;
}

/** Renders an item's known identifiers as one `LABEL: value` line segment. */
export function identifierText<T extends object>(
  identifiers: T,
  fields: ReadonlyArray<IdentifierField<T>>,
): string | undefined {
  const parts: string[] = [];
  for (const [key, label] of fields) {
    const value = compactIdentifier(identifiers[key]);
    if (value !== undefined) parts.push(`${label}: ${value}`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Renders the suggested follow-up calls as a markdown block. */
export function nextStepsText(steps: readonly NextStep[]): string | undefined {
  if (steps.length === 0) return undefined;
  return [
    "**Next steps**",
    ...steps.map(
      (step) => `- ${step.tool} ${JSON.stringify(step.input)} — ${step.why}`,
    ),
  ].join("\n");
}

/** Sums the items across source groups. */
export function itemCount(
  groups: readonly (ProductGroup | IngredientGroup)[],
): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}
