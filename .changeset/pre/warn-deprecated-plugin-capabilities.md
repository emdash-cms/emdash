---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Adds a startup warning when an installed or configured plugin declares deprecated capability names such as `read:content`, `network:fetch` or `page:inject`. The warning appears once per plugin and lists each current replacement, for example `read:content → content:read`. The deprecated names keep working throughout 1.x. If a plugin you use triggers the warning, update it, or ask its author to publish a version that uses the current names.

`aiSearch()` from `@emdash-cms/cloudflare` now declares `content:read`, so it no longer triggers the warning.
