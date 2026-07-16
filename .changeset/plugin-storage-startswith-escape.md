---
"emdash": patch
---

Fixes plugin storage `startsWith` queries treating `%`, `_`, and `\` in the prefix as LIKE wildcards instead of literal characters.
