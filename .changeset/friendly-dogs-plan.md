---
"@emdash-cms/plugin-cli": minor
---

Adds Changesets-aware automated plugin releases. `emdash-plugin release setup` detects a root `.changeset/config.json` and offers Changesets version updates, `<slug>@<version>` tags, or manual runs as the repository workflow trigger. Use `--trigger auto|changesets|tags|manual` in non-interactive setup.

The Changesets workflow publishes only plugin packages whose versions changed on its configured base branch. It supports monorepos where npm package names differ from EmDash plugin IDs, and warns when a private plugin would be skipped because `privatePackages.version` is not enabled.
