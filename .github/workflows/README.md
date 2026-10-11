# Why publishing is tag-gated

`publish.yml` runs on a `v*` tag, and on manual dispatch with a `dry-run`
input that DEFAULTS TO TRUE. Two reasons:

- **It is irreversible.** npm rejects a republish of an existing version, so a
  mistake means burning the version number, not reverting it.
- **The tag is the review unit.** Tagging a commit is a deliberate act; a push
  to `main` is not. Publishing from a tag means the artifact a user installs
  corresponds to a commit someone chose.

The workflow runs `npm run check` (source soundness) and then
`npm run prepublish-check` (the packed tarball), because those prove different
things. `check` can pass while the tarball omits a build output.

Required secret: `NPM_TOKEN`, an automation token for the `dsh-market` package.
Provenance needs `id-token: write`, which is already set.
