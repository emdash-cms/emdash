---
"emdash": patch
---

Fixes repeated cache purges from plugin content actions during `runScheduledTasks()` by deduplicating their tags and flushing once after the plugin cron batch, including when a task fails. HTTP content actions continue to invalidate immediately, and scheduled publishing and the hourly media cleanup keep purging as before.
