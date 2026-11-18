---
"emdash": patch
---

Corrects the types of the `Astro.locals.emdash` handlers to match what they return and accept.

- A handler result now narrows on `success`, so `result.data` is typed after an `if (result.success)` check. `result.data?.…` and `result.error?.…` still work without narrowing.
- `handleContentGet` and `handleRevisionGet` type the standard properties of `item`, such as `status`, `data`, and `createdAt`. Other properties still read as `unknown`.
- `handleMediaList`, `handleMediaGet`, `handleMediaCreate`, `handleMediaUpdate`, and `handleCommentModerate` describe their result data.
- `handleMediaUpload` requires `base64` and `contentType` and no longer lists a `url` option, which it never supported.
