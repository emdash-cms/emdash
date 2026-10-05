---
"@emdash-cms/plugin-cli": patch
---

Fixes `emdash-plugin publish --no-manifest` failing with a `paths[0]` type error, and `emdash-plugin release submit --no-wait` still waiting for the release to be published. `--no-manifest` now skips `emdash-plugin.jsonc`, and `--no-wait` returns once the release service accepts the intent.
