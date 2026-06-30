---
"emdash": patch
---

Fixes missing image dimensions and LQIP placeholders (blurhash, dominant color) on media created through signed-URL uploads, plugin `ctx.media.upload()`, and WordPress import. These were only generated for direct (local-storage) uploads, so production (R2/S3) media had no placeholders.

LQIP placeholders are now cached on the stored media value of content fields (alongside `width`/`height`) and on images inserted into rich text, so the `<Image>` component and portable-text image blocks render a blur/color placeholder before the image loads without a runtime lookup.
