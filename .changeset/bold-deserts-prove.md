---
"emdash": patch
---

Fixes purged pages being cached again with stale site settings, including SEO verification tags, on Workers Cache sites without an object cache. Responses rendered from an outdated settings snapshot are kept out of the route cache, and the next render reloads the settings. Warm settings snapshots also revalidate in the background after 30 seconds, retaining the last good value if a reload fails.
