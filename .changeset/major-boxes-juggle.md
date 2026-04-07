---
"emdash": patch
"@emdash-cms/plugin-webhook-notifier": patch
"@emdash-cms/plugin-atproto": patch
"@emdash-cms/plugin-audit-log": patch
---

Fixes sandboxed plugin entries failing when package exports point to unbuilt TypeScript source. Adds build-time and bundle-time validation to catch misconfigured plugin exports early.
