# Phase 2: Design Extraction

Extract design tokens from the WordPress theme source and live demo.

## 2.1 Analyze the Live Site

Use `agent-browser` to extract computed styles:

```bash
agent-browser eval "(() => {
  const body = getComputedStyle(document.body);
  const header = document.querySelector('header, .site-header');
  return JSON.stringify({
    body: {
      fontFamily: body.fontFamily,
      fontSize: body.fontSize,
      color: body.color,
      background: body.backgroundColor,
    },
    header: header ? {
      background: getComputedStyle(header).backgroundColor,
      height: getComputedStyle(header).height,
    } : null,
  }, null, 2);
})()"
```

## 2.2 Extract Design Tokens

Read the theme's CSS files. Look for:

```
style.css           # Main stylesheet (has theme header)
assets/css/         # Additional stylesheets
theme.json          # Block themes (WP 5.9+) - structured design tokens
```

### CSS Variable Mapping

| WP Pattern       | EmDash Variable    |
| ---------------- | ------------------ |
| Body font family | `--font-body`      |
| Heading font     | `--font-heading`   |
| Primary color    | `--color-primary`  |
| Background       | `--color-base`     |
| Text color       | `--color-contrast` |
| Content width    | `--content-width`  |

### Block Theme (theme.json)

Block themes store design tokens in `theme.json`:

```json
{
	"settings": {
		"color": {
			"palette": [{ "slug": "primary", "color": "#0073aa", "name": "Primary" }]
		},
		"typography": {
			"fontFamilies": [{ "fontFamily": "'Open Sans', sans-serif", "slug": "body" }]
		},
		"layout": {
			"contentSize": "650px",
			"wideSize": "1200px"
		}
	}
}
```

## 2.3 Create Base Layout

Create `src/layouts/Base.astro` with:

- Extracted CSS variables in `:root`
- Header/footer structure matching WP theme
- Font loading (Google Fonts or local)
- Responsive breakpoints

### CSS Variables Template

```css
:root {
	/* Colors */
	--color-base: #ffffff;
	--color-contrast: #1a1a1a;
	--color-primary: #0073aa;
	--color-accent: #ff6b35;
	--color-muted: #6b7280;
	--color-border: #e5e7eb;

	/* Typography */
	--font-body: system-ui, sans-serif;
	--font-heading: Georgia, serif;

	/* Font sizes */
	--text-sm: 0.875rem;
	--text-base: 1rem;
	--text-lg: 1.125rem;
	--text-xl: 1.25rem;
	--text-2xl: 1.5rem;
	--text-3xl: 1.875rem;
	--text-4xl: 2.25rem;
	--text-5xl: clamp(2.5rem, 5vw, 3rem);

	/* Spacing */
	--space-1: 0.25rem;
	--space-2: 0.5rem;
	--space-4: 1rem;
	--space-6: 1.5rem;
	--space-8: 2rem;
	--space-12: 3rem;
	--space-16: 4rem;
	--space-24: 6rem;

	/* Layout */
	--content-width: 720px;
	--wide-width: 1200px;
	--header-height: 80px;
}
```

See `references/design-extraction.md` for detailed extraction techniques.
