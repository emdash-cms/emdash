---
"emdash": patch
---

Fixes edits disappearing after unpublishing an entry in a collection without revisions: the editor showed the previously published content after every save, and the next save wrote it back over the edits. Saves now keep the edits, including on entries unpublished before this release.
