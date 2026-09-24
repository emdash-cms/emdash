---
"@emdash-cms/plugin-ai-moderation": patch
---

Fixes the AI moderation plugin never checking comments with Workers AI: EmDash no longer skips its `comment:beforeCreate` and `comment:moderate` hooks at startup with a `without users:read capability — skipping` warning.

With both the built-in moderator and AI moderation now providing `comment:moderate`, a site that has not stored a moderator choice selects neither, and new comments stay pending until an administrator selects AI moderation, for example with a personal access token:

```sh
curl -X PUT https://example.com/_emdash/api/admin/hooks/exclusive/comment:moderate \
	-H "Authorization: Bearer $EMDASH_TOKEN" -H "X-EmDash-Request: 1" \
	-H "Content-Type: application/json" \
	--data '{"pluginId":"ai-moderation"}'
```

Sites that already stored a choice keep it, so the built-in moderator goes on deciding their comments until the choice is changed the same way.
