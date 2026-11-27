---
"@emdash-cms/admin": patch
---

Fixes the menu editor's Add Content picker showing entries from other locales. The picker now lists only entries in the menu's locale, so translations with the same title and slug cannot be confused. Entries without a translation in the menu's locale no longer appear in this picker.
