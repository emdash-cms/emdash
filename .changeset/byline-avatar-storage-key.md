---
"emdash": patch
---

Byline hydration now resolves the author avatar's storage key in the same query. `getEmDashCollection` / `getEmDashEntry` populate `entry.data.bylines[].byline.avatarStorageKey` (and `avatarAlt`) via a `LEFT JOIN` on the media table, so list pages can build a direct avatar URL without a per-byline `MediaRepository.findById`. Previously the byline summary exposed only `avatarMediaId` (a bare ULID with no file extension), forcing sites that want direct storage URLs into an N+1 media lookup. A page rendering 20 posts by distinct authors paid ~20 extra queries. The new fields are additive and null on the plain byline finders (`findById`, `findBySlug`), which do not join media; rely on the content-credit hydration path for them.
