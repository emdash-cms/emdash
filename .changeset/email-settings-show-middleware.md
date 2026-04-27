---
"emdash": patch
---

Fixes the Settings > Email admin page so active `email:beforeSend` / `email:afterSend` middleware plugins are listed (previously always empty). Adds `HookPipeline.getHookProviders()` for enumerating non-exclusive hook providers.
