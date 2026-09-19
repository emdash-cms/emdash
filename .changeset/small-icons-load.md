---
"@emdash-cms/admin": patch
"@emdash-cms/blocks": patch
"emdash": patch
---

Reduces the admin's initial download by deferring uncommon plugin navigation icons and Block Kit chart code until they are displayed. Preserves Phosphor's exported icon aliases and keeps admin routes mounted if an icon or chart chunk fails to load.
