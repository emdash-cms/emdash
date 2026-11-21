---
"emdash": patch
---

Fixes plugin install so a failing `plugin:install` or `plugin:activate` hook fails the operation and triggers the existing rollback, instead of reporting success for a plugin whose setup did not run. Plugin updates now also fail when the `plugin:activate` hook throws.
