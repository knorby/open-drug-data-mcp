# ADR-0001: Platform and protocol posture — SDK v2, stdio, ESM-only, stateless

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

This repository began as the knorby TypeScript MCP server template. Its
template ADR-0001 recorded three platform decisions that remain true for this
project: MCP TypeScript SDK v2, a stdio-only local server, and an ESM-only
build. That ADR is superseded by this one so the platform rationale lives with
the product it describes instead of in template history.

Two further forces shape the platform:

1. The 2026-07-28 MCP revision defines a stateless protocol core. Servers may
   keep no per-session state, and capability discovery, identity, and
   multi-round tool results are carried per request.
2. This server aggregates seven upstream databases. It must not accumulate
   cross-call caches or per-session state that would make a request depend on
   which process answered the previous one.

The server is consumed as a `bin`: a host spawns it, speaks JSON-RPC over
stdio, and owns its lifecycle. Tests also import the server factory directly.

## Decision

- **SDK v2 only.** Use the v2 MCP TypeScript server SDK (2.3.x line) with a
  Zod-based schema validator, `registerTool`/`registerResource`/
  `registerPrompt`, and no v1 compatibility shims.
- **stdio only, transport-agnostic factory.** `src/index.ts` is the only
  entrypoint and installs stdio. `createServer()` in `src/server.ts` registers
  every primitive without knowing the transport, so an HTTP entrypoint can be
  added later without moving business logic.
- **ESM-only, Node ≥ 22.** Ship an ESM bundle and one library export (the
  server factory) plus the `bin`. Node 22 is the floor because the NLM client
  requires it; development uses Node 24 LTS and the Inspector needs 22.19+.
- **Stateless by construction.** No sessions, no cross-call response caches,
  and no mutable configuration after process start. Configuration is read
  lazily and cached per process; it is not changed by a request.
- **No deprecated protocol features.** Do not use roots, sampling, or
  `logging/setLevel`. Do not perform work at `initialize` time. Let the SDK
  negotiate protocol eras; the server itself speaks the same stateless
  surface under either era.
- **Deterministic registration order.** Register the six tools in their
  documented order and keep `tools/list` stable, as the 2026-07-28 revision
  recommends for client caching.
- **Test the real protocol surface.** Primary tests drive an in-process MCP
  client against the actual server; a subprocess test covers the stdio binary;
  an Inspector `tools/list` smoke test covers the packaged build. Coverage is
  100% on statements, branches, functions, and lines, excluding only the
  stdio entry shim that can only run as a subprocess.

## Consequences

- Node-only. There is no browser or React Native build, and no CJS consumer.
- No HTTP transport ships in v1. Adding one is an entrypoint change, not a
  redesign, and statelessness makes a future deployment round-robin safe.
- The server cannot cache upstream responses. That costs repeated requests,
  but avoids staleness bugs and keeps every result's `retrievedAt` honest.
- Era handling, `server/discover`, and cache-hint machinery belong to the
  SDK. Upgrading the SDK can change negotiated behavior; tests must pin the
  parts this server relies on.
- Tests that assert registration order or instruction text are load-bearing,
  not incidental.
- The only coverage exclusion is `src/index.ts`, with a comment explaining
  why. Lowering a threshold or excluding another file requires a new decision,
  not a config edit.
