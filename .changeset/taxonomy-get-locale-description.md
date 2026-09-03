---
"emdash": patch
---

Fixes the OpenAPI description for `GET /_emdash/api/taxonomies/{name}`, which said that omitting `locale` returns the lowest-locale definition. The endpoint returns the configured default locale's definition and only falls back to the lowest locale code when the default locale has none. Behavior is unchanged; only the generated API description was wrong.
