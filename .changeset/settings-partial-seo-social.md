---
"emdash": patch
---

Fixes partial `seo` and `social` settings updates through the MCP `settings_update` tool, `POST /_emdash/api/settings`, `setSiteSettings()`, and seeds applied with `onConflict: "update"` replacing the whole stored object. Sending one field, for example `{ seo: { googleVerification: "…" } }`, used to remove the custom `robots.txt`, title separator, other verification code, and default social image that were not in the request. Fields you leave out now keep their stored values. To clear a text field inside `seo` or `social`, send it as an empty string, for example `{ social: { twitter: "" } }`.
