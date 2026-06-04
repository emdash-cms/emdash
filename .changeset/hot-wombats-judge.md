---
"emdash": patch
---

Fix `getEmDashCollection` pagination losing `nextCursor` with Astro 6 live collections. Astro's `getLiveCollection` repacks loader results and drops the `nextCursor` field before it reaches the caller. The wrapper now over-fetches by one entry whenever a `limit` is provided, slices the extra row locally, and synthesizes `nextCursor` via the existing `encodeEntryCursor` helper — matching the strategy already used by the bucketing path. Fixes #1338.
