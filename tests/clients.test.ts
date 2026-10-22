import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientDeadlineMs, getClients, resetClients } from "../src/clients.js";
import { resetConfig } from "../src/config.js";
import { withFetchPolicy } from "../src/lib/fetch-policy.js";
import { jsonResponse } from "./helpers.js";

/**
 * The shared-fetch policy and the module-level client cache.
 *
 * The policy tests never touch a real network: each `fetch` stub follows the
 * Web `fetch` contract closely enough to prove timeout and retry behavior.
 */

const ENV_KEYS = [
  "OPENFDA_API_KEY",
  "DSLD_API_KEY",
  "DRUGDATA_TIMEOUT_MS",
  "DRUGDATA_DISABLED_SOURCES",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/** A `fetch` stub that never settles until its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
}

function tooManyRequests(retryAfter?: string): Response {
  return new Response(null, {
    status: 429,
    headers:
      retryAfter === undefined ? undefined : { "retry-after": retryAfter },
  });
}

describe("withFetchPolicy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns non-429 responses without retrying", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    await expect(policyFetch("https://example.test/")).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the request init and composes the caller's signal", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Response("ok", { status: 200 });
      },
    );
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    await policyFetch("https://example.test/", {
      method: "POST",
      headers: { "x-trace": "abc" },
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "x-trace": "abc" });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(controller.signal);

    controller.abort();
    expect(seenSignal?.aborted).toBe(true);
    expect(seenSignal?.reason).toBe(controller.signal.reason);
  });

  it("aborts a hanging request at timeoutMs", async () => {
    const fetchMock = hangingFetch();
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 20 });

    await expect(policyFetch("https://example.test/")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = hangingFetch();
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 10_000 });

    await expect(
      policyFetch("https://example.test/", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives each attempt its own timeout signal", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return signals.length === 1
          ? tooManyRequests("0")
          : new Response("ok", { status: 200 });
      },
    );
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    await policyFetch("https://example.test/");

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("retries once on 429 with Retry-After: 0, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tooManyRequests("0"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    const response = await policyFetch("https://example.test/");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels the discarded 429 body before retrying", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(body, {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    const response = await policyFetch("https://example.test/");

    expect(response.status).toBe(200);
    expect(cancelled).toBe(true);
  });

  it("still retries when the discarded 429 body cannot be cancelled", async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error("cannot cancel");
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(body, {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    const response = await policyFetch("https://example.test/");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a second 429 instead of retrying again", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tooManyRequests("0"));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    const response = await policyFetch("https://example.test/");

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After seconds before retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tooManyRequests("2"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 10_000 });

    const pending = policyFetch("https://example.test/");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a short default delay when Retry-After is absent", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tooManyRequests())
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 10_000 });

    const pending = policyFetch("https://example.test/");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when Retry-After exceeds five seconds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tooManyRequests("6"));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    const response = await policyFetch("https://example.test/");

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when Retry-After is not a number of seconds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tooManyRequests("Wed, 21 Oct 2026 07:28:00 GMT"));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    const response = await policyFetch("https://example.test/");

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when retries is zero", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tooManyRequests("0"));
    const policyFetch = withFetchPolicy(fetchMock, {
      timeoutMs: 1_000,
      retries: 0,
    });

    const response = await policyFetch("https://example.test/");

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the retry wait when the caller cancels mid-flight", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(tooManyRequests("5"));
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 10_000 });

    const pending = policyFetch("https://example.test/", {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a retry when the caller cancelled before the wait", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return tooManyRequests("0");
    });
    const policyFetch = withFetchPolicy(fetchMock, { timeoutMs: 1_000 });

    await expect(
      policyFetch("https://example.test/", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getClients", () => {
  beforeEach(() => {
    clearEnv();
    resetConfig();
    resetClients();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearEnv();
    resetConfig();
    resetClients();
  });

  it("constructs all six clients and caches them", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const clients = getClients();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clients.openfda.drug.ndc).toBeDefined();
    expect(clients.cosing.ingredients).toBeDefined();
    expect(clients.nlm.rxNorm).toBeDefined();
    expect(clients.drugcentral.guide).toBeDefined();
    expect(clients.dsld.label).toBeDefined();
    expect(clients.inkeedecoder.fetchHtml).toBeTypeOf("function");

    expect(getClients()).toBe(clients);
    expect(getClients().openfda).toBe(clients.openfda);
  });

  it("resetClients clears the cache so the next call builds fresh instances", () => {
    vi.stubGlobal("fetch", vi.fn());
    const first = getClients();

    resetClients();
    const second = getClients();

    expect(second).not.toBe(first);
    expect(second.openfda).not.toBe(first.openfda);
    expect(second.cosing).not.toBe(first.cosing);
    expect(second.inkeedecoder).not.toBe(first.inkeedecoder);
  });

  it("passes the configured API keys to the clients", async () => {
    process.env.OPENFDA_API_KEY = "openfda-test-key";
    process.env.DSLD_API_KEY = "dsld-test-key";
    resetConfig();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ results: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const clients = getClients();
    await clients.openfda.drug.ndc.search({ limit: 1 });
    await clients.dsld.version.get();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls[0]).toContain("api_key=openfda-test-key");
    expect(urls[1]).toContain("api_key=dsld-test-key");
  });

  it("passes the policy-covering deadline to clients that accept one", () => {
    process.env.DRUGDATA_TIMEOUT_MS = "1234";
    resetConfig();
    vi.stubGlobal("fetch", vi.fn());

    const clients = getClients();

    // DrugCentral exposes its constructor config; the same deadline is passed
    // to every client that has the option. It must exceed the policy's worst
    // case so the client's own timer cannot preempt a retry's fresh budget.
    expect(clients.drugcentral.config.timeoutMs).toBe(clientDeadlineMs(1234));
    expect(clients.drugcentral.config.timeoutMs).toBeGreaterThan(1234);
  });

  it("sizes the client deadline around two attempts and a five-second wait", () => {
    expect(clientDeadlineMs(100)).toBe(100 * 2 + 5_000 + 1_000);
  });

  it("gives a retried 429 a fresh per-attempt budget", async () => {
    process.env.DRUGDATA_TIMEOUT_MS = "1000";
    resetConfig();

    let secondSignal: AbortSignal | undefined;
    let markSecondStart = (): void => {};
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStart = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          // A slow 429 consumes half of the client's old total deadline but
          // none of the retry's per-attempt budget.
          await new Promise((resolve) => setTimeout(resolve, 500));
          return tooManyRequests("0");
        }
        secondSignal = init?.signal ?? undefined;
        markSecondStart();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const clients = getClients();
    const request = clients.openfda.drug.ndc.search({ limit: 1 });
    const outcome = request.then(
      () => "resolved",
      () => "rejected",
    );

    await secondStarted;
    // At 750 ms into the retry, the old client deadline (1000 ms total) has
    // already aborted, while the fresh 1000 ms attempt budget has not.
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(secondSignal?.aborted).toBe(false);

    await expect(outcome).resolves.toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads configuration only when clients are first requested", async () => {
    process.env.DRUGDATA_TIMEOUT_MS = "0";
    vi.resetModules();

    const module = await import("../src/clients.js");

    expect(module.getClients).toBeTypeOf("function");
    expect(() => module.getClients()).toThrow(/DRUGDATA_TIMEOUT_MS/);
  });
});
