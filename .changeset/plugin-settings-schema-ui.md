---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds the auto-generated admin settings form for plugins that declare `admin.settingsSchema`. A gear icon on the plugin's card in Plugins opens a form generated from the schema (string, number, boolean, select, secret, url, and email fields), persisted to the plugin's KV store under `settings:` keys. Secret fields are write-only: the admin shows whether a value is set but never returns it. Editing plugin settings requires the `plugins:manage` permission.
