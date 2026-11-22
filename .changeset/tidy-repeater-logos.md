---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes image sub-fields in repeaters ignoring `validation.allowedMimeTypes` in the media picker and during upload, including repeaters inside block types. Configure the image sub-field through a seed, the schema API, or code to opt into formats such as SVG without changing the global upload allowlist. Editing a repeater in Content Types preserves its configured sub-field allowlists.
