---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes sandboxed plugins on Cloudflare to use the site's configured D1, Hyperdrive, or Durable Objects SQL database instead of always using the `DB` D1 binding. Plugin database operations now open an event-scoped connection, so Hyperdrive connections are not reused across bridge calls.
