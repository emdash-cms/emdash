---
"emdash": patch
---

Fixes `search()` ranking so full-title phrase matches and titles matching every query term appear before body-only matches, even in small collections or on short result pages.

`search()` scores are now normalized to 0–1 within each collection instead of returning raw BM25 magnitudes, including searches restricted to one collection. Title-match tiers take precedence over scores. Preserve the returned result order and review any custom score thresholds when upgrading. `searchCollection()` keeps its raw scores and score-based ordering.
