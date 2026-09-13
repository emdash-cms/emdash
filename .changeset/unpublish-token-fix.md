---
"@emdash-cms/admin": patch
"emdash": patch
---

Fix stale revision tokens after unpublish, discard, and revision restore.

The admin editor now reads the new `_rev` returned by unpublish, discard-draft, and revision-restore responses and advances its optimistic-concurrency token before the next save. Unpublish also flushes pending editor changes before sending the request, matching the ordering already used for publish, schedule, and publication-date changes, and it now catches the promise rejection when the action is blocked by invalid fields or a click while another publishing action is already in progress. This prevents subsequent autosaves or publish actions from being refused as a 409 conflict, stops unpublished posts from overwriting unsaved edits, and avoids unhandled promise rejections from the unpublish button.
