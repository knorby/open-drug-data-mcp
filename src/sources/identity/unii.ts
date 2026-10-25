/**
 * Shared UNII derivation for ingredient identity resolution.
 *
 * Precedence: an openFDA substance link wins (it is the source's own
 * identifier for the record), then a UNII a DSLD label row carries, then the
 * UNII the caller supplied. Later sources never override an earlier one: the
 * first confident value is the pivot the rest of the chain resolves against.
 */

/** Sources that may carry a UNII, in precedence order. */
export interface UniiSources {
  /** A linked openFDA substance record. */
  openfda?: { unii?: string | null } | null;
  /** A UNII carried by a DSLD label ingredient row. */
  dsldUnii?: string | null;
  /** The caller's own UNII input. */
  unii?: string | null;
}

/** A non-blank, upper-cased UNII, or `undefined` when absent. */
function normalize(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toUpperCase();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns the effective UNII for a chain run.
 *
 * @param sources Candidate UNII sources, highest precedence first.
 */
export function effectiveUnii(sources: UniiSources): string | undefined {
  return (
    normalize(sources.openfda?.unii) ??
    normalize(sources.dsldUnii) ??
    normalize(sources.unii)
  );
}
