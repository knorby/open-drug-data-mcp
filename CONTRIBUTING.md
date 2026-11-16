# Contributing

Thanks for contributing! This guide covers getting set up, the development
workflow, and how to publish releases.

## Prerequisites

- **Node.js 22+** (Node 24 LTS recommended; use
  [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm);
  this repo includes an `.nvmrc`)
- **npm** (bundled with Node)
- **pre-commit** — `pipx install pre-commit` or `brew install pre-commit`
- **gitleaks** — `brew install gitleaks` (secret scanner for pre-commit)
- **Go toolchain** — `brew install go` (required once for the TruffleHog hook
  build)

## Getting started

```bash
git clone https://github.com/knorby/open-drug-data-mcp.git
cd open-drug-data-mcp
nvm use              # or: fnm use
npm install          # installs deps (prepare blocked by .npmrc ignore-scripts)
npx husky            # sets up Husky hooks (run after npm install)
pre-commit install   # sets up pre-commit hooks for file hygiene + secrets
```

## Development commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build the server (tsup ESM bundle + `tsc` declarations) |
| `npm run dev` | Run the server from source with `tsx watch` |
| `npm run inspect` | Open the MCP Inspector web UI against the built server |
| `npm run inspect:cli` | Call `tools/list` through the Inspector CLI |
| `npm run test:smoke` | Inspector CLI smoke test against `dist/` (used by CI) |
| `npm run lint` | Lint + formatting check with Biome (read-only) |
| `npm run format` | Format with Biome (writes changes) |
| `npm run check` | Lint + format in one pass (writes changes) |
| `npm run typecheck` | Type-check `src/` + `tests/` with `tsc` (no emit) |
| `npm test` | Run tests once (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage reporting |

## Testing

Three layers, cheapest first:

1. **In-process integration tests** — `createTestClient()` in
   `tests/helpers.ts` serves the server through `createMcpHandler` and connects
   a real `Client`, so tests exercise registration and schema validation with no
   port and no protocol mocks. Assert on `structuredContent`; failures come back
   with `isError: true` instead of throwing.
2. **stdio spawn test** — `tests/stdio.test.ts` runs the built binary through
   `StdioClientTransport`. It skips itself when `dist/` is absent, so run
   `npm run build` first to include it.
3. **Inspector smoke test** — `npm run test:smoke` lists tools through the
   Inspector CLI against `dist/`. CI runs this after the build.

Explore by hand with `npm run inspect` (web UI), or
`npx @modelcontextprotocol/inspector --cli` / `--tui`.

Never write to stdout in server code — it carries the JSON-RPC stream. Use
`logInfo`/`logWarn`/`logError` from `src/lib/log.ts`.

## Git hooks

This repo uses **two** git hook managers that complement each other:

1. **pre-commit** — file hygiene (whitespace, EOL, YAML/JSON validation),
   secret scanning (gitleaks + TruffleHog), and shellcheck. Enforces
   `no-commit-to-branch` to protect `main`/`master`.

2. **Husky** — TypeScript-specific checks on staged files:
   - `pre-commit`: runs `lint-staged` (Biome format + lint on staged files
     only)
   - `commit-msg`: runs `commitlint` to enforce
     [conventional commits](https://www.conventionalcommits.org/)

You need both for full coverage:
```bash
pre-commit install
npx husky   # prepare script is blocked by .npmrc ignore-scripts=true
```

## Commit messages

This repo enforces [conventional commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`,
`perf`, `ci`.

Examples:
```
feat(auth): add token refresh logic
fix: handle null response from API
docs: update README with publish instructions
```

## Versioning and releases

Releases are cut by a **version bump in a pull request**. Ordinary changes can
merge without releasing; a PR that raises the version releases on merge.

### Cutting a release

In the release PR, update all of these together:

- `version` in `package.json` and `server.json`;
- both root version fields in `package-lock.json` (`npm install --package-lock-only`
  updates them);
- `CHANGELOG.md` with the release entry.

`tests/metadata.test.ts` keeps the package and registry metadata consistent.

### Releasing

**Automated release (default):** `.github/workflows/release.yml` runs on every
push to `main`. A `check` job compares `package.json`'s version against npm:

- **version not on npm** (a merged bump) → the `release` job runs the metadata
  suite, builds, smoke-tests, publishes to npm via OIDC, and creates the
  `v<version>` GitHub Release;
- **version already published** → the release job is skipped;
- **retry** → `workflow_dispatch` re-runs the release half; `npm publish` and
  GitHub Release creation are guarded against existing artifacts.

A separate `mcp-registry` job runs after every release outcome, including a
skip or failure, so it can publish or backfill the Official MCP Registry record
for an npm version that already exists. It uses GitHub OIDC and verifies the
published record through the public API. See
[`docs/publishing-registries.md`](docs/publishing-registries.md).

CI never writes to a branch and never opens a PR.

**First publish (manual, required once):** npm requires a package to exist
before it can link a trusted publisher, so `@knorby/open-drug-data-mcp` 0.1.0 is
published by hand before the workflow can take over. Run these commands from
the `0.1.0` release branch **before merging its PR**, so the newly active
workflow does not race the manual publish:

```bash
npm login
npm pkg delete publishConfig.provenance   # provenance needs CI + a public repo
npm run build
npm pack --dry-run                        # confirm the file list first
npm run release                           # build + npm publish
npm pkg set publishConfig.provenance=true
```

After the release PR merges, the workflow skips the existing npm version and
publishes the MCP Registry record. Create the first GitHub Release manually:

```bash
gh release create v0.1.0 --target main --title "v0.1.0" --generate-notes
```

**One-time setup after the first publish (repository owner):**

1. Repo **Settings → Actions → General → Workflow permissions**: select
   **Read and write permissions** (the workflow scopes the token per job).
2. Repo **Settings → Environments**: create an environment named `release`.
3. On npmjs.com, add a **trusted publisher** for the package. Values must
   match the workflow exactly: this repository, workflow filename `release.yml`,
   environment `release`.
4. Enable npm 2FA: `npm profile enable-2fa auth-and-writes`.
5. Activate the repository on [Codecov](https://codecov.io/gh/knorby/open-drug-data-mcp).
   Coverage uploads use OIDC and need no token on a public repository.

**Manual release (fallback):** after updating all version and changelog files,
run `npm run release` to build and publish to npm. Create the GitHub Release
and publish the MCP Registry metadata with `mcp-publisher` if the workflow is
unavailable.

### Before publishing, always verify

```bash
npm run build
npm pack --dry-run    # verify only dist/, README.md, CHANGELOG.md, LICENSE
```

## Publishing security

- **Trusted publishing (OIDC)** — the release workflow publishes with an OIDC
  token minted by GitHub Actions; there are no npm tokens (no `NPM_TOKEN`
  secret). Compatible with 2FA (`npm profile enable-2fa auth-and-writes`)
  because no token needs an OTP.
- **Provenance** — this repo publishes with `--provenance` (cryptographic
  attestation linking the published package to the commit + workflow).
  Requires a public repo and publishing from CI; the manual first publish
  temporarily removes `publishConfig.provenance`.
- **Scoped name** — `@knorby/open-drug-data-mcp` prevents dependency confusion;
  `publishConfig.access: "public"` is set because scoped packages default to
  restricted visibility.
- **No secrets in the package** — the `files` field in `package.json`
  whitelists only `dist`, `README.md`, `CHANGELOG.md`, and `LICENSE`.

## Pull request process

1. Create a branch from `main`.
2. Make your changes. If the PR is meant to release, update the version files and changelog together.
3. Ensure all checks pass: `npm run lint && npm run typecheck &&
   npm run test:coverage && npm run build && npm run test:smoke`.
4. Open a PR against `main`. CI runs lint, typecheck, build, coverage tests,
   the smoke test, package-content and stdout-purity checks, Codecov upload,
   and `npm audit`, plus the pre-commit suite (file hygiene + secret scanning).
5. After review, merge. A version-bump PR releases on merge; other PRs do not.
