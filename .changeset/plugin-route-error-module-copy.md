---
"emdash": patch
---

Fixes native plugin routes returning a generic `INTERNAL_ERROR` under `astro dev` when the handler throws `PluginRouteError`, so the client receives the error's code, status, and message.
