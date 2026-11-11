---
"emdash": patch
---

Reduces the code a site evaluates on the first request of each new server instance. Importing anything from `emdash`, such as `getEmDashCollection`, no longer forces the API schemas, the WordPress importer, the seed applier and other admin-only code to load before a page renders. They load when an admin, API or import request first uses them. Sites need no changes.
