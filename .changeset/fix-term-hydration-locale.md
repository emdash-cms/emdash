---
"emdash": patch
---

Fix `getEmDashEntry` / `getEmDashCollection` hydrating taxonomy terms in the request-context or default locale instead of the entry's resolved locale (#1441). When querying with an explicit `locale` (or via a localized route), `entry.data.terms` could return default-locale term variants even though the content row was correctly localized. Term hydration now uses the same resolved locale as the content query.
