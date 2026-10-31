import { toUserMessage } from "../../lib/errors.js";
import type {
  DatabaseId,
  IngredientRef,
  IngredientSearchEntity,
  ProductCategory,
  ProductRef,
  ProductSearchEntity,
} from "../../lib/schemas.js";
import type {
  IdentityGraph,
  IdentityResolver,
  ProductResolution,
  ResolveInput,
} from "../identity/chain.js";
import type {
  IngredientGroup,
  IngredientSearchType,
  ProductGroup,
  ProductSearchType,
  Registry,
} from "../types.js";
import {
  clusterIngredientGroups,
  clusterProductGroups,
  conflictsOf,
  type EntitySearchResult,
  entityNextSteps,
  ingredientResolveInput,
  mergedIdentifiers,
  productResolveInput,
  recordIdentityKeys,
  type SearchEntity,
} from "./entities.js";
export const MAX_SEARCH_RESOLUTIONS = 5;
export const MAX_SEARCH_RESOLUTION_CONCURRENCY = 3;
export type IngredientEntitySearchResult = EntitySearchResult<IngredientRef>;
export type ProductEntitySearchResult = EntitySearchResult<ProductRef>;
type Input = {
  query: string;
  type: IngredientSearchType | ProductSearchType;
  page: number;
  category?: ProductCategory;
};
type Ref = IngredientRef | ProductRef;

export function createSearchCoordinator(deps: {
  registry: Registry;
  resolver: IdentityResolver;
  timeoutMs: number;
}) {
  async function search<R extends Ref>(
    input: Input,
    kind: "product" | "ingredient",
    cluster: (groups: (IngredientGroup & ProductGroup)[]) => SearchEntity<R>[],
    signal?: AbortSignal,
  ): Promise<EntitySearchResult<R>> {
    signal?.throwIfAborted();
    const abort = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, abort.signal])
      : abort.signal;
    let active = true,
      expired = false;
    let expire!: () => void;
    const deadline = new Promise<"timeout">((resolve) => {
      expire = () => {
        expired = true;
        active = false;
        abort.abort();
        resolve("timeout");
      };
    });
    const timer = setTimeout(expire, deps.timeoutMs);
    const callerAbort = () => expire();
    signal?.addEventListener("abort", callerAbort, { once: true });
    const groups = new Map<DatabaseId, IngredientGroup | ProductGroup>();
    const sources =
      deps.registry.searchSources?.(kind, input.type, input.category) ?? [];
    const receive = (settled: readonly (IngredientGroup | ProductGroup)[]) => {
      if (active) for (const group of settled) groups.set(group.source, group);
    };
    try {
      const raw = (
        kind === "ingredient"
          ? deps.registry.searchIngredients(
              input.type as IngredientSearchType,
              input.query,
              { page: input.page },
              combined,
              receive,
            )
          : deps.registry.searchProducts(
              input.type as ProductSearchType,
              input.query,
              { page: input.page, category: input.category },
              combined,
              receive,
            )
      ).then(
        (result) => {
          receive(result);
          return "done" as const;
        },
        (error) => {
          if (!expired) throw error;
          return "timeout" as const;
        },
      );
      await Promise.race([raw, deadline]);
      signal?.throwIfAborted();
      const order = [...new Set([...sources, ...groups.keys()])];
      const initial = cluster(
        order.flatMap((source) => {
          const group = groups.get(source);
          return group ? [group as IngredientGroup & ProductGroup] : [];
        }),
      );
      const outcomes = new Map<number, IdentityGraph | ProductResolution>();
      const attempted = new Set<number>();
      const failed = new Set<number>();
      const available = initial
        .map((entity, index) => ({
          index,
          input:
            kind === "ingredient"
              ? ingredientResolveInput(entity as IngredientSearchEntity)
              : productResolveInput(entity as ProductSearchEntity),
        }))
        .filter(
          (item): item is { index: number; input: ResolveInput } =>
            item.input !== undefined,
        );
      const eligible = available.slice(0, MAX_SEARCH_RESOLUTIONS);
      let cursor = 0;
      const worker = async () => {
        while (active && cursor < eligible.length) {
          const item = eligible[cursor++] as (typeof eligible)[number];
          attempted.add(item.index);
          try {
            const result = await deps.resolver.resolve(
              item.input,
              { maxCandidates: 5 },
              combined,
            );
            if (!active) return;
            outcomes.set(
              item.index,
              result.kind === "ingredient" ? result.graph : result,
            );
          } catch (error) {
            if (!active) return;
            failed.add(item.index);
            toUserMessage(error, "the entity resolution");
          }
        }
      };
      if (!expired)
        await Promise.race([
          Promise.all(
            Array.from(
              {
                length: Math.min(
                  MAX_SEARCH_RESOLUTION_CONCURRENCY,
                  eligible.length,
                ),
              },
              worker,
            ),
          ),
          deadline,
        ]);
      signal?.throwIfAborted();
      active = false;
      const parents = initial.map((_, index) => index);
      const root = (index: number): number => {
        while (parents[index] !== index) index = parents[index] as number;
        return index;
      };
      for (const [index, outcome] of outcomes) {
        const links = new Set(
          outcome.links.map((link) => `${link.database}:${link.id}`),
        );
        const ids = new Set(
          kind === "ingredient" && !("kind" in outcome)
            ? (outcome.records ?? []).flatMap((record) =>
                recordIdentityKeys(record, kind),
              )
            : [],
        );
        initial.forEach((entity, other) => {
          if (
            entity.records.some(
              (record) =>
                links.has(`${record.source.database}:${record.source.id}`) ||
                recordIdentityKeys(record, kind).some((key) => ids.has(key)),
            )
          ) {
            const a = root(index),
              b = root(other);
            parents[Math.max(a, b)] = Math.min(a, b);
          }
        });
      }
      const entities: SearchEntity<R>[] = [];
      const buckets = new Map<number, number[]>();
      initial.forEach((_, index) => {
        const r = root(index);
        buckets.set(r, [...(buckets.get(r) ?? []), index]);
      });
      for (const [first, indices] of buckets) {
        const entity = initial[first] as SearchEntity<R>;
        const members = indices.map((i) => initial[i] as SearchEntity<R>);
        const records = members
          .flatMap((member) => member.records)
          .sort(
            (a, b) =>
              order.indexOf(a.source.database) -
                order.indexOf(b.source.database) ||
              a.source.id.localeCompare(b.source.id),
          );
        const resolved = indices.flatMap((i) =>
          outcomes.has(i)
            ? [outcomes.get(i) as IdentityGraph | ProductResolution]
            : [],
        );
        const links = [
          ...new Map(
            resolved
              .flatMap((value) => value.links)
              .map((link) => [`${link.database}:${link.id}`, link]),
          ).values(),
        ];
        const enriched = resolved.flatMap((value) =>
          "kind" in value ? [] : (value.records ?? []),
        );
        const identifiers = mergedIdentifiers([...records, ...enriched]);
        const errors = resolved.flatMap((value) => value.errors ?? []);
        if (kind === "ingredient") {
          const patches = resolved.flatMap((value) =>
            "kind" in value ? [] : [{ identifiers: value.identifiers }],
          );
          Object.assign(
            identifiers,
            mergedIdentifiers([...records, ...enriched, ...patches]),
          );
        }
        const states = indices.map((i) =>
          failed.has(i) || (attempted.has(i) && !outcomes.has(i))
            ? "partial"
            : outcomes.has(i)
              ? (outcomes.get(i)?.errors?.length ?? 0) > 0
                ? "partial"
                : "complete"
              : initial[i]?.resolution,
        );
        const resolution = states.includes("partial")
          ? "partial"
          : states.includes("complete")
            ? "complete"
            : states.includes("skipped")
              ? "skipped"
              : "unavailable";
        const merged: SearchEntity<R> = {
          ...entity,
          records,
          identifiers,
          links,
          candidates: resolved.flatMap((value) => value.candidates),
          ...(errors.length ? { errors } : {}),
          evidence: [
            ...new Map(
              [
                ...members.flatMap((member) => member.evidence),
                ...links.map((link) => ({
                  kind: `${link.database}:id`,
                  value: link.id,
                  confidence: link.confidence,
                })),
              ].map((value) => [JSON.stringify(value), value]),
            ).values(),
          ],
          conflicts: conflictsOf([
            ...records,
            ...enriched,
            ...members.flatMap((member) =>
              member.conflicts.flatMap((conflict) =>
                conflict.values.map((value) => ({
                  name: member.name,
                  source: value.record,
                  identifiers: { [conflict.field]: value.value },
                })),
              ),
            ),
          ]),
          resolution,
          nextSteps: [],
        };
        merged.nextSteps = entityNextSteps(merged, kind);
        entities.push(merged);
      }
      const statuses = order.map((source) => {
        const group = groups.get(source);
        return {
          source,
          status: group
            ? group.error
              ? ("error" as const)
              : ("ok" as const)
            : ("timeout" as const),
          page: group?.page ?? input.page,
          hasMore: group?.hasMore ?? false,
          resultCount: group?.items.length ?? 0,
          ...(group?.error ? { error: group.error } : {}),
        };
      });
      const nextSteps = statuses.some((source) => source.hasMore)
        ? [
            {
              tool:
                kind === "ingredient"
                  ? "drugdata_search_ingredients"
                  : "drugdata_search_products",
              input: {
                type: input.type,
                query: input.query,
                page: input.page + 1,
                ...(input.category ? { category: input.category } : {}),
              },
              why: "Fetch the next page from sources with more results.",
            },
          ]
        : [];
      return {
        ...input,
        entities,
        sources: statuses,
        coverage: {
          entities: entities.length,
          records: entities.reduce((n, entity) => n + entity.records.length, 0),
          resolutionAttempted: attempted.size,
          resolutionCompleted: outcomes.size,
          resolutionCapped: available.length > MAX_SEARCH_RESOLUTIONS,
        },
        partial:
          available.length > MAX_SEARCH_RESOLUTIONS ||
          statuses.some((source) => source.status !== "ok") ||
          entities.some(
            (entity) =>
              entity.resolution === "partial" ||
              entity.resolution === "skipped",
          ),
        nextSteps,
      };
    } finally {
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", callerAbort);
    }
  }
  return {
    searchIngredients: (
      input: { type: IngredientSearchType; query: string; page: number },
      signal?: AbortSignal,
    ) =>
      search<IngredientRef>(
        input,
        "ingredient",
        clusterIngredientGroups,
        signal,
      ),
    searchProducts: (
      input: {
        type: ProductSearchType;
        query: string;
        page: number;
        category?: ProductCategory;
      },
      signal?: AbortSignal,
    ) => search<ProductRef>(input, "product", clusterProductGroups, signal),
  };
}
