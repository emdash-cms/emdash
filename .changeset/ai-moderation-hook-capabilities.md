---
"@emdash-cms/plugin-ai-moderation": patch
---

Fixes the AI moderation plugin never moderating comments. The plugin now declares `users:read`, so EmDash no longer skips its `comment:beforeCreate` and `comment:moderate` hooks at startup with a `without users:read capability — skipping` warning. On a new site with the matching `emdash` release, AI moderation replaces the built-in moderator; with an earlier `emdash`, no moderator is selected and new comments stay pending until an administrator selects one.

A site that has already run EmDash has the built-in moderator stored as its moderator choice and keeps it. Until an administrator selects AI moderation, the plugin still sends each new comment to Workers AI and records the result in the comment's moderation metadata, but the built-in moderator decides the comment's status. To select AI moderation, send the following request with an API token that has the `admin` scope and belongs to an administrator:

```sh
curl -X PUT https://example.com/_emdash/api/admin/hooks/exclusive/comment:moderate \
	-H "Authorization: Bearer $EMDASH_TOKEN" \
	-H "Content-Type: application/json" \
	--data '{"pluginId":"ai-moderation"}'
```
