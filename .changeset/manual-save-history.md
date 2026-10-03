---
"emdash": patch
---

Fixes autosave removing the previous manual Save checkpoint from revision history. Autosave now replaces only an older autosave, while manual saves remain available within the normal history retention limit. Existing revisions are preserved when upgrading.

For rolling deployments, deploy the atomic-save compatibility patch to every application instance before applying this revision-history migration, so older instances can continue exporting the site.
