---
"emdash": patch
---

Fixes WordPress XML imports from sites that use Advanced Custom Fields creating `acf_field` and `acf_field_group` collections full of serialized field settings. The admin import and `emdash import wordpress` now skip ACF's own post types, as they already do for WordPress internals such as revisions and menu items.
