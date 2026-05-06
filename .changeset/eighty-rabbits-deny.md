---
"@emdash-cms/auth": patch
"emdash": patch
---

Permanent-delete API now refuses to remove live (non-trashed) rows and uses a content-domain `content:delete_permanent` permission instead of the unrelated `import:execute`. Existing audience (ADMIN-only) is unchanged.
