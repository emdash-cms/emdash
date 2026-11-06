---
"@emdash-cms/admin": patch
---

Fixes admin pages crashing on missing or unparseable timestamps in imported or legacy data, including publication and scheduling dates in the content editor. Invalid dates now render as empty text, and revision times omit the machine-readable date when it is invalid.
