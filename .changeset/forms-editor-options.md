---
"@emdash-cms/plugin-forms": patch
---

Adds the missing form editor controls for daily digests, autoresponder emails, webhooks, field conditions, placeholders, help text, and default values. These existing options can now be viewed and changed in the admin instead of through the API. To disable a saved autoresponder through the update API, send `settings.autoresponder: null`.

The editor now uses `@lingui/react` as a peer dependency for translations. On older EmDash hosts that do not share the admin's Lingui context, the new controls fall back to English.

Fixes public form conditions controlled by a single checkbox or radio so unchecked controls count as empty. Dependents using "Is empty" now appear when the controller is unchecked, allowing required fields to be completed before submission. Placeholder and default-value inputs are only shown for field types that support them; file fields and checkbox groups are not offered as new condition controllers.
