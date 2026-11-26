---
"@emdash-cms/admin": patch
---

Fixes field links from the site (`?field=`) sometimes losing focus and collapsing the linked block when the entry's co-editing room joined after the editor appeared. The editor now waits for the first room join to finish before it goes to the linked field. If the room is full or busy, the editor goes to the field right away in the read-only view instead of waiting for a retry to get in.
