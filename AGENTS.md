# AGENTS.md

Instructions and steering for AI coding agents working in this repository.

This is the repository for **Open Drug Data MCP**, a local MCP (Model Context
Protocol) server that gives an agent one read-only research interface over
openFDA, CosIng, RxNorm, DailyMed, DrugCentral, NIH DSLD, and INKEEDecoder. It
is served over stdio, runnable with `npx`, and intended for npm publication
via Changesets + OIDC trusted publishing (published after the first release).

It began as the knorby TypeScript MCP template. The template's setup, testing,
and release guardrails still apply and are kept below; the project-specific
steering follows them.

---

## Setup

### System requirements

Before installing git hooks, ensure the following are available on the
system:

1. **Node.js 24 (LTS)** — use [nvm](https://github.com/nvm-sh/nvm) or
   [fnm](https://github.com/Schniz/fnm); this repo includes an `.nvmrc`.
2. **npm** — bundled with Node.
3. **pre-commit** — install via `pipx install pre-commit` or
   `brew install pre-commit`. Handles file hygiene + secret scanning.
4. **gitleaks** — install via `brew install gitleaks` or see
   <https://github.com/gitleaks/gitleaks>. The hook uses the
   system-installed binary (`gitleaks-system` hook ID) for lightweight
   regex-based secret scanning.
5. **Go toolchain** — required for the TruffleHog hook, which pre-commit
   builds from source in an isolated GOPATH on first run (slow; cached
   afterward). Install via `brew install go` or see <https://go.dev/dl/>.
6. **shellcheck** is **not** a system dependency — `shellcheck-py` ships its
   own bundled binary.

### Install dependencies and hooks

```bash
nvm use                  # or: fnm use
npm install              # installs deps (does NOT run prepare — see .npmrc)
npx husky                # set up Husky hooks (blocked by ignore-scripts)
pre-commit install       # wire pre-commit hooks into .git/hooks/
pre-commit run --all-files  # validate against the entire repo
```

`npm install` does **not** run the `prepare` script because `.npmrc` sets
`ignore-scripts=true` (supply-chain security — blocks dependency postinstall
scripts). Run `npx husky` separately to set up the Husky-managed hooks
(pre-commit → lint-staged, commit-msg → commitlint). `pre-commit install`
separately sets up the pre-commit-managed hooks (file hygiene + secret
scanning). Both are needed for full coverage.

### Adding and removing hooks

- **Prefer existing hooks.** Always check the pre-commit hooks index
  (<https://pre-commit.com/hooks.html>) and the featured repositories
  (<https://pre-commit.com/hooks.html#featured-hooks>) before writing a custom
  hook. Existing, maintained hooks are preferred over custom ones.
- **If no existing hook can satisfy a requirement**, flag this in your output
  and request input before adding a custom hook.
- **TypeScript linting/formatting** is handled by **Biome** via Husky +
  lint-staged (see `.husky/pre-commit`). Do not add a TS linter to
  `.pre-commit-config.yaml`; use Husky/lint-staged for that.
- **TruffleHog**: replaceable with another secret scanner if preferred. Both
  gitleaks and TruffleHog run in pre-commit. If CI-based secret scanning is
  also desired (e.g. to catch secrets when hooks are skipped), add a workflow
  in `.github/workflows/` and document it here.
- **Hook revisions** are pinned. Bump deliberately and review changelogs.
- Reference: <https://pre-commit.com/hooks.html>

---

## Development commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build the server (tsup ESM bundle + `tsc --emitDeclarationOnly`) |
| `npm run dev` | Run the server from source with `tsx watch` |
| `npm run inspect` | Open the MCP Inspector web UI against the built server |
| `npm run inspect:cli` | Call `tools/list` through the Inspector CLI |
| `npm run test:smoke` | Inspector CLI smoke test against `dist/` (used by CI) |
| `npm run lint` | Lint + formatting check with Biome (read-only) |
| `npm run format` | Format with Biome (writes changes) |
| `npm run check` | Lint + format in one pass (writes changes) |
| `npm run typecheck` | Type-check `src/` + `tests/` with `tsc` (uses `tsconfig.test.json`, no emit) |
| `npm test` | Run tests once (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage reporting |
| `npx changeset` | Create a changeset (required for any change that affects published output) |

---

## Testing and CI

- Tests live in `tests/` and use **Vitest**. Add test files as
  `*.test.ts` alongside or under `tests/`.
- **Test through a real client.** `tests/helpers.ts` exposes
  `createTestClient()`, which serves the server in-process via
  `createMcpHandler` + `handler.fetch` and connects a real `Client` to it — no
  port, no socket, no protocol mocks. Prefer this over calling tool handlers
  directly; it exercises schema validation and registration the way a host
  does. Assert on `structuredContent`; failures resolve as results with
  `isError: true` rather than throwing. Stub HTTP with
  `vi.stubGlobal("fetch", …)`.
- **Cover stdio by spawning the process.** `tests/stdio.test.ts` runs the built
  binary through `StdioClientTransport` and skips itself when `dist/` is absent.
- **Inspect manually with** `npm run inspect` (web UI) or
  `npm run inspect:cli` (scriptable `tools/list`).
- **GitHub Actions** runs the full check suite on every push to `main` and on
  PRs against `main` (see `.github/workflows/tests.yml`):
  - `npm run lint` (Biome — lint + formatting; formatting is enforced in CI,
    so run `npm run check` before committing if hooks are skipped)
  - `npm run typecheck` (tsc, src + tests)
  - `npm run build` (tsup)
  - `npm run test:coverage` (Vitest with the 100% thresholds)
  - `npm run test:smoke` (MCP Inspector CLI `tools/list` against `dist/`)
  - `npm pack --dry-run` (published files are only `dist/`, `README.md`,
    `CHANGELOG.md`, and `LICENSE`)
  - a stdout-purity check (`echo '{}' | node dist/index.js` must write nothing
    to stdout)
  - `npm audit --audit-level=moderate` (vulnerability scan)
- The **pre-commit suite** (file hygiene + secret scanning) also runs in CI
  via `.github/workflows/pre-commit.yml` on every push to `main` and PRs
  against `main` (`pre-commit run --all-files --show-diff-on-failure` with
  `SKIP=no-commit-to-branch`, which would otherwise always fail on main pushes
  by design). The workflow installs a system gitleaks binary matching the rev
  in `.pre-commit-config.yaml`; the trufflehog golang hook uses the Go
  toolchain preinstalled on ubuntu-latest.
- Husky hooks (Biome + commitlint) remain local only.
- Optional security scanning additions (free for public repos): CodeQL
  (<https://github.com/github/codeql-action>), gitleaks-action
  (<https://github.com/gitleaks/gitleaks-action>), Semgrep
  (<https://github.com/returntocorp/semgrep-action>). Add workflows in
  `.github/workflows/` if desired and document them here.

---

## Versioning and publishing

This repo uses [Changesets](https://github.com/changesets/changesets) for
versioning. Versioning is **decoupled from merges** — you can merge multiple
PRs and release them all at once.

- **Before a PR that changes published output**: run `npx changeset`, select
  bump type (patch/minor/major), write a summary. Commit the generated
  `.changeset/*.md` file alongside the code change.
- **To release**: `npx changeset version` (bumps `package.json` +
  `CHANGELOG.md`), then `npm run release` (builds + publishes).
- **GitHub Actions release** (`workflow-templates/release.yml`): ships
  **staged** — GitHub only runs workflows from `.github/workflows/`, so this
  workflow is inert in the template repo (no publish attempts on pushes to
  `main`). To activate in a repo created from this template:
  `git mv workflow-templates/release.yml .github/workflows/release.yml`.
  Once active, it runs on every push to `main` (and can be triggered
  manually via `workflow_dispatch`, e.g. to retry after a transient publish
  failure): with no pending changesets
  it is a no-op. With changesets, it opens a "Version Packages" PR
  (`changeset version` bumps the version string, updates `CHANGELOG.md`,
  and removes consumed changesets); merging that PR publishes to npm, tags,
  and creates a GitHub Release. Publishing uses OIDC trusted publishing — no
  npm token secrets are involved. Permissions follow the changesets v2
  sub-action split (`select-mode` → `version` | `pack` → `publish`);
  `id-token: write` is scoped to the publish job only.
- **Always verify before publishing**: `npm run build && npm pack --dry-run`
  to confirm only `dist/`, `README.md`, `CHANGELOG.md`, and `LICENSE` are
  included.

### One-time release setup (repository owner)

0. Activate the staged workflow:
   `git mv workflow-templates/release.yml .github/workflows/release.yml`.
1. Repo **Settings → Actions → General → Workflow permissions**: select **Read
   and write permissions**, and check **Allow GitHub Actions to create and
   approve pull requests**.
2. Repo **Settings → Environments**: create an environment named `release`.
3. On npmjs.com, add a **trusted publisher** for the package. Values must
   match the workflow exactly: this repository, workflow filename
   `release.yml`, environment `release`.
4. Enable npm 2FA: `npm profile enable-2fa auth-and-writes`.

### First publish (manual)

npm requires a package to exist before it can link a trusted publisher
([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the very first
publish is manual:

```bash
npm login
npm pkg delete publishConfig.provenance   # provenance needs CI + public repo
npm run release                           # build + changeset publish
npm pkg set publishConfig.provenance=true
git push origin main --follow-tags
gh release create vX.Y.Z --notes-from-tag
```

### Release failure quick reference

| Symptom | Likely cause / fix |
| --- | --- |
| `EOTP` errors | A token is being used on a 2FA-enabled account — trusted publishing (no token) avoids this |
| `ENEEDAUTH` / 401 on publish | npm < 11.5.1 (the workflow upgrades npm), or the trusted-publisher config on npmjs.com does not match exactly (repo, workflow filename, environment) |
| "not permitted to create pull requests" | Enable "Allow GitHub Actions to create and approve pull requests" in Actions settings |
| Provenance warning `provider: null` | Published locally instead of via CI — provenance only works from CI on a public repo |
| 404 "package not found" right after publishing | npm registry replication lag — retry in a minute |

### Publishing security

- **Trusted publishing (OIDC)** — the release workflow publishes with an OIDC
  token minted by GitHub Actions; there are no npm tokens involved (no
  `NPM_TOKEN` or `NODE_AUTH_TOKEN` secrets). The npm-side trusted-publisher
  config must match the workflow exactly. This is compatible with 2FA
  (`npm profile enable-2fa auth-and-writes`) because no token needs an OTP.
- **Provenance** — `publishConfig.provenance: true` in `package.json` enables
  npm provenance attestation (cryptographic link to commit + workflow).
  Provenance requires publishing from CI on a **public** repository; the
  manual first publish temporarily removes it (see "First publish").
- **Scoped names** — use `@knorby/package`-style scoped names to prevent
  dependency confusion attacks. Scoped packages default to restricted
  visibility, so `publishConfig.access: "public"` is set.
- **No secrets in published files** — the `files` field in `package.json`
  whitelists only `dist`, `README.md`, `CHANGELOG.md`, and `LICENSE`. Never
  add `src/`, `.env`, `tsconfig.json`, or other config to the `files` list.
- **`.npmrc`** — `ignore-scripts=true` blocks dependency `postinstall`
  scripts by default (supply-chain security). This also blocks this repo's
  own `prepare` script, so `npm install` will not auto-set-up Husky hooks —
  run `npx husky` after `npm install`, or use
  `npm install --ignore-scripts=false` to allow the prepare script.

---

## Guardrails and steering rules

These rules are mandatory. Follow them strictly.

### Git operations

- Do **not** perform git write operations — `commit`, `push`, `amend`, `tag`,
  create PRs — unless explicitly asked by the user.

### File removal

- `rm` is intentionally blocked in this environment. Do **not** attempt to
  bypass this restriction (no `find -delete`, `python -c "os.remove(...)"`,
  shell tricks, or alternative deletion methods).
- Use `git rm` for tracked files that need removal.
- If untracked files need removal, or if your action is required to remove
  something, **stop** and flag what needs to be removed and why in your output.

### MCP server rules

- **Never write to stdout.** In a stdio server stdout carries the JSON-RPC
  stream; one `console.log` corrupts it and breaks the host connection. Use
  `logInfo`, `logWarn`, and `logError` from `src/lib/log.ts` (all stderr).
- **Keep `createServer()` transport-agnostic.** Tool, resource, and prompt
  registration lives in `src/server.ts`; transports live in entrypoints. Adding
  HTTP means adding an entrypoint, not moving business logic.
- **Register with the modern API only** — `registerTool`, `registerResource`,
  `registerPrompt`. Never `server.tool()` or raw `setRequestHandler` calls.
- **Name tools `{service}_{action}`** in snake_case so tools from several
  servers don't collide in one host.
- **`.describe()` every input field**, and set `title`, `description`,
  `inputSchema`, `outputSchema`, and `annotations` on every tool.
- **Return errors as results** — `content` + `isError: true` with text saying
  what to do next. Never let an exception escape a tool handler.
- **Validate credentials lazily**, inside the tool, so a misconfigured server
  still answers `tools/list`.
- **Bound responses** — paginate large collections and respect
  `CHARACTER_LIMIT`.
- **Add a changeset for anything that changes published output.**

### Documentation

- Keep `AGENTS.md` and `README.md` up to date as part of any change that
  affects setup, conventions, or project structure.
- Use the `docs/` directory for higher-level design notes, architecture, and
  decision records (ADRs). See `docs/README.md` for the ADR template.
- Treat `docs/` as living documentation. Create an ADR in `docs/decisions/`
  for significant design decisions.

### Before declaring done

- Run all quality gates:
  ```bash
  npm run lint && npm run typecheck && npm test && npm run build && npm run test:smoke
  ```
  (`npm test` must run after `npm run build` at least once — `tests/stdio.test.ts`
  skips itself when `dist/` is missing.)
- Verify that `npm pack --dry-run` includes only `dist/`, `README.md`,
  `CHANGELOG.md`, and `LICENSE` (no source, config, or secret files).
- Verify the built server starts without writing to stdout:
  `echo '{}' | node dist/index.js` should produce only a stderr banner (or
  nothing), never stdout output.
- Verify that `AGENTS.md` and `README.md` still reflect the current state of
  the repository.

---

## Project: Open Drug Data MCP

Project-specific rules for this server. The template guardrails above remain
in force.

### What this server is

Seven tools over openFDA, CosIng, the NLM drug databases (RxNorm, RxTerms,
RxClass, DailyMed, MeSH, PubMed, MedlinePlus, UMLS, ClinicalTrials.gov),
DrugCentral, NIH DSLD, INKEEDecoder, and PubChem:

- `drugdata_ping` — diagnostics; no network.
- `drugdata_search_products` — name, brand, ingredient, barcode, or NDC.
- `drugdata_search_ingredients` — name, INCI, UNII, CAS, EC, RxCUI, or
  PubChem CID.
- `drugdata_get_product` — openFDA, DSLD, DailyMed, or INKEEDecoder.
- `drugdata_get_ingredient` — openFDA, CosIng, DrugCentral, RxNorm,
  INKEEDecoder, or PubChem.
- `drugdata_resolve_identifiers` — exactly one of `unii`, `ndc`, `rxcui`,
  `cid`, `cas`, `inci_name`, `substance_name`, `spl_setid`, `dsld_id`.
- `drugdata_search_references` — one NLM reference source per call
  (`prescribable`, `rxclass`, `mesh`, `pubmed`, `medlineplus`,
  `medlineplus_genetics`, `medlineplus_connect`, `umls`, `clinicaltrials`)
  by `name`, `rxcui`, `ndc`, or `cui`; link-first results (titles,
  identifiers, deep links), opaque-cursor pagination; UMLS needs
  `UMLS_API_KEY`.

The loop is search → resolve → get, plus a reference step for literature and
classification sources. Every search and resolution returns `nextSteps`.
Search results are entity-grouped, bounded, and credited to the upstream
database. `sources` holds per-database status/paging metadata, not duplicate
records. When modifying search, read ADR-0006 for clustering, deadline,
enrichment, and response-bounding invariants.

### Hard sourcing policy

These are release-blocking rules, not style preferences:

- **Upstream databases only in tool output.** Never name a client library,
  a package scope, or a client-shaped source label in result text,
  `structuredContent`, or an agent-facing error. The allowed database labels
  are `openFDA`, `CosIng`, `RxNorm`, `RxTerms`, `RxClass`, `DailyMed`,
  `DrugCentral`, `DSLD`, `INKEEDecoder`, `MeSH`, `PubMed`, `MedlinePlus`,
  `UMLS`, `ClinicalTrials.gov`, and `PubChem`. Internal logs on stderr may
  name a package for debugging.
- **Every record carries provenance.** A `SourceRef` has the upstream
  `database`, its own `id`, a deep-link `url`, and `retrievedAt`. Do not
  invent an id or a link.
- **Regulatory and label text is verbatim and attributed.** Keep the source's
  wording, label it, and never present it as our conclusion.
- **Errors name the database, not the client.** Adapters and boundaries
  author their failure text at the source: a failed source becomes an error
  group worded for the database, and unexpected rejections are reworded by
  `toUserMessage` (raw text goes to stderr only). There is no downstream
  text filtering, and none may be added. A new adapter or tool must keep
  this true.
- **Zero matches are normal.** They are empty groups, not errors. A failed
  source becomes an error group and must not fail the other groups.
- **No bulk download, mirroring, or caching.** Query at request time. Honor
  upstream rate limits and `robots.txt`; INKEEDecoder stays at one request per
  second through its shared client.
- **Verify source terms before adding a source.** Record the URL, retrieval
  date, license, and attribution in `docs/SOURCES.md`. Do not add a source
  whose terms forbid this read-only, link-back use.
- **The leak sweep is mandatory.** `tests/server.test.ts` calls every tool and
  asserts that serialized output contains no package names or client labels.
  Extend it for any new tool or source.

### Adapter architecture

```text
src/sources/types.ts        SourceAdapter contract + capability declarations
src/sources/registry.ts     search fan-out (allSettled) and lookup routing
src/sources/search/         pure entity clustering + deadline/enrichment coordinator
src/sources/<source>.ts     one adapter per upstream source module
src/sources/nlm-references/ reference search handlers + cursor pagination
src/tools/search-support.ts SEARCH_ADAPTERS, registry resolution, error groups
src/clients.ts              one shared client per source, uniform fetch policy
src/config.ts               source ids, labels, lazy environment config
```

An adapter speaks only the unified schemas in `src/lib/schemas.ts`. It declares
`databases`, `productSearchTypes`, `ingredientSearchTypes`, and
`productCategories`, and implements only the methods it can answer. The
registry never invents results; it forwards groups and synthesizes error groups
for a rejected adapter.

The NLM reference sources are not adapters: `drugdata_search_references`
dispatches to one handler per source in `src/sources/nlm-references/` through
`createReferenceSearcher`, because each answers a different shape of question
than product/ingredient search. PubChem is an adapter
(`src/sources/pubchem.ts`) that shares the NLM client and the `nlm`
disable id; it serves ingredient searches (name, CID) and ingredient
profiles (a `chemistry` block), not products. CID resolution uses PubChem
verification and DrugCentral's exact PUBCHEM_CID crosswalk; DrugCentral
`cd_id` is not a CID. RxCUI input is fetched before becoming a direct link.

#### Adding a source

1. Verify its terms and add a `docs/SOURCES.md` section (coverage, identifiers,
   publisher, terms URL + date, attribution, access mechanism, update cadence).
2. Create `src/sources/<name>.ts` with a factory that accepts an optional
   client and a singleton adapter export. Map upstream records into
   `ProductRef` / `IngredientRef` / profile schemas; reword every failure to
   the database name.
3. Add the shared client to `src/clients.ts` (one instance, same fetch policy).
   Add the package to `package.json` and pin a published semver range.
4. If the adapter needs a user-facing on/off id, add it to `SOURCE_IDS` and
   `SOURCE_LABELS` in `src/config.ts`; `drugdata_ping` and `server://info`
   pick it up from there.
5. Add the adapter to `SEARCH_ADAPTERS` in `src/tools/search-support.ts`. If it
   serves a product category, add it to `CATEGORY_ADAPTERS` in
   `src/sources/types.ts`.
6. If it participates in identity resolution, add a bridge in
   `src/sources/identity/chain.ts` and follow ADR-0003's confidence rules. A
   weak name match is a candidate, never a link.
7. Add fixture-backed tests for search, lookup, zero matches, and failures;
   extend the sourcing leak sweep; keep coverage at 100%.
8. Update the README source table and add a changeset.

Adding a search type is smaller: add the enum value in `src/sources/types.ts`,
add it to the tool's input enum, and declare it on the adapters that can
answer. Do not add a new tool for a new search type.

### Client-library change protocol

The six source dependencies in `package.json` are
`@knorby/openfda-client`, `@knorby/eu-cosing-client`,
`@knorby/nlm-drugs-client`, `@knorby/drugcentral-client`,
`@knorby/nih-dsld-client`, and `@knorby/inkeedecoder-client`. They are pinned
to published versions; this repo must never depend on a local checkout, a git
URL, or an unpublished commit.

If an upstream gap blocks a feature:

1. Prefer an MCP-side workaround. The shared fetch policy already adds
   timeout and 429 handling uniformly, and adapters can normalize ids and
   errors themselves.
2. If a client change is unavoidable, make it in that client's repository on
   a **fresh branch cut from its current default branch**. Add tests, keep the
   change minimal, and do not touch `main`.
3. **Flag it to the user** with the repository, branch name, and rationale.
   Never merge it, publish it, or point this repo at the branch. The user
   decides whether and when to release the client.
4. Until a fixed version is published, keep the MCP on the published range.

Known upstream limits are documented, not worked around by inventing data:
DrugCentral has no NDC → structure path, and CosIng CAS/EC search is
substring-based.

### Tests and coverage

- **100% coverage is the bar**, enforced by Vitest thresholds on statements,
  branches, functions, and lines. The only justified exclusion is
  `src/index.ts`, the stdio entry shim exercised by `tests/stdio.test.ts` in a
  subprocess. Do not lower a threshold, add an exclusion, or skip a test to
  get green.
- Use `tests/helpers.ts` `createTestClient()` for tool tests: a real in-process
  MCP client against the real server. Assert on `structuredContent`; failures
  resolve as `isError: true` results.
- Stub HTTP through each client's injectable `fetch`. Never require an API key
  or the network in a test. DSLD fixtures are hand-authored from the published
  v9 types because no data.gov key is available.
- Cover both output formats, zero matches, malformed ids, upstream failures,
  truncation, pagination, and the no-client-name leak sweep.
- The full gate, in order:
  `npm run lint && npm run typecheck && npm test && npm run test:coverage && npm run build && npm run test:smoke`.
  Then `npm pack --dry-run` and the stdout-purity check from the template
  section above.

### Protocol posture

- The server is **stateless by construction** and targets the 2026-07-28
  revision's stateless core: no sessions, no cross-call response caches, no
  mutable configuration after start.
- Do not use roots, sampling, or `logging/setLevel` (deprecated), and do not
  do work at `initialize` time. Let the SDK negotiate protocol eras.
- Keep tool registration in the fixed order in `src/server.ts`; tests pin it.
- Never write to stdout. Protocol data owns stdout; logs go to stderr.
- Keep `createServer()` transport-agnostic. An HTTP entrypoint, if ever added,
  is an entrypoint, not a change to tool logic.

### Documentation and release

- `docs/SOURCES.md` is the source-of-truth for coverage, terms, and
  attribution. `README.md` carries the short disclaimer and links to it.
- ADR-0001 records the platform and protocol posture; ADR-0002 the unified
  interface and sourcing policy; ADR-0003 the identity chain; ADR-0004 the
  INKEEDecoder inclusion.
- Add a changeset for any published-output change. The release workflow is
  staged at `workflow-templates/release.yml`; activation waits for the public
  move, and the template's release setup above still applies.
- Keep `docs/superpowers/` out of git. It is local planning scratch for a
  repository that is destined to be public.
