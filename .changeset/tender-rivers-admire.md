---
"emdash": patch
---

Fixes `getEmDashEntry` stopping at the first locale that lacks an entry instead of continuing through the locale fallback chain. When the requested locale has no entry, it now returns the entry from the next locale in the chain, with `fallbackLocale` set, including in preview and visual-editing mode. An entry that exists in no locale now returns `entry: null` without an `error`, so pages that check `error` before `entry` show their not-found page instead of a 500 error.
