import { CHARACTER_LIMIT } from "../constants.js";
import {
  type BoundedResult,
  formatJson,
  morePagesNote,
} from "../lib/format.js";
import type { IngredientRef, ProductRef } from "../lib/schemas.js";
import type { EntitySearchResult } from "../sources/search/entities.js";
import {
  nextStepsText,
  type ZeroResultsContext,
  zeroResultsNote,
} from "./search-support.js";

const ENTITY_TRUNCATION_NOTE =
  "\n\n[Response truncated: whole entities or lengthy source error text were omitted to fit the response limit. Coverage counts describe the full pre-bound search. Narrow the query for omitted records; retained ids and lookup actions are unchanged.]";

/** Bound by removing whole entities, never shortening lookup ids, URLs or actions. */
export function boundEntitySearch<R extends IngredientRef | ProductRef>(
  value: EntitySearchResult<R>,
): BoundedResult<EntitySearchResult<R>> {
  if (JSON.stringify(value).length <= CHARACTER_LIMIT)
    return { value, truncated: false };
  const bounded = {
    ...value,
    entities: [...value.entities],
    sources: value.sources.map((source) => ({
      ...source,
      ...(source.error ? { error: source.error.slice(0, 500) } : {}),
    })),
  };
  while (
    bounded.entities.length &&
    JSON.stringify(bounded).length > CHARACTER_LIMIT
  )
    bounded.entities.pop();
  return { value: bounded, truncated: true };
}
function emptyNote<R extends IngredientRef | ProductRef>(
  output: EntitySearchResult<R>,
  context: ZeroResultsContext,
) {
  return zeroResultsNote(
    output.sources.map((source) => ({
      error:
        source.status === "timeout"
          ? "Search deadline exceeded."
          : source.error,
    })),
    context,
  );
}
export function entityJsonBlocks<R extends IngredientRef | ProductRef>(
  output: EntitySearchResult<R>,
  context: ZeroResultsContext,
  truncated: boolean,
) {
  const blocks = [{ type: "text" as const, text: formatJson(output) }];
  if (output.coverage.records === 0)
    blocks.push({ type: "text", text: emptyNote(output, context) });
  if (truncated) blocks.push({ type: "text", text: ENTITY_TRUNCATION_NOTE });
  return blocks;
}
export function renderEntitySearch<R extends IngredientRef | ProductRef>(
  output: EntitySearchResult<R>,
  context: ZeroResultsContext,
  truncated: boolean,
  recordLine: (ref: R) => string,
): string {
  const sections = [
    `${context.kind === "ingredient" ? "Ingredient" : "Product"} search for ${JSON.stringify(output.query)} (type: ${output.type}) — page ${output.page}.`,
    ...output.sources.map((source) =>
      source.status === "ok"
        ? `### ${source.source} — ${source.resultCount} ${source.resultCount === 1 ? "result" : "results"} (page ${source.page}${source.hasMore ? ", more available" : ""})${source.resultCount === 0 ? "\n- No matches on this page." : ""}`
        : `### ${source.source} — unavailable\n⚠ ${source.source}: ${source.error ?? "Search deadline exceeded."}`,
    ),
    ...output.entities.map((entity) =>
      [
        `## ${entity.name} — resolution: ${entity.resolution}`,
        ...entity.records.map(recordLine),
        ...entity.links.map(
          (link) =>
            `- Linked ${link.database} (${link.confidence}, via ${link.matchedVia}): ${link.url}`,
        ),
        ...entity.conflicts.map(
          (conflict) =>
            `**Conflict: ${conflict.field}**\n${conflict.values.map((value) => `- ${value.record.database}: ${JSON.stringify(value.value)} — ${value.record.url}`).join("\n")}`,
        ),
        ...entity.candidates.map(
          (candidate) => `Unconfirmed candidates: ${JSON.stringify(candidate)}`,
        ),
        nextStepsText(entity.nextSteps),
      ]
        .filter((value) => value !== undefined)
        .join("\n"),
    ),
  ];
  if (output.coverage.records === 0) sections.push(emptyNote(output, context));
  if (output.partial)
    sections.push(
      `Partial search: ${output.coverage.resolutionCompleted}/${output.coverage.resolutionAttempted} resolutions completed${output.coverage.resolutionCapped ? "; enrichment capped at five entities" : ""}.`,
    );
  const steps = nextStepsText(output.nextSteps);
  if (steps) sections.push(steps);
  return (
    sections.join("\n\n") +
    morePagesNote(
      output.sources.some((source) => source.hasMore),
      output.page + 1,
    ) +
    (truncated ? ENTITY_TRUNCATION_NOTE : "")
  );
}
