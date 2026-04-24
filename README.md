# Shellular Node Packages

1. [cli](./cli)
2. [@shellular/protocol](./protocol)

## Contributing & Publishing

This repo uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing.

**To propose a version bump for a package:**

```bash
pnpm changeset
```

Follow the prompts to select which packages changed and whether the bump is `major`, `minor`, or `patch`. Commit the generated file in `.changeset/`.

**Releasing is fully automated.** The `.github/workflows/release.yml` workflow runs on every push to `main`. It detects pending changeset files, bumps versions, updates changelogs, opens a release PR, and publishes to npm once that PR is merged — no manual steps needed.
