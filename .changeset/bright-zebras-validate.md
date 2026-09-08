---
"emdash": patch
"@emdash-cms/auth": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/plugin-types": patch
"@emdash-cms/plugin-embeds": patch
"@emdash-cms/plugin-forms": patch
---

Updates Zod to 4.5 while keeping EmDash and native plugin schemas on one compatible version. Existing minute-precision ISO datetimes remain valid, and URL content fields continue to enforce configured length and pattern rules.
