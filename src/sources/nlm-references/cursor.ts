import * as z from "zod/v4";
import type { ReferenceSearchInput } from "./types.js";

/**
 * Stateless, versioned cursors for the reference searches.
 *
 * The server holds no session state, so a cursor is the whole continuation:
 * a version tag, the request it belongs to, and a small source-specific
 * payload, base64url-encoded. Decoding validates that the cursor was minted
 * for exactly this request — a cursor from another query, source, or limit
 * is rejected with actionable text rather than silently returning the wrong
 * page.
 */

/** Bumped when the cursor envelope changes; old cursors then fail cleanly. */
const CURSOR_VERSION = 1;

/** Hard cap on cursor length, so a hostile host cannot balloon a request. */
const MAX_CURSOR_LENGTH = 8_192;

/**
 * A cursor the caller sent cannot be used.
 *
 * The message is model-facing and actionable; the tool returns it as an
 * `isError` result.
 */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/** The envelope every cursor serializes. */
const envelopeSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  s: z.string(),
  t: z.string(),
  q: z.string(),
  l: z.number().int().positive(),
  c: z.unknown(),
});

/** Base64url encode/decode, for compact opaque tokens. */
function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/**
 * Mints a cursor for one request.
 *
 * @param input The request the cursor continues.
 * @param payload The source-specific continuation state.
 * @returns The opaque cursor string to return as `nextCursor`.
 */
export function encodeCursor(
  input: ReferenceSearchInput,
  payload: unknown,
): string {
  const envelope = {
    v: CURSOR_VERSION,
    s: input.source,
    t: input.type,
    q: input.query,
    l: input.limit,
    c: payload,
  };
  return encode(JSON.stringify(envelope));
}

/**
 * Reads the source-specific payload a cursor carries.
 *
 * @param cursor The opaque token the caller sent.
 * @param input The request the cursor arrived with.
 * @param payloadSchema Zod schema for this source's payload shape.
 * @returns The decoded, validated payload.
 * @throws {InvalidCursorError} When the cursor is oversized, malformed, from
 *   a different request, or carries an unusable payload.
 */
export function decodeCursor<P extends z.ZodType>(
  cursor: string,
  input: ReferenceSearchInput,
  payloadSchema: P,
): z.infer<P> {
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new InvalidCursorError(
      "The cursor is too long to be valid. Start the search again without it.",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(decode(cursor)) as unknown;
  } catch {
    throw new InvalidCursorError(
      "The cursor is not readable. Start the search again without it.",
    );
  }

  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new InvalidCursorError(
      "The cursor is not readable. Start the search again without it.",
    );
  }
  if (
    envelope.data.s !== input.source ||
    envelope.data.t !== input.type ||
    envelope.data.q !== input.query ||
    envelope.data.l !== input.limit
  ) {
    throw new InvalidCursorError(
      "The cursor belongs to a different query, source, or limit. Start the search again without it.",
    );
  }

  const payload = payloadSchema.safeParse(envelope.data.c);
  if (!payload.success) {
    throw new InvalidCursorError(
      "The cursor is not readable. Start the search again without it.",
    );
  }
  return payload.data;
}

/**
 * Reads a cursor's payload, or a first-page fallback when none was sent.
 *
 * Every reference source has a natural first page, so an absent cursor is
 * not an error: handlers pass their default (an offset of 0, a start of 0)
 * and this returns it unchanged.
 *
 * @param input The request the cursor arrived with.
 * @param payloadSchema Zod schema for this source's payload shape.
 * @param fallback The first-page payload to use when no cursor was sent.
 */
export function readCursor<P extends z.ZodType>(
  input: ReferenceSearchInput,
  payloadSchema: P,
  fallback: z.infer<P>,
): z.infer<P> {
  return input.cursor === undefined
    ? fallback
    : decodeCursor(input.cursor, input, payloadSchema);
}
