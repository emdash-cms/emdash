---
"emdash": minor
---

Adds opt-in live comment display: pass `live` to `<Comments>` and `<CommentForm>` and a visitor's own comment now appears in the list immediately after posting, instead of requiring a page reload. A comment awaiting moderation is shown in a distinct, muted "awaiting moderation — visible only to you" state so it never looks like it's live for other readers. The comment-submission API response also gains an additive `comment` field (id, author info, body, createdAt, moderation status) alongside the existing `id`/`status`/`message` fields — existing integrations are unaffected.
