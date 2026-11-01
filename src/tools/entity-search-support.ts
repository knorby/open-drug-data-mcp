import { CHARACTER_LIMIT } from "../constants.js";
import { SourceInputError } from "../lib/errors.js";
import {
  type BoundedResult,
  formatJson,
  morePagesNote,
} from "../lib/format.js";
import type {
  EntityOmissions,
  IngredientRef,
  ProductRef,
} from "../lib/schemas.js";
import {
  type EntitySearchResult,
  entityNextSteps,
  type SearchEntity,
} from "../sources/search/entities.js";
import {
  nextStepsText,
  type ZeroResultsContext,
  zeroResultsNote,
} from "./search-support.js";

const ENTITY_TRUNCATION_NOTE =
  "\n\n[Response truncated: read truncated, entitiesOmitted, and each entity's omitted counts. Coverage describes the full pre-bound search. Narrow the query or use retained source+id lookups for details. Retained ids and URLs are unchanged.]";

function identifierCount(
  ids: IngredientRef["identifiers"] | ProductRef["identifiers"],
): number {
  return Object.values(ids).reduce<number>(
    (n, v) => n + (Array.isArray(v) ? v.length : 1),
    0,
  );
}
function actionKey(
  step: SearchEntity<ProductRef>["nextSteps"][number],
): string {
  return JSON.stringify([step.tool, step.input]);
}
function omissions<R extends IngredientRef | ProductRef>(
  before: SearchEntity<R>,
  after: SearchEntity<R>,
): EntityOmissions {
  const actions = new Set(after.nextSteps.map(actionKey));
  const counts: EntityOmissions = {
    summaries: before.records.filter(
      (r) =>
        r.summary !== undefined &&
        r.summary !==
          after.records.find(
            (a) =>
              a.source.database === r.source.database &&
              a.source.id === r.source.id,
          )?.summary,
    ).length,
    evidence: before.evidence.length - after.evidence.length,
    candidates: before.candidates.length - after.candidates.length,
    links: before.links.length - after.links.length,
    conflicts: before.conflicts.length - after.conflicts.length,
    errors: (before.errors?.length ?? 0) - (after.errors?.length ?? 0),
    records: before.records.length - after.records.length,
    recordIdentifiers:
      before.records.reduce((n, r) => n + identifierCount(r.identifiers), 0) -
      after.records.reduce((n, r) => n + identifierCount(r.identifiers), 0),
    identifiers:
      identifierCount(before.identifiers) - identifierCount(after.identifiers),
    nextSteps: before.nextSteps.filter((s) => !actions.has(actionKey(s)))
      .length,
  };
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}
/** Tiered loss is explicit; retained identifiers and provenance are never rewritten. */
export function boundEntitySearch<R extends IngredientRef | ProductRef>(
  value: EntitySearchResult<R>,
  kind: "product" | "ingredient",
): BoundedResult<EntitySearchResult<R>> {
  if (JSON.stringify(value).length <= CHARACTER_LIMIT)
    return { value, truncated: false };
  const bounded = {
    ...value,
    partial: true,
    truncated: true,
    entities: value.entities.map((entity) => ({
      ...entity,
      identifiers: { ...entity.identifiers },
      records: entity.records.map((record) => ({
        ...record,
        identifiers: { ...record.identifiers },
      })),
    })),
    sources: value.sources.map((source) => ({
      ...source,
      ...(source.error ? { error: source.error.slice(0, 500) } : {}),
    })),
  };
  const fits = () => {
    bounded.entitiesOmitted =
      value.entitiesOmitted + value.entities.length - bounded.entities.length;
    bounded.entities.forEach((entity, index) => {
      const original = value.entities[index] as SearchEntity<R>;
      const lost = omissions(original, entity);
      if (Object.keys(lost).length) entity.omitted = lost;
    });
    return JSON.stringify(bounded).length <= CHARACTER_LIMIT;
  };
  const result = () => ({ value: bounded, truncated: true });
  for (const entity of bounded.entities)
    for (const record of entity.records) {
      if (record.summary && record.summary.length > 500)
        record.summary = `${record.summary.slice(0, 488)}…[truncated]`;
    }
  if (fits()) return result();
  for (const field of [
    "evidence",
    "candidates",
    "links",
    "conflicts",
  ] as const) {
    for (const entity of bounded.entities) entity[field] = [];
    if (fits()) return result();
  }
  while (bounded.entities.length > 1) {
    bounded.entities.pop();
    if (fits()) return result();
  }
  const entity = bounded.entities[0];
  if (entity) {
    while (entity.records.length > 1) {
      entity.records.pop();
      entity.nextSteps = entityNextSteps(entity, kind);
      if (fits()) return result();
    }
    for (const cap of [50, 10, 1]) {
      for (const ids of [
        entity.identifiers,
        ...entity.records.map((r) => r.identifiers),
      ]) {
        for (const [field, values] of Object.entries(ids)) {
          if (Array.isArray(values))
            Object.assign(ids, { [field]: values.slice(0, cap) });
        }
      }
      entity.nextSteps = entityNextSteps(entity, kind);
      if (fits()) return result();
    }
    entity.records = [];
    entity.identifiers = {};
    entity.nextSteps = [];
    delete entity.errors;
    if (fits()) return result();
  }
  throw new SourceInputError(
    "Search result cannot fit the response limit even as a minimal entity. Narrow the query or use a known source+id lookup.",
  );
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
        ...(entity.omitted
          ? [`Omitted: ${JSON.stringify(entity.omitted)}`]
          : []),
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
        ...(entity.errors ?? []).map(
          (error) => `⚠ ${error.database}: ${error.message}`,
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
