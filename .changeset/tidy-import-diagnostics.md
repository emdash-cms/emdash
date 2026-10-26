---
"emdash": patch
---

Fixes `emdash site import` failing with `COLLECTION_EXISTS` when manually deleted target collections still have media-usage cleanup pending. For these manually deleted collections, import now runs as many cleanup steps as the request budget allows, then imports the collection in the same request if enough budget remains. It waits for active deletion leases or retry delays before reusing a slug. Cancellation during this per-collection cleanup stops before importing the collection. Failed cleanup of a manually deleted collection includes recovery instructions, and collection schema error messages are preserved in status `errorDetail`.
