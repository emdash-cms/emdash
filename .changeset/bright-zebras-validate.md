---
"emdash": patch
"@emdash-cms/auth": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/plugin-types": patch
"@emdash-cms/plugin-embeds": patch
"@emdash-cms/plugin-forms": patch
---

Updates Zod to 4.5 and keeps EmDash and native plugin schemas on the same Zod version, preventing type incompatibilities when schemas cross package boundaries.
