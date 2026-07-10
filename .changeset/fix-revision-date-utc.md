---
"@emdash-cms/admin": patch
---

Fixes admin dates showing in the viewer's local timezone on SQLite-backed sites. Timezone-less stored timestamps in revision history, the dashboard, the content list, and the editor's date metadata are now parsed as UTC, so they no longer drift by the viewer's offset.
