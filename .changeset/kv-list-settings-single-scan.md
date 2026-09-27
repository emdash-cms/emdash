---
"emdash": patch
---

Fixes `ctx.kv.list("settings:")` scanning the options table twice. The general prefix scan read every settings row and discarded it before `SettingsAccess.list()` read the same rows again, so a plugin that lists its settings in a `page:metadata` hook cost every page render an extra query.
