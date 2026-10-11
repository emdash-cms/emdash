---
"emdash": patch
---

Fix plugin storage cursor behavior when the anchor row of an ordered page is deleted. `PluginStorageRepository.query()` now encodes scalar ordered field values into the cursor and compares subsequent pages against those values, so ascending walks no longer end early and descending walks no longer restart from the top. Cursors for non-scalar values (objects or arrays) or very long strings fall back to the anchor-row lookup used before this fix, keeping those pages working while still surfacing a clear invalid-cursor error when that anchor row has been deleted. Legacy cursors that do not contain the field values still work under the same fallback.
