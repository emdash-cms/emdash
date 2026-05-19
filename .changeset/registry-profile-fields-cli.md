---
"@emdash-cms/plugin-cli": minor
---

Publishes the full profile block from `emdash-plugin.jsonc`. First publish now writes `name`, `description`, `keywords`, multiple authors, and multiple security contacts to the package profile record, plus the source `repo` URL to the release record — previously only `license` and a single author/security contact were sent.

Deprecates the `--license`, `--author-*`, and `--security-*` flags in favour of declaring these in `emdash-plugin.jsonc`. The flags still work and override the manifest when both are present; a deprecation warning is printed when they are used.
