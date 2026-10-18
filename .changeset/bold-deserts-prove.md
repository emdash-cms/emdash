---
"emdash": patch
---

Fixes purged pages being cached again with stale site settings, including SEO verification tags, titles, and logos, on sites with or without an object cache. Route-cache fills with an object cache read settings directly from the database. Without an object cache, responses using an outdated settings snapshot are kept out of the route cache, and the next render reloads the settings. Warm settings snapshots also revalidate in the background after 30 seconds, retaining the last good value if a reload fails.
