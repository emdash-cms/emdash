---
"emdash": patch
---

Fixes several gaps in preview links and the published-only snapshot:

- `POST /_emdash/api/content/{collection}/{id}/preview-url` now requires an API or OAuth token to hold `content:read` as well as `content:write`. A token without `content:read` gets `403 INSUFFICIENT_SCOPE`. Signed-in admin sessions are unaffected.
- The same endpoint now accepts an `expiresIn` of at most seven days and responds with `400 VALIDATION_ERROR` for a longer, zero, negative, or unrecognized value instead of signing it. The admin uses the one-hour default and is unaffected; API clients that request longer links must ask for `"7d"` or less.
- Links from that endpoint are now always signed for the entry's database ID, so a link requested by slug no longer opens a different entry that later takes the same slug.
- The published-only snapshot (`GET /_emdash/api/snapshot` with a preview signature, or without `?drafts=true`) no longer includes SEO metadata or the social image of an unpublished entry whose translation is published, and exports `draft_revision_id` and `scheduled_at` as `NULL` on content rows. Snapshots with `?drafts=true` and backups are unchanged.

Preview links issued before upgrading stay valid until they expire. To end them sooner, rotate the preview secret, then restart or redeploy every serving instance so none keeps using the old secret. When `EMDASH_PREVIEW_SECRET` is set, change it; deleting the `emdash:preview_secret` option has an effect only when no environment override is set. See [Preview secret](https://docs.emdashcms.com/deployment/secrets/#preview-secret) for the rotation steps.
