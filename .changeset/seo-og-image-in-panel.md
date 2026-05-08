---
"@emdash-cms/admin": patch
---

Fixes the OG image picker in the content editor only appearing for collections with a field literally named `featured_image`. The OG image control now lives in the SEO sidebar panel alongside the other SEO fields, so any collection with `seo` enabled can set a social preview image regardless of whether it has a featured image field.
