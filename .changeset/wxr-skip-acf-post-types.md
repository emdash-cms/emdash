---
"emdash": patch
---

Fixes WordPress XML imports creating `acf_field` and `acf_field_group` collections full of serialized field settings on sites that use Advanced Custom Fields. The admin import now skips ACF's own post types, as it already does for WordPress internals such as revisions and menu items. Collections created by earlier imports stay in place; delete them in the admin if you don't need them.
