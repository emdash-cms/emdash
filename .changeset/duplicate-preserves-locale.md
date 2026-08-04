---
"emdash": patch
---

Fixes the Duplicate action creating the copy in the default locale instead of the source entry's locale. Duplicates of non-English entries now stay in their locale — so they appear in the locale-filtered admin list they were duplicated from — and no longer fail with a unique-constraint error when the generated slug already exists in the default locale.
