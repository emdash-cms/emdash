---
"emdash": patch
"@emdash-cms/plugin-webhook-notifier": patch
---

Fixes sandboxed plugin entries failing when package exports point to unbuilt TypeScript source. Adds build-time and bundle-time validation to catch misconfigured plugin exports early.
