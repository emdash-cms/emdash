---
"emdash": minor
"@emdash-cms/admin": minor
---

Add a "Gone (410)" rule type. Redirect rules now support `410` (Content Deleted) and `451` (Unavailable For Legal Reasons) as terminal statuses — served directly with no destination — and the 404 log offers a one-click "Mark as Gone (410)" action next to "Create redirect". A 410 tells search engines a URL was intentionally and permanently removed, so it is deindexed faster than a 404.
