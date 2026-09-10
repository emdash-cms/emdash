---
"emdash": patch
---

Taxonomy term counting no longer sends queries against declared collections that were never created, eliminating the phantom `no such table: ec_posts` database error logs that sites without a `posts` collection produced on every uncached taxonomy render. On multi-isolate deployments, term counts now pick up a collection created or deleted on another isolate within about a minute instead of immediately; the write-handling isolate reflects it at once.
