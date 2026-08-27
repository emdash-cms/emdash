---
"@emdash-cms/cloudflare": minor
---

Fixes the Cloudflare playground setup screen so its database, demo-content, and Ready states reflect completed initialization work instead of elapsed timers. Concurrent setup requests share one initialization run, migration failures keep the playground closed, and expired playground databases reset cleanly before reuse.
