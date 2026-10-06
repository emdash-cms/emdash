---
"@emdash-cms/plugin-cli": patch
---

Fixes `emdash-plugin build` for sandboxed plugins that use Block Kit helpers from `@emdash-cms/blocks/server`. The runtime and probe builds now bundle `@emdash-cms/blocks` so the probe step no longer fails with `ERR_MODULE_NOT_FOUND` when the package cannot be resolved from the temporary probe directory.
