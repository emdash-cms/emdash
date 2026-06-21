---
"emdash": patch
---

Fixes the content and search APIs returning zero results when filtering by a locale with an uppercase region or script subtag (e.g. `?locale=zh-TW`, `pt-BR`, `zh-Hant`). The `localeCode` validator lowercased the value, but config locales, the stored `locale` column, and the public query path all preserve the original casing, so the filter matched nothing. Validation stays case-insensitive; the value is now preserved verbatim. Closes #1551.
