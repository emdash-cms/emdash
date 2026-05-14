---
"@emdash-cms/registry-cli": minor
---

Adds `emdash-plugin.jsonc` manifest support. Plugin authors can now declare profile fields (license, author, security contact, name, description, keywords, repo) once in a hand-edited JSONC file instead of passing them as flags on every publish. The CLI loads `./emdash-plugin.jsonc` automatically; explicit flags still win for CI use.

New `emdash-registry validate` command checks a manifest against the schema offline with `tsc`-style file:line:column diagnostics.

The manifest's optional `publisher` field pins the publishing identity. On first successful publish, the CLI writes the active session's DID back to the manifest. Subsequent publishes verify the active session matches the pinned publisher and refuse on mismatch to prevent accidental cross-account publishes.

JSON Schema for IDE completion ships in the package at `schemas/emdash-plugin.schema.json`; reference it via `"$schema": "./node_modules/@emdash-cms/registry-cli/schemas/emdash-plugin.schema.json"`.
