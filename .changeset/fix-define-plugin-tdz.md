---
"emdash": patch
---

Fixes a crash that returned HTTP 500 on every route on Cloudflare Workers when native plugins are registered with `definePlugin`. The plugin id/version validation regexes were module-scoped and could be read before initialization during the worker's circular module init (`Cannot access 'SIMPLE_ID' before initialization`). They are now function-local, so plugin registration is safe regardless of bundle ordering.
