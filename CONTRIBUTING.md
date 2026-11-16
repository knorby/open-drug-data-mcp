# Contributing

Thanks for contributing! This guide covers getting set up and the development
workflow.

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
docs: update development setup
```

## Pull request process

1. Create a branch from `main`.
2. Make your changes.
3. Ensure all checks pass: `npm run lint && npm run typecheck &&
   npm run test:coverage && npm run build && npm run test:smoke`.
4. Open a PR against `main`. CI runs lint, typecheck, build, coverage tests,
   the smoke test, package-content and stdout-purity checks, Codecov upload,
   and `npm audit`, plus the pre-commit suite (file hygiene + secret scanning).
5. After review, merge.
