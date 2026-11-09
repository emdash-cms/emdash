---
"@emdash-cms/plugin-forms": patch
---

Fixes a form saving its fields to session storage again after a successful submission had cleared them, when the visitor submitted within half a second of typing. The next page in that tab that showed the form restored those stale values.
