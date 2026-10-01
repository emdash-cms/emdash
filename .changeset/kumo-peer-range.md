---
"@emdash-cms/cloudflare": patch
"@emdash-cms/plugin-ai-moderation": patch
"@emdash-cms/plugin-field-kit": patch
"@emdash-cms/plugin-forms": patch
---

Widens the `@cloudflare/kumo` peer dependency from exactly `2.6.0` to `^2.6.0`. Sites on a newer Kumo 2.x no longer get unmet-peer warnings, and update tools that respect peers (such as `npm-check-updates --peer`) no longer hold these packages back.
