---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds the `no-scheduling` collection support flag to disable creating or changing schedules in the content editor, calendar, and scheduling API. Scheduling remains enabled by default, and existing schedules continue to run and can be removed. The legacy `scheduling` value remains accepted as a no-op for compatibility; `no-scheduling` takes precedence when both values are present.

WordPress imports into a collection with `no-scheduling` keep future-dated posts as drafts and report that scheduling is disabled.
