---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the admin's new-entry form ignoring field default values: a boolean field with `defaultValue: true` started switched off, and saving the entry untouched could store no value. New entries in the admin now start with each field's default value.

Manifest field descriptors now include stored field defaults as `defaultValue`, except for relation-bound reference fields.
