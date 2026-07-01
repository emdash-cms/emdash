---
"emdash": patch
---

Fixes a crash that returned HTTP 500 on every route on Cloudflare Workers when native plugins are registered with `definePlugin` (`Cannot access 'SIMPLE_ID' before initialization`). Plugin registration is now safe regardless of bundle ordering.
