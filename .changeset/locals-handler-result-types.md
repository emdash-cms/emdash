---
"emdash": patch
---

Corrects the types of the `Astro.locals.emdash` handlers to match what they return and accept.

- A handler result now narrows on `success`, so `result.data` is typed after an `if (result.success)` check. `result.data?.…` and `result.error?.…` still work without narrowing.
- `handleContentGet` and `handleRevisionGet` type `item` as the content entry or revision. Reading a property that isn't part of the entry, such as a field name directly on `item`, is now a type error. Field values are in `item.data`; those top-level properties were never set.
- `handleMediaList`, `handleMediaGet`, `handleMediaCreate`, `handleMediaUpdate`, and `handleCommentModerate` describe their result data.
- `handleMediaUpload` requires `base64` and `contentType` and no longer lists a `url` option, which it never supported.
