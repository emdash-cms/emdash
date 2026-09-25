---
"@emdash-cms/plugin-webhook-notifier": patch
---

Fixes the webhook notifier ignoring its Events to Send and Include Content Data settings. "Content changes only" now sends only content create, update and delete webhooks, and "Media uploads only" sends only media upload webhooks. With Include Content Data on, content create and update payloads carry the saved entry's field values in `data`, and media upload payloads carry the file's `filename`, `mimeType` and `size`; delete payloads have no `data`. No earlier release sent `data`, and releases before the plugin declared `content:read` and `media:read` sent none of these webhooks, so there is no earlier payload shape to keep compatible.

Content create and update payloads also carry `metadata.draftRevisionId`. In a collection with revisions, saving changes to an existing entry stages a draft, so `data` holds the draft's values; `draftRevisionId` names that draft and is `null` when the saved values are the entry's current ones.

Also fixes the plugin's delivery counts always being 0. Each content or media webhook now records its outcome, HTTP status and duration in the plugin's `deliveries` storage collection, which prunes down to the 500 most recent deliveries after every write; the `status` route and the dashboard widget's Delivered and Failed counts read from that same pruned log, so they only ever total the 500 most recent deliveries. The Test Webhook button's sends are not recorded. Both the `status` route and the widget drop their Pending stat: nothing ever wrote a pending delivery, so it always read 0.
