---
"emdash": patch
---

Fixes `routeCtx.ui` being undefined for the declared Block Kit pages and dashboard widgets of plugins registered in `plugins: []`. They now receive the administrator's locale, text direction, and surface, as sandboxed plugins do, so a plugin can localize its Block Kit text in both install modes.
