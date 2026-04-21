---
"@emdash-cms/admin": patch
---

Fixes the taxonomy term picker to match across diacritic boundaries.

Typing `Mexico` in the admin picker now surfaces a term labeled `México` instead of prompting a duplicate create. Input and term labels are folded via NFD decomposition + lowercase before substring-matching, so editors who type without diacritics — or with locale keyboards that produce precomposed vs. combining forms — still see the canonical term.

Before this fix, `"mexico"` and `"méxico"` were treated as distinct strings, so the picker showed zero suggestions and the editor had no way to find the existing term except to create a duplicate. Duplicate terms then split the taxonomy and broke public-facing filter pages that group content by slug.

The exact-match check that gates the "Create new term" button uses the same fold, so typing `Mexico` when `México` exists also suppresses Create — closing the duplicate-creation loop.
