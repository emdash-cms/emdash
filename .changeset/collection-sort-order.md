---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an explicit sidebar order for collections. Drag the rows on the Content Types screen, or set `sortOrder` in a seed file, and the admin sidebar follows that order instead of sorting alphabetically by slug. Collections without a `sortOrder` keep the alphabetical order and are listed after the ordered ones, so existing sites look the same until someone reorders. `reorder` is now a reserved collection slug.
