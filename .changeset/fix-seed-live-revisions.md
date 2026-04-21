---
"emdash": patch
---

Fixes `emdash seed` so entries declared with `"status": "published"` are actually published. Previously the seed wrote the content row with `status: "published"` and a `published_at` timestamp but never created a live revision, so the admin UI showed "Save & Publish" instead of "Unpublish" and `live_revision_id` stayed null. The seed now promotes published entries to a live revision on both create and update paths.
