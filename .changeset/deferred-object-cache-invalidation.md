---
"emdash": patch
---

Content updates are no longer lost to a stale object cache when a site is under concurrent read load.

An update made through the content API could leave the previous version cached: a render that started while the write was still in progress could store the pre-update content, and that entry then looked current, so pages kept serving the old value until the next write to the same collection or until the cache TTL expired, an hour by default. Sites with more than one locale were affected most, because a localized write does more work before it finishes, and so does any site whose database connection is slow.

Cached reads are now invalidated once a write has finished rather than while it is still in progress, so an entry built from a mid-write read is discarded instead of being served. On a six-locale site at roughly 930 requests per second, all twelve test updates were still stale three seconds later before this change; none were after it.
