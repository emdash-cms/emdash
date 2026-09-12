---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes invalid plugin registry settings causing the admin manifest to fail with a generic server error. EmDash reports malformed `experimental.registry` fields while Astro loads the site configuration. If invalid registry settings reach the runtime, the admin remains available and shows which field to correct in `astro.config.mjs`.
