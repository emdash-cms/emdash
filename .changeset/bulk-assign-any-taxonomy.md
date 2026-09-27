---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes bulk term assignment only working with the built-in `tag` taxonomy. Editors can now add a term from any taxonomy, such as a category or a custom taxonomy, to up to 50 posts from a collection's bulk-actions bar or from that taxonomy's page. When several taxonomies apply to a collection, the dialog asks which one to use. The `POST /_emdash/api/taxonomies/bulk-tag` endpoint now accepts a term from any taxonomy, and matches only entries in the collections that use that taxonomy.
