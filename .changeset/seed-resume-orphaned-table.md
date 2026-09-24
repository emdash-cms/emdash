---
"emdash": patch
---

Fixes first-request auto-seed resumability on D1 so a seed that is interrupted mid-collection can finish on the next request instead of leaving the site permanently unseeded.

The runtime now gates auto-seed on an `emdash:seed_complete` option rather than on the collection count. A partial seed re-enters `applySeed`, and the existing resume path in `createSeedCollection` finishes the half-created collection and skips already-finished ones.

When a content table exists without a matching `_emdash_collections` row, the schema registry now rejects attempts to create that collection with a distinct `COLLECTION_TABLE_ORPHANED` error (HTTP 409) instead of a generic `SCHEMA_CREATE_ERROR` 500.
