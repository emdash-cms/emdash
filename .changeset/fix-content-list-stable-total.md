---
"emdash": patch
"@emdash-cms/admin": patch
---

Fix the admin collection list pagination denominator so it no longer grows in increments of 5 as the user pages forward.

The `GET /_emdash/api/content/{collection}` response now includes a `total` field with the full filtered row count (independent of `limit`). The admin uses it as the pagination denominator, so a 143-entry collection reads `1/8` on page 1 instead of `1/5 → 5/10 → 10/15 → …` as successive API pages load.

The `total` field is optional; pre-upgrade clients that ignore it still work, and the admin falls back to the loaded-item count when an older server doesn't return it.

Also handles the edge case where the current page exceeds `totalPages` after filtering or deletion — the admin clamps the active page so the table doesn't render empty while waiting for a refetch.
