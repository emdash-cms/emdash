---
"@emdash-cms/plugin-cli": patch
---

Fixes `emdash-plugin publish --no-manifest` so it skips manifest loading as documented instead of crashing with a `path.resolve` type error.

Fixes `emdash-plugin release submit --no-wait` so it returns once the service accepts the intent instead of continuing to poll.
