---
"@emdash-cms/plugin-cli": minor
---

Adds Changesets-aware automated plugin releases. `emdash-plugin release setup` detects a root `.changeset/config.json` and offers to follow Changesets releases, `<slug>@<version>` tags, or manual runs. Use `--trigger auto|changesets|tags|manual` in non-interactive setup.

The Changesets variant accepts the official Changesets Action published-package JSON through a reusable workflow. It supports mixed monorepos where npm package names differ from EmDash plugin IDs, ignores ordinary npm packages, verifies every reported plugin version, and publishes matching plugins as a matrix. Private EmDash-only packages produce a setup warning unless Changesets versions and tags them.
