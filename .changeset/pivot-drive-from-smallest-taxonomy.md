---
"emdash": patch
---

A collection query filtered by two or more taxonomies now drives the pivot query from the taxonomy with the fewest tagged entries instead of whichever key the caller wrote first. Results are unchanged; on a large collection the rows read no longer depend on key order (3,131 versus 539 for the same query in one measurement).
