---
"emdash": patch
---

Fixes draft publication of a reference field from undoing link changes published from the opposite end of the relation in the meantime.

Draft revisions now record the live selection a reference field was saved against (`_referencesBaseline`). When the draft is published, parent-side fields apply the full staged-vs-baseline diff (additions and removals), while child-side fields only add links so backlinks created from the parent side are not accidentally removed. Restoring a revision continues to replace the live selection exactly as before.
