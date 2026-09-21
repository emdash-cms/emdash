---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes content writes when a database schema contains a field type that the running EmDash version does not support. Entries remain readable, but the admin makes them read-only and content create or update requests return `UNSUPPORTED_FIELD_TYPE` instead of treating the unknown field as text and risking data loss.

Deploy this release to every runtime before enabling a later EmDash feature that adds a new field type. Sites whose schemas use only supported field types require no action.
