---
"emdash": patch
---

Fixes `content.schedule()` so it always stores `scheduledAt` in UTC. Previously, a caller-supplied timezone offset such as `+09:00` was stored verbatim and compared incorrectly against the UTC clock used by the scheduled-publishing sweep, causing entries to publish up to several hours late or early. The same normalization now applies to every path that writes `scheduled_at`, including plain content updates.
