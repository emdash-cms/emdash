---
"emdash": patch
---

Fixes the public comment endpoints returning comments for entries that are drafts, unpublished, or in the trash. `GET /_emdash/api/comments/:collection/:contentId` now answers `404 Content not found` for such an entry, as submitting a comment to it already did. The reactions endpoint on the same path returns no counts for such an entry and no longer accepts reactions on its comments.
