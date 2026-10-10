---
"emdash": patch
---

Fixes WordPress imports through the EmDash Exporter plugin losing Advanced Custom Fields values: a field that only one post used was never created, and a repeater row that only one post had was lost. For ACF field groups assigned to a post type, the import now creates a field for every ACF field and stores repeaters, groups, relationships, checkboxes and other structured values as JSON. A collection from an earlier import keeps the fields it has, so its repeaters still arrive as one field per row and sub-field.
