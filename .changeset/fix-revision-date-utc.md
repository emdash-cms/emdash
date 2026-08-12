---
"@emdash-cms/admin": patch
---

Fixes admin dates showing the wrong time on SQLite-backed sites. Timezone-less stored timestamps in revision history, the dashboard, the content list, the editor's date metadata, and the scheduled publish time are now parsed as UTC, so they no longer drift by the viewer's offset.
