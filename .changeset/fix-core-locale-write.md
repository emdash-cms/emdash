---
"emdash": patch
---

Read `?locale=` in content write routes (PUT, DELETE, publish, unpublish, discard-draft, schedule, unschedule) and forward it to `handleContentGet` for locale-aware slug resolution (#1242)
