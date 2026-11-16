# Publishing: npm and the MCP Registry

The npm package, GitHub Release, and [Official MCP Registry](https://registry.modelcontextprotocol.io)
listing are published by `.github/workflows/release.yml` after a version-bump
PR merges to `main`. The one-time manual first publish is the exception; see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Version consistency

`package.json` is the source of truth. `server.json` repeats its name, version,
and MCP ownership marker; `tests/metadata.test.ts` pins those relationships so
a partial version bump fails before publication.

## Official MCP Registry

The registry hosts **metadata only**; the npm package is the artifact. The
release workflow's dedicated `mcp-registry` job publishes `server.json` after
any `release` outcome — success, skip, or failure — so an npm version cannot be
stranded without a registry record.

The job first reads the exact version from the registry:

```text
https://registry.modelcontextprotocol.io/v0.1/servers/io.github.knorby%2Fopen-drug-data-mcp/versions/<version>
```

HTTP 200 skips publication, HTTP 404 proceeds, and any other status fails the
job rather than treating an outage as a missing version. Before publishing, the
job verifies the exact npm version and its `mcpName` ownership marker. It then
runs `mcp-publisher validate`, installs a pinned `mcp-publisher` release and
verifies its Sigstore bundle, authenticates with `login github-oidc` (the job's
`id-token: write` — no secret, no PAT), publishes, and reads the stored record
back through the same URL. The public API omits default `isRequired: false` and
`isSecret: false` fields, so the read-back comparison normalizes those defaults
while still checking `name`, `version`, and the complete package entry. Because
auth is GitHub-OIDC, the server name must stay under `io.github.knorby/`, which
`mcpName` in `package.json` pins.

A failed registry job can be rerun on the same version; no new npm release or
version bump is needed. Rerunning when the record already exists is also safe:
the initial HTTP 200 skips every publish step.

Manual fallback (local): `brew install mcp-publisher`, then
`mcp-publisher login github && mcp-publisher publish` from the repo root.

`server.json` carries the schema `2025-12-11`, the npm package reference, stdio
transport, and all supported environment variables. The registry is in preview;
verify field expectations against the
[quickstart](https://modelcontextprotocol.io/registry/quickstart) if validation
fails.
