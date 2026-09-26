---
"@emdash-cms/plugin-webhook-notifier": patch
---

Fixes the Webhook Settings page failing with `502 INVALID_BLOCK_RESPONSE` ("Plugin returned invalid Block Kit content") when the plugin runs sandboxed on EmDash 0.39. The Test Webhook button now uses `label`, and the "Enter a webhook URL first." and "Failed to save settings" banners use `title` and `variant`, as Block Kit requires. The Webhooks dashboard widget now loads: the plugin answers the `widget:status` id declared in its manifest instead of `widget:webhook-status`.
