---
"emdash": patch
---

Fixes taxonomy term counts reading a near-quadratic number of rows on sites with many entries and terms, causing multi-second delays on pages that render term counts or taxonomy filters. Counts are unchanged.
