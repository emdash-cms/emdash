---
"emdash": patch
---

Fixes new comments staying pending with the reason "No moderator configured" when a plugin that moderates comments is installed. When no `comment:moderate` choice is stored and exactly one plugin provides the hook, EmDash now selects that plugin over the built-in moderator; before, it selected neither.

A stored choice is kept, including the built-in moderator that EmDash stores on a start without a moderation plugin, so existing sites keep their current moderator. An administrator changes the choice with `PUT /_emdash/api/admin/hooks/exclusive/comment:moderate` and a body such as `{"pluginId":"ai-moderation"}`; `{"pluginId":"emdash-default-comment-moderator"}` selects the built-in moderator again.
