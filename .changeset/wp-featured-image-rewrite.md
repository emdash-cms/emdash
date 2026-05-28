---
"emdash": patch
---

Fix WordPress import leaving `featured_image` (and other image/file fields) pointing at the original WordPress URL after media download. The rewrite step passed the whole stored MediaValue JSON to the URL matcher instead of its inner `src`, so the field was never rewritten to the local R2 URL even though the file existed in the media table. Inline content images were unaffected.
