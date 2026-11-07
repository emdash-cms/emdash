---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/plugin-test": patch
---

Fixes sandboxed plugins on Cloudflare to use the site's configured D1, Hyperdrive, or Durable Objects SQL database instead of always using the `DB` D1 binding. Sandboxed plugins now work on Hyperdrive deployments, reading and writing the same database as the rest of the site without reusing connections across events.

Updates `@emdash-cms/plugin-test` so the workerd test host supplies the database adapter required by sandbox bridge calls.
