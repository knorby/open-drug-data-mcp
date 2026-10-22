import { describe, expect, it } from "vitest";
import { abortReason, throwIfAborted } from "../src/lib/abort.js";

describe("abort helpers", () => {
  it("returns the caller's aborted reason", () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled for a test"));

    expect(abortReason(controller.signal)).toBe(controller.signal.reason);
  });

  it("builds a cancellation DOMException when no reason is set", () => {
    const signal = { aborted: true, reason: undefined } as AbortSignal;
    expect(abortReason(signal)).toBeInstanceOf(DOMException);
    expect(abortReason()).toBeInstanceOf(DOMException);
  });

  it("throws only when the signal is aborted", () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow();
  });
});
