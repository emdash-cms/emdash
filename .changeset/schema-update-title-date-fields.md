---
"emdash": patch
---

Fixes `PUT /_emdash/api/schema/collections/{slug}` so `titleField` and `dateField` are no longer silently dropped from the request body. Both fields are now validated, persisted, and returned in the collection response, restoring parity with `UpdateCollectionInput` and the in-process `SchemaRegistry` path.
