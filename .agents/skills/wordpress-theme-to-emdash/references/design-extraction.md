# Design Extraction Guide

Extract design tokens from WordPress themes for use in EmDash.

## CSS Variable Extraction

### Finding Design Tokens in Classic Themes

Look in these files (in order of priority):

1. **`style.css`** - Main stylesheet, often has custom properties
2. **`assets/css/custom-properties.css`** - Some themes separate variables
3. **`inc/customizer.php`** - Default values for customizer options
4. **`functions.php`** - Inline styles with defaults

Common patterns to search for:

```css
/* Root variables */
:root {
  --primary-color: #0073aa;
  --font-family: 'Open Sans', sans-serif;
}

/* Theme-specific prefixes */
--theme-name-color-primary
--wp--preset--color--primary
```

### Finding Design Tokens in Block Themes (theme.json)

Block themes (WordPress 5.9+) store design tokens in `theme.json`:

```json
{
	"settings": {
		"color": {
			"palette": [
				{ "slug": "primary", "color": "#0073aa", "name": "Primary" },
				{ "slug": "secondary", "color": "#23282d", "name": "Secondary" }
			]
		},
		"typography": {
			"fontFamilies": [
				{
					"fontFamily": "'Open Sans', sans-serif",
					"slug": "body",
					"name": "Body"
				}
			],
			"fontSizes": [{ "size": "1rem", "slug": "medium", "name": "Medium" }]
		},
		"spacing": {
			"units": ["px", "em", "rem", "%"],
			"spacingSizes": [{ "size": "1rem", "slug": "20", "name": "Small" }]
		},
		"layout": {
			"contentSize": "650px",
			"wideSize": "1200px"
		}
	}
}
```

Convert to EmDash CSS variables:

```css
:root {
	/* Colors from theme.json palette */
	--color-primary: #0073aa;
	--color-secondary: #23282d;

	/* Typography */
	--font-body: "Open Sans", sans-serif;
	--font-size-medium: 1rem;

	/* Layout */
	--content-width: 650px;
	--wide-width: 1200px;

	/* Spacing */
	--space-20: 1rem;
}
```

## Color Extraction

### From Live Site

Use browser DevTools or automation:

1. **Background colors**: `document.body.style.backgroundColor`
2. **Text colors**: Inspect body, headings, links
3. **Accent colors**: Buttons, links, highlights

Common elements to check:

- Body background and text
- Header/footer backgrounds
- Link colors (normal, hover, visited)
- Button colors (primary, secondary)
- Border colors
- Selection highlight

### Common Color Mapping

| WP Pattern       | EmDash Variable     |
| ---------------- | ------------------- |
| Background       | `--color-base`      |
| Text             | `--color-contrast`  |
| Primary brand    | `--color-primary`   |
| Secondary brand  | `--color-secondary` |
| Accent/highlight | `--color-accent-1`  |
| Muted text       | `--color-muted`     |
| Border           | `--color-border`    |
| Error            | `--color-error`     |
| Success          | `--color-success`   |

## Typography Extraction

### Font Families

Check for:

1. Google Fonts in `<head>` - `fonts.googleapis.com`
2. `@font-face` declarations in CSS
3. Font files in `assets/fonts/` or `fonts/`
4. Customizer settings for typography

Extract the stack:

```css
/* WP theme might have */
font-family: "Playfair Display", Georgia, serif;

/* Convert to EmDash */
:root {
	--font-heading: "Playfair Display", Georgia, serif;
}
```

### Font Sizes

Common patterns:

```css
/* WP theme */
body {
	font-size: 18px;
}
h1 {
	font-size: 2.5em;
}
h2 {
	font-size: 2em;
}

/* EmDash with clamp for responsiveness */
:root {
	--font-size-base: clamp(1rem, 0.5vw + 0.9rem, 1.125rem);
	--font-size-xl: clamp(1.75rem, 1vw + 1.5rem, 2rem);
	--font-size-xxl: clamp(2.15rem, 2vw + 1.5rem, 3rem);
}
```

### Line Height and Spacing

```css
/* Extract these values */
line-height: 1.6;
letter-spacing: -0.01em;
```

## Spacing System

### Identify the Scale

Look for consistent spacing values:

```css
/* Common WordPress patterns */
padding: 20px;
margin-bottom: 30px;
gap: 2rem;
```

Create a scale:

```css
:root {
	--space-10: 0.25rem; /* 4px */
	--space-20: 0.5rem; /* 8px */
	--space-30: 1rem; /* 16px */
	--space-40: 1.5rem; /* 24px */
	--space-50: 2rem; /* 32px */
	--space-60: 3rem; /* 48px */
	--space-70: 4rem; /* 64px */
	--space-80: 6rem; /* 96px */
}
```

## Layout Extraction

### Content Width

Find in:

- `.container`, `.wrapper`, `.site-content` max-width
- `theme.json` layout.contentSize
- Customizer settings

```css
/* WP theme */
.container {
	max-width: 1140px;
}
.content-area {
	max-width: 720px;
}

/* EmDash */
:root {
	--content-width: 720px;
	--wide-width: 1140px;
}
```

### Breakpoints

Common WordPress breakpoints:

```css
/* Find in theme CSS */
@media (max-width: 1200px) {
}
@media (max-width: 992px) {
}
@media (max-width: 768px) {
}
@media (max-width: 576px) {
}
```

Document for use in Astro:

```css
/* EmDash breakpoints */
@media (max-width: 1024px) {
	/* Tablet landscape */
}
@media (max-width: 768px) {
	/* Tablet portrait */
}
@media (max-width: 640px) {
	/* Mobile */
}
```

## Component Patterns

### Header Pattern

Identify header structure:

- Logo position (left, center)
- Navigation style (horizontal, hamburger)
- Background (solid, transparent, sticky)

```css
/* Extract key values */
.site-header {
	height: 80px;
	background: #ffffff;
	position: sticky;
	top: 0;
	z-index: 100;
}
```

### Card Pattern

```css
/* WP card styles */
.post-card {
	border-radius: 8px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	overflow: hidden;
}

/* EmDash equivalent */
:root {
	--radius-card: 8px;
	--shadow-card: 0 2px 8px rgba(0, 0, 0, 0.1);
}
```

### Button Pattern

```css
/* WP button */
.button,
.wp-block-button__link {
	padding: 12px 24px;
	border-radius: 4px;
	font-weight: 600;
	text-transform: uppercase;
}

/* EmDash */
.btn {
	padding: var(--space-30) var(--space-40);
	border-radius: var(--radius-button);
	font-weight: 600;
}
```

## Automated Extraction Script

For complex themes, consider a script approach:

```javascript
// Run in browser console on live WP site
const styles = getComputedStyle(document.body);
const tokens = {
	colors: {
		background: styles.backgroundColor,
		text: styles.color,
	},
	typography: {
		fontFamily: styles.fontFamily,
		fontSize: styles.fontSize,
		lineHeight: styles.lineHeight,
	},
};

// Check header
const header = document.querySelector("header, .site-header");
if (header) {
	const headerStyles = getComputedStyle(header);
	tokens.header = {
		background: headerStyles.backgroundColor,
		height: headerStyles.height,
	};
}

console.log(JSON.stringify(tokens, null, 2));
```

## Output Template

Final CSS variables for EmDash Base.astro:

```css
:root {
	/* Colors */
	--color-base: #ffffff;
	--color-contrast: #1a1a1a;
	--color-primary: #0073aa;
	--color-secondary: #23282d;
	--color-muted: #757575;
	--color-border: #e0e0e0;

	/* Typography */
	--font-body: "Open Sans", system-ui, sans-serif;
	--font-heading: "Playfair Display", Georgia, serif;
	--font-mono: "Fira Code", monospace;

	/* Font sizes */
	--font-size-small: 0.875rem;
	--font-size-base: 1rem;
	--font-size-large: 1.125rem;
	--font-size-xl: 1.5rem;
	--font-size-xxl: 2rem;
	--font-size-xxxl: 3rem;

	/* Spacing */
	--space-20: 0.5rem;
	--space-30: 1rem;
	--space-40: 1.5rem;
	--space-50: 2rem;
	--space-60: 3rem;
	--space-70: 4rem;
	--space-80: 6rem;

	/* Layout */
	--content-width: 720px;
	--wide-width: 1200px;

	/* Components */
	--radius-small: 4px;
	--radius-medium: 8px;
	--radius-large: 16px;
	--shadow-small: 0 1px 3px rgba(0, 0, 0, 0.1);
	--shadow-medium: 0 4px 12px rgba(0, 0, 0, 0.15);
}
```
