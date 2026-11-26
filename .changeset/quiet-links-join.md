---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes extending a saved link over adjacent text producing separate links on the rendered page. Saving now joins adjacent link spans with equivalent options while preserving stored link keys where possible. Existing split links are repaired the next time the content is edited and saved; links separated by unlinked text or with different options remain distinct.
