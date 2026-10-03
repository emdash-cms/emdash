---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes on-page edits silently overwriting newer content. Text, image, and Portable Text saves now check the loaded revision, and Publish waits for successful saves. Conflicted or locked edits stay unsaved and show a recovery message. Page-leave saves remain best-effort and cannot bypass revision checks.
