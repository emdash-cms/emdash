# Comment administration

Comment hooks and stored-comment administration have separate authority.

All comment hooks require `users:read` because their events contain author and request-derived information. `comments:read` separately exposes stored non-trashed comments through `ctx.comments.get()`, `list()`, and `count()`.

Comment reads include author name and email, body, pseudonymous IP hash, user agent, and moderation metadata. They do not expose the linked EmDash user-account ID. Treat this as personal-data access.

`comments:moderate` implies read and adds `ctx.comments.setStatus()`. Supply the status observed by the caller and move only between `approved`, `pending`, and `spam`. A stale status returns `COMMENT_STATUS_CONFLICT`; read again before deciding whether to retry.

A successful plugin transition identifies `{ source: "plugin", pluginId }`, runs `comment:afterModerate` once, preserves approval notifications, and rejects recursive moderation. The API does not hard-delete comments or replace statuses in bulk.

Use the runtime test host when a test must prove the personal-data shape, conflict behavior, notifications, hook origin, recursion fencing, or the real comment HTTP/runtime path.
