---
"emdash": patch
---

Limits the length of two values stored from public requests:

- The public comment endpoint now rejects an author email address longer than 254 characters with a `400` validation error, as it already does for over-long names and comment bodies. The `<CommentForm>` email input has a matching `maxlength`. Comments stored before upgrading are not changed.
- The 404 log no longer records requests whose path is longer than 2,048 characters. Visitors still get the same 404 response.
