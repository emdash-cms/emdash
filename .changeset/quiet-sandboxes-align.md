---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
"@emdash-cms/plugin-types": patch
"@emdash-cms/plugin-cli": patch
---

Fixes standard sandboxed plugins so lifecycle, content, media, comment, email, cron, and page metadata hooks run through the same ordered, capability-gated host pipeline as trusted plugins on Cloudflare Workers and Node.js.

Sandbox contexts now expose canonical capabilities, database-backed `ctx.cron`, complete content metadata and filtering, and a real `Response` from `ctx.http.fetch()`. Plugin builds also preserve hook, route permission and cache, MCP, settings, and field-widget metadata in registry bundles and npm descriptors.
