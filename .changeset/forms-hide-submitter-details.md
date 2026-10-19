---
"@emdash-cms/plugin-forms": patch
---

Hides submitters' IP addresses, user agents and referers from Editors. The `submissions/list` and `submissions/get` routes now return them to Admins only; the admin UI never showed them.
