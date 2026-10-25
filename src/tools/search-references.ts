import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  applyCharacterLimit,
  boundStructured,
  formatJson,
  RESPONSE_FORMATS,
  truncationNote,
} from "../lib/format.js";
import { type NextStep, nextStepSchema } from "../lib/schemas.js";
import {
  createReferenceSearcher,
  type ReferenceSearcher,
} from "../sources/nlm-references/index.js";
import {
  ALLOWED_REFERENCE_TYPES,
  REFERENCE_SOURCES,
  REFERENCE_TYPES,
  type Reference,
  type ReferenceGroup,
  type ReferenceSourceId,
  referenceGroupSchema,
} from "../sources/nlm-references/types.js";
import {
  identifierText,
  messageError,
  nextStepsText,
  toolError,
} from "./search-support.js";

/**
 * `drugdata_search_references` — the NLM reference surfaces.
 *
 * The unified product/ingredient searches answer "which record is this?";
 * this tool answers "what else is written about it?": Prescribable RxNorm,
 * RxClass drug classes, MeSH descriptors, PubMed articles, MedlinePlus
 * consumer pages and drug pages, UMLS terminology, and ClinicalTrials.gov
 * studies. One call addresses exactly one source. Records are link-first —
 * titles, identifiers, and dates, never article or study bodies.
 */

const DESCRIPTION =
  "Search NLM reference sources beyond product and ingredient records: Prescribable RxNorm (the currently prescribable drug dataset), RxClass (drug classes by name or member RxCUI), MeSH (medical subject descriptors), PubMed (biomedical literature), MedlinePlus (consumer-health topic pages), MedlinePlus Genetics (condition and gene pages), MedlinePlus Connect (drug pages by name, RxCUI, or NDC), UMLS (unified medical terminology; needs UMLS_API_KEY), and ClinicalTrials.gov (study registry). One call searches exactly one source — pass `source` plus the query. Results are link-first references: a title, the stable identifier (RxCUI, class id, MeSH id, PMID, CUI, or NCT number), and a deep link to the upstream record — not extracted article or study text. Each source accepts only some query types (for example MeSH searches by name only); an invalid pairing is rejected before any request. Continue with the returned `cursor` when `hasMore` is true. No matches is a normal empty result, not an error.";

const inputSchema = z.object({
  source: z
    .enum(REFERENCE_SOURCES)
    .describe(
      "Which reference source to search: 'prescribable', 'rxclass', 'mesh', 'pubmed', 'medlineplus', 'medlineplus_genetics', 'medlineplus_connect', 'umls', or 'clinicaltrials'.",
    ),
  type: z
    .enum(REFERENCE_TYPES)
    .default("name")
    .describe(
      "What the query holds: 'name' (default), 'rxcui', 'ndc', or 'cui'. Not every source accepts every type; an invalid pairing is rejected with the types that source accepts.",
    ),
  query: z
    .string()
    .min(1)
    .max(1_000)
    .describe(
      "The search value: a name or term by default, or the identifier named by `type`.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe(
      "Maximum references to return. Sources that page client-side may return slightly fewer when the upstream list ends early.",
    ),
  cursor: z
    .string()
    .min(1)
    .max(8_192)
    .optional()
    .describe(
      "Continuation token from a previous result's nextCursor. Only valid for the same source, type, query, and limit.",
    ),
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe(
      "Text format: 'markdown' for a readable reference list, or 'json' for the structured result serialized as JSON.",
    ),
});

const outputSchema = z.object({
  source: z.enum(REFERENCE_SOURCES),
  type: z.enum(REFERENCE_TYPES),
  query: z.string(),
  // One call answers from exactly one source, so the result always carries
  // exactly one group; a plain array keeps the schema portable to hosts that
  // validate with older JSON Schema drafts.
  groups: z.array(referenceGroupSchema),
  nextSteps: z.array(nextStepSchema),
  truncated: z.boolean().describe("Whether bounding shortened any content."),
});

type ReferenceSearchToolInput = z.infer<typeof inputSchema>;
type ReferenceSearchToolOutput = z.infer<typeof outputSchema>;

/** Registers the `drugdata_search_references` tool. */
export function registerSearchReferencesTool(
  server: McpServer,
  searcher?: ReferenceSearcher,
): void {
  server.registerTool(
    "drugdata_search_references",
    {
      title: "Search NLM reference sources",
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
      {
        source,
        type,
        query,
        limit,
        cursor,
        response_format,
      }: ReferenceSearchToolInput,
      ctx,
    ) => {
      try {
        const search = searcher ?? createReferenceSearcher();

        // An invalid source/type pairing is a caller error, not a source
        // failure: reject it before any network call, naming the valid types.
        const allowed = ALLOWED_REFERENCE_TYPES[source];
        if (!allowed.includes(type)) {
          return messageError(
            `Error: drugdata_search_references — source "${source}" does not search by ${type}. It accepts ${allowed
              .map((valid) => `'${valid}'`)
              .join(", ")}.`,
          );
        }

        const group = await search(
          { source, type, query, limit, cursor },
          ctx.mcpReq.signal,
        );
        const output = outputSchema.parse({
          source,
          type,
          query,
          groups: [group],
          nextSteps: referenceNextSteps(group),
          truncated: false,
        });
        const bounded = boundStructured(output);
        // Bounding is what knows whether anything was shortened; reflect it
        // in the structured result the host receives.
        bounded.value.truncated = bounded.truncated;

        if (response_format === "json") {
          return {
            content: jsonBlocks(bounded.value, group),
            structuredContent: bounded.value,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                applyCharacterLimit(
                  renderMarkdown(source, type, query, group, output.nextSteps),
                ) + (bounded.truncated ? truncationNote() : ""),
            },
          ],
          structuredContent: bounded.value,
        };
      } catch (error) {
        return toolError(error, "the reference search");
      }
    },
  );
}

/** The text blocks a JSON response returns: the value, then guidance. */
function jsonBlocks(
  value: ReferenceSearchToolOutput,
  group: ReferenceGroup,
): Array<{ type: "text"; text: string }> {
  const blocks: Array<{ type: "text"; text: string }> = [
    { type: "text", text: formatJson(value) },
  ];
  if (group.items.length === 0) {
    blocks.push({
      type: "text",
      text: group.error ?? "No matches found. Try a broader query.",
    });
  }
  return blocks;
}

/** Follow-up calls a reference result can offer. */
function referenceNextSteps(group: ReferenceGroup): NextStep[] {
  const steps: NextStep[] = [];
  const seen = new Set<string>();
  for (const reference of group.items) {
    const rxcui = reference.identifiers.rxcui;
    if (rxcui === undefined) continue;
    const key = `drugdata_get_ingredient:${rxcui}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({
      tool: "drugdata_get_ingredient",
      input: { source: "nlm", id: rxcui },
      why: "The reference carries an RxCUI; open the full RxNorm concept to continue the loop.",
    });
    if (steps.length === 3) break;
  }
  return steps;
}

/** Identifier labels in the order the markdown text shows them. */
const IDENTIFIER_FIELDS = [
  ["rxcui", "RxCUI"],
  ["classId", "class id"],
  ["classType", "class type"],
  ["meshId", "MeSH id"],
  ["pmid", "PMID"],
  ["cui", "CUI"],
  ["nctId", "NCT"],
] as const;

/** Renders one reference search as markdown. */
function renderMarkdown(
  source: ReferenceSourceId,
  type: string,
  query: string,
  group: ReferenceGroup,
  steps: readonly NextStep[],
): string {
  const lines: string[] = [
    `## ${sourceLabel(source)} references`,
    "",
    `Searched by ${type} for "${query}".`,
  ];

  if (group.error !== undefined) {
    lines.push("", `⚠ ${sourceLabel(source)}: ${group.error}`);
  }

  if (group.items.length > 0) {
    lines.push("", `### ${sourceLabel(source)}`);
    group.items.forEach((reference, index) => {
      lines.push("", ...referenceLines(reference, index));
    });
  } else if (group.error === undefined) {
    lines.push("", `No matches from ${sourceLabel(source)}.`);
  }

  if (group.limitation !== undefined) {
    lines.push("", `_Note: ${group.limitation}_`);
  }

  const stepsText = nextStepsText(steps);
  if (stepsText !== undefined) lines.push("", stepsText);

  if (group.hasMore) {
    lines.push(
      "",
      group.nextCursor === undefined
        ? "More results may exist, but this source returned no continuation token."
        : "More results available — call this tool again with the returned cursor.",
    );
  }

  if (group.total !== undefined) {
    lines.push("", `Total upstream matches: ${group.total}.`);
  }

  return lines.join("\n");
}

/** Renders one reference as markdown lines. */
function referenceLines(reference: Reference, index: number): string[] {
  const lines: string[] = [
    `${index + 1}. **${reference.title ?? "(untitled)"}**`,
  ];
  const identifiers = identifierText(reference.identifiers, IDENTIFIER_FIELDS);
  if (identifiers !== undefined) {
    lines.push(`   - Identifiers: ${identifiers}`);
  }
  if (reference.dataset !== undefined) {
    lines.push(`   - Dataset: ${reference.dataset}`);
  }
  if (reference.publicationDate !== undefined) {
    lines.push(`   - Published: ${reference.publicationDate}`);
  }
  lines.push(`   - Source: ${reference.source.url}`);
  return lines;
}

/** The agent-facing name of one reference source. */
function sourceLabel(source: ReferenceSourceId): string {
  const labels: Record<ReferenceSourceId, string> = {
    prescribable: "Prescribable RxNorm",
    rxclass: "RxClass",
    mesh: "MeSH",
    pubmed: "PubMed",
    medlineplus: "MedlinePlus",
    medlineplus_genetics: "MedlinePlus Genetics",
    medlineplus_connect: "MedlinePlus Connect",
    umls: "UMLS",
    clinicaltrials: "ClinicalTrials.gov",
  };
  return labels[source];
}
