---
"@emdash-cms/admin": patch
---

Fixes the entry editor’s OG Image preview showing “Image not found” when seeded or imported SEO data contains a bare media ID. The preview resolves these IDs through authenticated media APIs without changing stored SEO values or public file access. Relative media paths such as `uploads/og.png` also resolve correctly in the preview.
