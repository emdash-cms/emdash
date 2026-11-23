---
"@emdash-cms/admin": patch
---

Fixes field links from the site (`?field=`) sometimes losing focus and collapsing the linked block when the entry's co-editing room joined after the editor appeared. The editor now focuses the linked field once the room has joined or the entry has settled into single-editor mode.
