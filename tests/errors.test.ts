import { describe, expect, it } from "vitest";
import { toUserMessage } from "../src/lib/errors.js";

/** An `Error` carrying an HTTP status the way the clients' API errors do. */
function statusError(status: unknown, message = "upstream failure"): Error {
  return Object.assign(new Error(message), { status });
}

describe("toUserMessage", () => {
  it("maps a 404 status property to a not-found message", () => {
    const message = toUserMessage(statusError(404), "Search");

    expect(message).toContain("Search");
    expect(message).toContain("not found");
    expect(message).toContain("HTTP 404");
  });

  it("maps a 429 embedded in the message to a rate-limit message", () => {
    const error = new Error(
      "Request to https://example.test/items failed: 429 Too Many Requests",
    );

    const message = toUserMessage(error, "Search");

    expect(message).toContain("rate limited");
    expect(message).toContain("HTTP 429");
  });

  it("maps a 5xx status to a temporary-unavailable message", () => {
    const message = toUserMessage(statusError(503), "Search");

    expect(message).toContain("HTTP 503");
    expect(message).toContain("temporarily unavailable");
  });

  it("maps other statuses generically", () => {
    const message = toUserMessage(statusError(403), "Search");

    expect(message).toContain("HTTP 403");
    expect(message).not.toContain("upstream failure");
  });

  it("reads a status embedded as 'returned HTTP'", () => {
    const message = toUserMessage(
      new Error("RxNorm returned HTTP 400"),
      "Search",
    );

    expect(message).toContain("HTTP 400");
  });

  it("maps an AbortError to a cancellation message", () => {
    const message = toUserMessage(
      new DOMException("This operation was aborted", "AbortError"),
      "Search",
    );

    expect(message).toContain("cancelled");
  });

  it("maps an abort wrapped in a client's own error message", () => {
    const message = toUserMessage(
      new Error("Request aborted before it was sent."),
      "Search",
    );

    expect(message).toContain("cancelled");
  });

  it("maps a TimeoutError by name", () => {
    const message = toUserMessage(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
      "Search",
    );

    expect(message).toContain("timed out");
    expect(message).toContain("DRUGDATA_TIMEOUT_MS");
  });

  it("maps a timeout by message wording", () => {
    const message = toUserMessage(
      new Error("openFDA request timed out after 30000ms"),
      "Search",
    );

    expect(message).toContain("timed out");
  });

  it("maps a network failure", () => {
    const message = toUserMessage(new Error("fetch failed"), "Search");

    expect(message).toContain("could not reach the upstream service");
  });

  it("falls back for a non-Error value", () => {
    expect(toUserMessage("boom", "Search")).toContain(
      "failed unexpectedly: boom",
    );
  });

  it("ignores a non-numeric status property", () => {
    expect(
      toUserMessage(statusError("404", "odd failure"), "Search"),
    ).toContain("failed unexpectedly: odd failure");
  });

  it("handles null", () => {
    expect(toUserMessage(null, "Search")).toContain(
      "failed unexpectedly: null",
    );
  });
});
