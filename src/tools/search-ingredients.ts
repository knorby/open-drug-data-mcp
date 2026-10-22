import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  applyCharacterLimit,
  boundStructured,
  morePagesNote,
  RESPONSE_FORMATS,
  truncationNote,
} from "../lib/format.js";
import { searchNextSteps } from "../lib/next-steps.js";
import {
  databaseIdSchema,
  type IngredientIdentifiers,
  type IngredientRef,
  ingredientRefSchema,
  nextStepSchema,
  paginatedFields,
} from "../lib/schemas.js";
import {
  INGREDIENT_SEARCH_TYPES,
  type IngredientSearchType,
  type Registry,
} from "../sources/types.js";
import {
  type IdentifierField,
  identifierText,
  itemCount,
  jsonTextBlocks,
  messageError,
  nextStepsText,
  resolveRegistry,
  sanitizeGroups,
  toolError,
  type ZeroResultsContext,
  zeroResultsNote,
} from "./search-support.js";

/**
 * `drugdata_search_ingredients` — one ingredient search across every capable
 * source.
 *
 * Like its product counterpart, the registry owns the fan-out; this module
 * validates the closed output, derives identifier-driven follow-ups, and
 * renders markdown or JSON. A UNII in the results is the strongest pivot, so
 * next steps lead with `drugdata_resolve_identifiers` when one is present.
 */

const DESCRIPTION =
  "Search ingredients across openFDA, CosIng, DrugCentral, RxNorm, and INKEEDecoder. Choose the kind of value you have (name, INCI name, UNII, CAS number, EC number, or RxCUI); results are grouped by upstream database with identifiers, a deep link, and suggested follow-up calls. One `page` value applies to every source in the fan-out and re-queries all of them; each group's `hasMore` reports whether that source has another page. A group with an `error` means that one database failed — retry, or proceed with the other groups. No matches is a normal empty result, not an error.";

const inputSchema = z.object({
  type: z
    .enum(INGREDIENT_SEARCH_TYPES)
    .describe(
      "What to search by: 'name', 'inci' (INCI name), 'unii', 'cas' (CAS Registry Number), 'ec' (EC number), or 'rxcui' (RxNorm concept id).",
    ),
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("The search value, as text or an identifier."),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      "Page number for the fan-out, starting at 1. One page applies to every source and re-queries all of them.",
    ),
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe(
      "Text format: 'markdown' for a readable grouped report, or 'json' for the structured result serialized as JSON.",
    ),
});

const groupSchema = z.object({
  source: databaseIdSchema,
  items: z.array(ingredientRefSchema),
  ...paginatedFields,
  error: z
    .string()
    .optional()
    .describe(
      "Set when this database failed for the whole search; the other groups are still valid.",
    ),
});

const outputSchema = z.object({
  query: z.string(),
  page: z.number().int().min(1),
  groups: z.array(groupSchema),
  nextSteps: z.array(nextStepSchema),
});

type IngredientSearchInput = z.infer<typeof inputSchema>;
type IngredientSearchOutput = z.infer<typeof outputSchema>;
type IngredientGroupOutput = IngredientSearchOutput["groups"][number];

/** Empty-result advice for a tool that has no category filter. */
const ZERO_CONTEXT: ZeroResultsContext = {
  kind: "ingredient",
  hasCategory: false,
};

/** Identifier labels in the order the markdown text shows them. */
const IDENTIFIER_FIELDS: ReadonlyArray<IdentifierField<IngredientIdentifiers>> =
  [
    ["unii", "UNII"],
    ["cas", "CAS"],
    ["ec", "EC"],
    ["rxcui", "RxCUI"],
    ["structId", "structId"],
    ["cid", "CID"],
    ["inchiKey", "InChIKey"],
    ["slug", "slug"],
  ];

/** Registers the `drugdata_search_ingredients` tool. */
export function registerSearchIngredientsTool(
  server: McpServer,
  registry?: Registry,
): void {
  server.registerTool(
    "drugdata_search_ingredients",
    {
      title: "Search ingredients across open drug and cosmetic data sources",
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (
      { type, query, page, response_format }: IngredientSearchInput,
      ctx,
    ) => {
      try {
        const resolved = resolveRegistry(registry);
        if (!resolved.ok) return messageError(resolved.error);

        const groups = sanitizeGroups(
          await resolved.registry.searchIngredients(
            type,
            query,
            { page },
            ctx.mcpReq.signal,
          ),
        );
        const output = outputSchema.parse({
          query,
          page,
          groups,
          nextSteps: searchNextSteps(type, groups),
        });
        const bounded = boundStructured(output);
        // Paging advice must describe what the rendered groups actually show,
        // so read `hasMore` after bounding rather than from the raw fan-out.
        const anyHasMore = bounded.value.groups.some((group) => group.hasMore);

        if (response_format === "json") {
          return {
            content: jsonTextBlocks(bounded.value, ZERO_CONTEXT),
            structuredContent: bounded.value,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: applyCharacterLimit(
                renderMarkdown(
                  type,
                  bounded.value,
                  anyHasMore,
                  bounded.truncated,
                ),
              ),
            },
          ],
          structuredContent: bounded.value,
        };
      } catch (error) {
        return toolError(error, `the ${type} ingredient search`);
      }
    },
  );
}

/** Renders the markdown text block for an ingredient search. */
function renderMarkdown(
  type: IngredientSearchType,
  output: IngredientSearchOutput,
  anyHasMore: boolean,
  truncated: boolean,
): string {
  const sections = [
    `Ingredient search for ${JSON.stringify(output.query)} (type: ${type}) — page ${output.page}.`,
    ...output.groups.map(groupSection),
  ];

  if (itemCount(output.groups) === 0) {
    sections.push(zeroResultsNote(output.groups, ZERO_CONTEXT));
  }

  const steps = nextStepsText(output.nextSteps);
  if (steps !== undefined) sections.push(steps);

  let text = sections.join("\n\n");
  text += morePagesNote(anyHasMore, output.page + 1);
  if (truncated) text += truncationNote();
  return text;
}

/** Renders one source's section, including its failure as a warning. */
function groupSection(group: IngredientGroupOutput): string {
  if (group.error !== undefined) {
    return `### ${group.source} — unavailable\n⚠ ${group.source}: ${group.error}`;
  }

  const count = group.items.length;
  const results = `${count} ${count === 1 ? "result" : "results"}`;
  const more = group.hasMore ? ", more available" : "";
  const header = `### ${group.source} — ${results} (page ${group.page}${more})`;
  const lines =
    group.items.length === 0
      ? ["- No matches on this page."]
      : group.items.map(ingredientLine);
  return [header, ...lines].join("\n");
}

/** Renders one ingredient as a compact list line. */
function ingredientLine(item: IngredientRef): string {
  const details = [`**${item.name}**`];
  if (item.inciName !== undefined && item.inciName !== item.name) {
    details.push(`INCI: ${item.inciName}`);
  }
  if (item.role !== undefined) details.push(`role: ${item.role}`);
  if (item.quantity !== undefined) details.push(`quantity: ${item.quantity}`);
  const identifiers = identifierText(item.identifiers, IDENTIFIER_FIELDS);
  if (identifiers !== undefined) details.push(identifiers);
  if (item.matchBasis !== undefined) details.push(`match: ${item.matchBasis}`);
  details.push(item.source.url);
  return `- ${details.join(" · ")}`;
}
