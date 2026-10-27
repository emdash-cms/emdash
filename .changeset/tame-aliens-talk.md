---
"@emdash-cms/admin": patch
---

Fixes the entry editor’s OG Image preview for seeded or imported SEO images stored as bare media IDs. The editor now shows the resolved image and warns that the saved ID may not work in shared links. Choose **Save image URL** to explicitly replace the ID with a working file URL for social previews and sitemap images; viewing the preview alone does not change the saved value. Relative media paths such as `uploads/og.png` also resolve correctly in the preview.
