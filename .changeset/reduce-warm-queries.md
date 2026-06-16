---
"emdash": patch
---

Reduces redundant database queries when rendering content pages: widget areas are now request-cached, taxonomy term usage-counts are fetched once per request instead of once per taxonomy widget, and `getTermsForEntries` reuses already-hydrated terms instead of re-querying. Fewer round trips per page on every backend.
