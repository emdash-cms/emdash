---
"emdash": patch
---

Fixes WordPress imports through the EmDash Exporter plugin losing Advanced Custom Fields values: a field that only one post used was never created, and a repeater row that only one post had was lost. For ACF field groups assigned to a post type, the import now creates a field for every ACF field and stores selects, checkboxes, repeaters, groups, relationships and other structured values as JSON. Relationship, post object, user and taxonomy values that arrive as WordPress posts, users or terms keep only their IDs, so a related post's content and password or a user's password hash are not copied into EmDash. A collection from an earlier import keeps the fields it has, so its repeaters still arrive as one field per row and sub-field.

#### What should I do?

Running the import again skips entries that already exist, so if you imported ACF relationship, post object or user fields through the exporter with an earlier version, check those JSON fields for whole WordPress posts and users yourself.
