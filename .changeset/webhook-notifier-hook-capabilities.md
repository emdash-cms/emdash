---
"@emdash-cms/plugin-webhook-notifier": patch
---

Fixes the webhook notifier never sending webhooks for content saves, content deletions, or media uploads: it now declares the `content:read` and `media:read` capabilities EmDash requires before it runs those hooks.
