---
"emdash": patch
---

Fixes Cloudflare dev servers reloading the worker several times on the first page an editor visits, which could make that request take ten seconds or more. The inline editor's dependencies are now optimized when the dev server starts, whether or not co-editing is enabled.
