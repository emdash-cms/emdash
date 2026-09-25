---
"@emdash-cms/plugin-forms": patch
---

Fixes forms with a file field failing on every submission from the bundled form component. With JavaScript enabled, the component now sends a chosen file in the JSON submission body under `files.<fieldName>` as `{ filename, contentType, bytes }`, where `bytes` is the file encoded as base64. A required file field is now satisfied only by an attached file; a value for a file field in `data` is ignored, and a file sent for a field that its condition hides is not uploaded. A submission that attaches a file to one of the form's file fields now fails with a `500` error instead of being saved without it when the site has no media storage configured.
