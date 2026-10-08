---
"emdash": patch
---

Fixes `<CommentForm>` making right-to-left pages (`<html dir="rtl">`) about 10,000 pixels wider, with a horizontal scrollbar. This happened on every such page in Firefox, and in Chrome and Safari when the form or an element around it is positioned, for example with `position: relative`. On right-to-left pages, `<Comments>` now also indents threaded replies from the right, and the separator before a signed-in commenter's email in `<CommentForm>` no longer touches the email.
