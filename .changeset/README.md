# Changesets

This MCP is private, in development, and has never been released. Do not add
per-change changesets during this stage; there is no released baseline.

After the first release, Changesets manage versioning and changelogs. Each change is
recorded as a markdown file in this directory; when you're ready to release,
changesets consumes them to bump the version and generate the changelog.

## Workflow after the first release

1. **Make your code changes** (feature, bugfix, etc.) on a branch.
2. **Create a changeset** describing the change:
   ```bash
   npx changeset
   ```
   Select patch / minor / major, write a short summary. A new `.md` file
   appears in `.changeset/` — commit it alongside your code.
3. **Open a PR** with both the code change and the changeset file.
4. **Release** when ready:
   ```bash
   npx changeset version   # bumps package.json + writes CHANGELOG.md
   npm run release          # builds + publishes to npm
   ```

For automated releases via GitHub Actions (opens a "Version Packages" PR that
publishes on merge), activate the staged release workflow by moving it into
place:

```bash
git mv workflow-templates/release.yml .github/workflows/release.yml
```

See the README "Versioning and publishing" section for the one-time setup.

The `.md` files in this directory are consumed and deleted by `changeset version`.
