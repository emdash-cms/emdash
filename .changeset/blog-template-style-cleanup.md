---
"emdash": patch
---

Adds CSS custom-property hooks to portable-text block defaults in `Image`, `Embed`, `Gallery`, and `Break` so host sites can theme figcaptions and horizontal rules without overriding component CSS. Resolution order is `--emdash-caption-color` → `--color-muted` → `#666` for captions, `--emdash-break-color` → `--color-border` → `#e0e0e0` for the break line, and `--emdash-break-dots-color` → `--color-muted` → `#999` for break dots. Backward compatible: sites that don't define any of these variables get the previous hex defaults; sites that already expose the conventional `--color-muted` / `--color-border` tokens (e.g. the blog template) now get correct dark-mode theming automatically.
