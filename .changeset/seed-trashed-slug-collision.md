---
"emdash": patch
---

Fixes seed application failing with a database uniqueness error when a seeded slug or slugless entry ID belongs to content in the trash. In `skip` and `update` modes, EmDash leaves the trashed content unchanged and counts the collision as skipped. In `error` mode, it reports a conflict identifying the trashed entry. References and translations do not resolve through skipped trashed entries.
