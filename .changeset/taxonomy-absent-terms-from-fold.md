---
"emdash": patch
---

Avoids an extra query when a listed entry has no terms in a taxonomy. `getTermsForEntries()` and `getEntryTerms()` now answer from the terms already loaded with the content query, so a blog list with an untagged post no longer queries its tags again.
