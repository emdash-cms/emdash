---
"@emdash-cms/plugin-ai-moderation": patch
---

Fixes the AI moderation plugin never checking comments with Workers AI: it now declares `users:read`, so EmDash no longer skips its `comment:beforeCreate` and `comment:moderate` hooks at startup with a `without users:read capability — skipping` warning.
