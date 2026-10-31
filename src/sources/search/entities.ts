import { normalizeNdc } from "../../lib/ids.js";
import { recordNextStep } from "../../lib/next-steps.js";
import type {
  IdentifierConflict,
  IngredientRef,
  IngredientSearchEntity,
  NextStep,
  ProductRef,
  ProductSearchEntity,
  SearchCoverage,
  SourceSearchStatus,
} from "../../lib/schemas.js";
import type { ResolveInput } from "../identity/chain.js";
import type { IngredientGroup, ProductGroup } from "../types.js";

export type {
  IdentifierConflict,
  IngredientSearchEntity,
  ProductSearchEntity,
  ResolutionState,
  SearchCoverage,
  SourceSearchStatus,
} from "../../lib/schemas.js";
export type SearchEntity<R extends ProductRef | IngredientRef> = Omit<
  IngredientSearchEntity,
  "identifiers" | "records"
> & { identifiers: R["identifiers"]; records: R[] };
export interface EntitySearchResult<R extends ProductRef | IngredientRef> {
  query: string;
  type: string;
  category?: "medication" | "supplement" | "cosmetic";
  page: number;
  entities: SearchEntity<R>[];
  sources: SourceSearchStatus[];
  coverage: SearchCoverage;
  partial: boolean;
  nextSteps: NextStep[];
}
type Ref = IngredientRef | ProductRef;
type IdValue = string | number | string[] | number[];

/** Equality normalization does not rewrite the source's original spelling. */
function normalized(field: string, value: string | number): string {
  const text = String(value).trim();
  if (field === "ndc") return normalizeNdc(text) ?? "";
  if (field === "upc") {
    const digits = text.replace(/[\s-]/g, "");
    return /^\d{8,14}$/.test(digits) ? digits : "";
  }
  if (field === "rxcui" || field === "cid")
    return /^\d+$/.test(text) &&
      Number.isSafeInteger(Number(text)) &&
      Number(text) > 0
      ? String(Number(text))
      : "";
  if (field === "cas") return /^\d{2,7}-\d{2}-\d$/.test(text) ? text : "";
  return text.toUpperCase();
}
export function recordIdentityKeys(
  ref: Ref,
  type: "product" | "ingredient",
): string[] {
  const allowed =
    type === "ingredient"
      ? ["unii", "rxcui", "cas", "cid", "inchiKey"]
      : ["ndc", "splSetId", "upc"];
  return Object.entries(ref.identifiers).flatMap(([field, value]) =>
    allowed.includes(field)
      ? (Array.isArray(value) ? value : [value]).flatMap((v) => {
          const n = normalized(field, v);
          return n ? [`${field}:${n}`] : [];
        })
      : [],
  );
}
/** Keeps the first scalar and unions arrays; conflicts retain every competing scalar. */
export function mergedIdentifiers(
  refs: readonly { identifiers: Ref["identifiers"] }[],
): Ref["identifiers"] {
  const output: Record<string, IdValue> = {};
  for (const ref of refs)
    for (const [field, value] of Object.entries(ref.identifiers)) {
      const previous = output[field];
      if (previous === undefined)
        output[field] = Array.isArray(value)
          ? (value.map((item) => item) as string[] | number[])
          : value;
      else if (Array.isArray(previous) && Array.isArray(value))
        output[field] = [...new Set([...previous, ...value])] as
          | string[]
          | number[];
    }
  return output;
}
export function conflictsOf(refs: readonly Ref[]): IdentifierConflict[] {
  const fields = new Map<string, IdentifierConflict["values"]>();
  for (const ref of refs)
    for (const [field, value] of Object.entries(ref.identifiers)) {
      if (Array.isArray(value)) continue;
      const values = fields.get(field) ?? [];
      if (
        !values.some(
          (existing) =>
            existing.record.database === ref.source.database &&
            existing.record.id === ref.source.id &&
            existing.value === value,
        )
      )
        values.push({ record: ref.source, value });
      fields.set(field, values);
    }
  return [...fields]
    .filter(
      ([field, values]) =>
        new Set(values.map((v) => normalized(field, String(v.value)))).size > 1,
    )
    .map(([field, values]) => ({ field, values }));
}
export function ingredientResolveInput(
  entity: IngredientSearchEntity,
): ResolveInput | undefined {
  const ids = entity.identifiers;
  if (ids.unii) return { unii: ids.unii.trim().toUpperCase() };
  if (ids.cid?.[0]) return { cid: String(ids.cid[0]) };
  if (ids.rxcui?.[0]) return { rxcui: ids.rxcui[0] };
  if (ids.cas?.[0]) return { cas: ids.cas[0] };
  const name = entity.name.trim();
  return name ? { substanceName: name.slice(0, 200) } : undefined;
}
export function productResolveInput(
  entity: ProductSearchEntity,
): ResolveInput | undefined {
  const ids = entity.identifiers;
  if (ids.ndc?.[0]) return { ndc: ids.ndc[0] };
  if (ids.splSetId) return { splSetId: ids.splSetId };
  if (ids.dsldId) return { dsldId: ids.dsldId };
  return undefined;
}
export function entityNextSteps(
  entity: SearchEntity<Ref>,
  type: "product" | "ingredient",
) {
  const steps = entity.records.flatMap((ref) => {
    const step = recordNextStep(ref, type);
    return step ? [step] : [];
  });
  const input =
    type === "ingredient"
      ? ingredientResolveInput(entity)
      : productResolveInput(entity);
  if (input)
    steps.push({
      tool: "drugdata_resolve_identifiers",
      input: Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key === "substanceName"
            ? "substance_name"
            : key === "splSetId"
              ? "spl_setid"
              : key === "dsldId"
                ? "dsld_id"
                : key,
          value,
        ]),
      ),
      why: "Resolve this entity across the other databases.",
    });
  return steps;
}
/** Stable union-find clustering; names and candidates never establish equality. */
function cluster<R extends Ref>(
  groups: readonly { items: R[] }[],
  type: "product" | "ingredient",
): SearchEntity<R>[] {
  const refs = groups.flatMap((group) => group.items);
  const parents = refs.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) {
      i = parents[i] ?? i;
    }
    return i;
  };
  const seen = new Map<string, number>();
  refs.forEach((ref, i) => {
    for (const key of [
      `source:${ref.source.database}:${ref.source.id}`,
      ...recordIdentityKeys(ref, type),
    ]) {
      const prior = seen.get(key);
      if (prior === undefined) seen.set(key, i);
      else {
        const a = root(prior),
          b = root(i);
        parents[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const buckets = new Map<number, [R, ...R[]]>();
  refs.forEach((ref, i) => {
    const r = root(i);
    const bucket = buckets.get(r);
    if (bucket) bucket.push(ref);
    else buckets.set(r, [ref]);
  });
  return [...buckets.values()].map((originals) => {
    const bySource = new Map<string, [R, ...R[]]>();
    for (const ref of originals) {
      const key = `${ref.source.database}:${ref.source.id}`;
      const values = bySource.get(key);
      if (values) values.push(ref);
      else bySource.set(key, [ref]);
    }
    const records = [...bySource.values()].map((values) => {
      const first = values[0];
      return { ...first, identifiers: mergedIdentifiers(values) };
    });
    const first = originals[0];
    const entity: SearchEntity<R> = {
      name: first.name,
      identifiers: mergedIdentifiers(originals),
      records,
      links: [],
      candidates: [],
      evidence: [
        ...new Set(originals.flatMap((ref) => recordIdentityKeys(ref, type))),
      ].map((key) => {
        const colon = key.indexOf(":");
        return {
          kind: key.slice(0, colon),
          value: key.slice(colon + 1),
          confidence: "direct",
        };
      }),
      conflicts: conflictsOf(originals),
      resolution: "skipped",
      nextSteps: [],
    };
    const input =
      type === "ingredient"
        ? ingredientResolveInput(entity)
        : productResolveInput(entity);
    entity.resolution = input ? "skipped" : "unavailable";
    entity.nextSteps = entityNextSteps(entity, type);
    return entity;
  });
}
export function clusterIngredientGroups(
  groups: readonly IngredientGroup[],
): IngredientSearchEntity[] {
  return cluster(groups, "ingredient");
}
export function clusterProductGroups(
  groups: readonly ProductGroup[],
): ProductSearchEntity[] {
  return cluster(groups, "product");
}
