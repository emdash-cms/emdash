---
"@emdash-cms/admin": patch
---

Fixes a crash on the content list when an action that refetches (changing the sort, fast navigation) coincides with a load error. The `onLoadMore` callback hook now sits above the page's early returns, so an error render runs the same number of hooks as a normal render instead of throwing React error #300. Closes #1415.
