---
"emdash": patch
---

Normalise cross-collection search scores and rank title matches first

`searchWithDb` previously merged per-collection FTS5 `bm25` results by raw
score. Because bm25's IDF is computed per table, scores from different
collections are not comparable: an exact title match in a small collection
could rank below passing mentions in a larger one, and raising title weights
could not close the gap. Results are now normalised to each collection's best
score and sorted so exact-title matches come first, followed by titles that
contain all query terms, then body matches.
