import * as z from "zod/v4";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";

/**
 * Adapter ids, in the order the registry and diagnostics report them.
 *
 * This is the vocabulary `DRUGDATA_DISABLED_SOURCES` accepts and the ids
 * `drugdata_ping` returns. Each id names an adapter module, not an upstream
 * database: the NLM adapter serves both RxNorm and DailyMed.
 */
export const SOURCE_IDS = [
  "openfda",
  "cosing",
  "nlm",
  "drugcentral",
  "dsld",
  "inkeedecoder",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Agent-facing names for each adapter, matching the upstream database names
 * the sourcing policy allows in tool output.
 */
export const SOURCE_LABELS: Record<SourceId, string> = {
  openfda: "openFDA",
  cosing: "CosIng",
  nlm: "RxNorm/DailyMed",
  drugcentral: "DrugCentral",
  dsld: "DSLD",
  inkeedecoder: "INKEEDecoder",
};

/** An API key variable that may be absent or blank. */
const optionalKey = () =>
  z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : undefined;
    });

/**
 * Environment configuration, parsed lazily with Zod.
 *
 * Two rules shape this module:
 *
 * 1. **Never throw at startup.** A misconfigured server should still boot and
 *    answer `tools/list`, so a host can show the operator what is wrong.
 *    Configuration is therefore read when a tool runs, and problems come back
 *    as an actionable result rather than a crash.
 * 2. **Validate, do not trust.** `process.env` is `string | undefined`; Zod
 *    coerces and constrains it once, here.
 *
 * Every variable is optional: every source answers without a key, and the
 * openFDA and DSLD keys only raise upstream rate limits. Blank key values
 * count as unset, because hosts often emit `"VAR": ""` for every variable in
 * a config block.
 */
const EnvSchema = z.object({
  /**
   * openFDA API key. Optional: keyless requests work at a lower rate limit.
   * Never echoed to a tool response.
   */
  OPENFDA_API_KEY: optionalKey(),
  /**
   * NIH DSLD API key (data.gov). Optional: when set it raises the upstream
   * rate limit. Never echoed to a tool response.
   */
  DSLD_API_KEY: optionalKey(),
  /**
   * Abandon an upstream request that takes longer than this, in ms. A blank
   * value counts as unset, like the optional keys: hosts often emit `"VAR": ""`.
   */
  DRUGDATA_TIMEOUT_MS: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.coerce.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  ),
  /**
   * Comma-separated adapter ids to switch off for this process. Unknown ids
   * are rejected so a typo cannot silently leave a source enabled.
   */
  DRUGDATA_DISABLED_SOURCES: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id.length > 0),
    )
    .pipe(z.array(z.enum(SOURCE_IDS))),
});

export type Config = z.infer<typeof EnvSchema>;

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

let cached: ConfigResult | undefined;

/**
 * Reads and caches configuration from `process.env`.
 *
 * @returns The parsed config, or an error message describing what is wrong.
 */
export function readConfig(): ConfigResult {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  cached = parsed.success
    ? { ok: true, config: parsed.data }
    : {
        ok: false,
        error: `Invalid environment configuration: ${z.prettifyError(parsed.error)}`,
      };
  return cached;
}

/**
 * Clears the cached configuration. Tests call this after mutating
 * `process.env`.
 */
export function resetConfig(): void {
  cached = undefined;
}
