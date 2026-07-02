---
"@emdash-cms/template-blog": minor
"@emdash-cms/template-blog-cloudflare": minor
"@emdash-cms/template-marketing": minor
"@emdash-cms/template-marketing-cloudflare": minor
---

Restructures theming so a site can be rethemed entirely from `src/styles/theme.css`. Design tokens now live in `src/styles/tokens.css` as real (not commented) defaults, colors are defined once with CSS `light-dark()` so a single override rethemes both light and dark mode, and font tokens are semantic (`--font-body`, `--font-heading`) so a serif theme no longer means setting `--font-sans` to a serif. The main brand color is `--color-brand` in both templates (was `--color-accent` in blog, `--color-primary` in marketing), with `--color-on-brand` and `--color-brand-ring` replacing hardcoded white text and focus rings. The marketing template's signature gradients are now `--gradient-*` tokens, its heading weights are `--font-weight-heading`/`--font-weight-display`, and form errors use a new `--color-danger` that follows the theme toggle (previously they only tracked the OS preference).
