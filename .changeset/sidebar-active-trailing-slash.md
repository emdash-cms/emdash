---
"@emdash-cms/admin": patch
---

Fixes the sidebar active state for a plugin admin page declared with `path: "/"`. The nav target for such a page carries a trailing slash (`/plugins/<id>/`) while the router navigates without it, so the exact comparison in `isItemActive` never matched and the item stayed unhighlighted. This affected the shipped forms plugin's "Forms" page. Both sides are now normalized before comparing, and the admin root keeps its exact match.
