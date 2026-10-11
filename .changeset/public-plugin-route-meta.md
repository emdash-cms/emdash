---
"emdash": patch
---

Fixes server-rendered pages that inspect public plugin route metadata before dispatching, so logged-out visitors can load plugin data. Public metadata is available through `getPublicPluginRouteMeta` for both visitors and signed-in users. Private route metadata stays on the signed-in `getPluginRouteMeta` helper.
