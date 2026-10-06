---
"emdash": patch
---

Fixes `<CommentForm>` widening right-to-left pages (`<html dir="rtl">`) by about 10,000 pixels, which gave every page with a comment form a horizontal scrollbar. Threaded replies in `<Comments>` and the separator before a signed-in commenter's email in `<CommentForm>` are now also spaced correctly in right-to-left languages.
