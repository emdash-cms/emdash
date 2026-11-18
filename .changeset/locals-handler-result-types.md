---
"emdash": patch
---

Corrects the types of the `Astro.locals.emdash` handlers to match what they return and accept.

- A handler result now narrows on `success`, so `result.data` is typed after an `if (result.success)` check. `result.data?.…` and `result.error?.…` still work without narrowing.
- `handleContentGet` and `handleRevisionGet` type the standard properties of `item`, such as `status`, `data`, and `createdAt`. Other properties still read as `unknown`. Code that deletes a required property, such as `delete item.draftRevisionId`, or assigns an `unknown` value to `item.data` no longer type-checks. Use destructuring to drop a property (`const { draftRevisionId, ...rest } = item`), or cast `item` to `Record<string, unknown>` first.
- `handleMediaList`, `handleMediaGet`, `handleMediaCreate`, `handleMediaUpdate`, and `handleCommentModerate` describe their result data.
- `handleMediaUpload` requires `base64` and `contentType` and no longer lists a `url` option, which it never supported.
