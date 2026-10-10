---
"emdash": patch
---

Fixes WordPress imports through the EmDash Exporter plugin losing Advanced Custom Fields values. A field that only one post used was never created, and repeater rows were split into separate fields, so a row that only one post had was lost. The import now creates a field for every field in the ACF field groups assigned to a post type, and stores repeaters, groups, relationships, checkboxes and other structured ACF values as JSON. A field that an earlier import already created keeps its type.
