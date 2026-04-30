---
"emdash": patch
---

Adds CSS custom-property fallbacks (`--emdash-caption-color`, `--emdash-break-color`, `--emdash-break-dots-color`) to portable-text block defaults in `Image`, `Embed`, `Gallery`, and `Break` so host sites can theme figcaptions and horizontal rules without overriding the components. Backward compatible: existing hex defaults are preserved as the fallback values.
