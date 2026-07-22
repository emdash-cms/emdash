---
"emdash": patch
---

Fixes content filtering by locales with uppercase subtags (e.g. `zh-TW`, `en-US`, `pt-BR`) returning no results on SQLite and D1. The admin content list no longer shows up blank on sites whose locale isn't all-lowercase.
