---
"emdash": patch
---

Fixes redirect creation and editing failing with "Another redirect change is in progress" when the redirect write lock row is missing. Redirect writes now recreate the missing row automatically while preserving active locks.
