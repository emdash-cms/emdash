# Theme Porting Checklist

Use this checklist to track progress when porting a WordPress theme to EmDash.

## Phase 1: Discovery & Reference Capture

- [ ] Theme source downloaded and unzipped
- [ ] Demo site URL identified
- [ ] Created `discovery/` folder structure:
  - [ ] `discovery/screenshots/`
  - [ ] `discovery/images/`
  - [ ] `discovery/notes.md`
- [ ] Identified all page types in demo
- [ ] Screenshots captured:
  - [ ] Homepage (`discovery/screenshots/homepage.png`)
  - [ ] Single post (`discovery/screenshots/single-post.png`)
  - [ ] Blog archive (`discovery/screenshots/archive.png`)
  - [ ] Category archive (`discovery/screenshots/category.png`)
  - [ ] Static page (`discovery/screenshots/page.png`)
  - [ ] 404 page (`discovery/screenshots/404.png`)
- [ ] Sample images downloaded to `discovery/images/`
- [ ] Design notes documented in `discovery/notes.md`:
  - [ ] Colors (background, text, primary, accent, borders)
  - [ ] Typography (font families, sizes, line heights)
  - [ ] Layout (content width, header height, sidebar position)
  - [ ] Special components to recreate

## Phase 2: Design Extraction

- [ ] CSS variables defined in `src/styles/global.css`:
  - [ ] Color palette (`--color-base`, `--color-contrast`, `--color-primary`, etc.)
  - [ ] Typography (`--font-body`, `--font-heading`, `--font-mono`)
  - [ ] Font sizes (`--text-sm` through `--text-5xl`)
  - [ ] Spacing scale (`--space-1` through `--space-24`)
  - [ ] Layout (`--content-width`, `--wide-width`, `--header-height`)
- [ ] Fonts loading correctly (Google Fonts or local)
- [ ] Color scheme matches original demo
- [ ] Responsive breakpoints defined

## Phase 3: Template Conversion

- [ ] Base layout created (`src/layouts/Base.astro`)
- [ ] Homepage (`src/pages/index.astro`)
- [ ] Single post (`src/pages/posts/[slug].astro`)
- [ ] Blog archive (`src/pages/posts/index.astro`)
- [ ] Category archive (`src/pages/categories/[slug].astro`)
- [ ] Tag archive (`src/pages/tags/[slug].astro`)
- [ ] Static pages (`src/pages/pages/[slug].astro`)
- [ ] 404 page (`src/pages/404.astro`)
- [ ] Reusable components extracted (PostCard, etc.)

## Phase 4: Dynamic Features

- [ ] Site settings configured:
  - [ ] Title and tagline
  - [ ] Logo (if applicable)
  - [ ] Favicon
- [ ] Navigation menus:
  - [ ] Primary menu
  - [ ] Footer menu (if applicable)
  - [ ] Mobile menu (if different)
- [ ] Taxonomies:
  - [ ] Categories
  - [ ] Tags
  - [ ] Custom taxonomies (if any)
- [ ] Widget areas (if applicable):
  - [ ] Sidebar
  - [ ] Footer widgets

## Phase 5: Create Seed File

- [ ] Seed file created (`.emdash/seed.json`)
- [ ] Collections defined with all fields
- [ ] Taxonomies defined with sample terms
- [ ] Menus defined with items
- [ ] Sample content created:
  - [ ] Posts (3-5 with varied content)
  - [ ] Pages (About, Contact, etc.)
- [ ] Images use `$media` syntax with `discovery/images/` files

## Phase 6: Verify & Iterate

- [ ] Dev server applied seed cleanly on first request (no validation errors in logs)
- [ ] Dev server running: `pnpm dev`
- [ ] Output screenshots captured to `output/`:
  - [ ] Homepage
  - [ ] Single post
  - [ ] Blog archive
  - [ ] Category archive
  - [ ] Static page
  - [ ] 404 page
- [ ] Visual comparison completed for each page
- [ ] Differences identified and fixed
- [ ] Production build succeeds: `pnpm build`

## License Compliance

- [ ] `README.md` credits original theme

If the original theme is GPL-licensed:

- [ ] `LICENSE` file added (GPL-2.0 text)
- [ ] `package.json` has `"license": "GPL-2.0-or-later"`

## Final Review

- [ ] All pages render without errors
- [ ] Mobile responsive design works
- [ ] Navigation works on all pages
- [ ] Images load correctly
- [ ] Typography matches design intent
- [ ] Colors match design intent
- [ ] No console errors in browser

## No Hard-Coded Content

- [ ] Site title uses `settings.title`, not hard-coded string
- [ ] Site tagline uses `settings.tagline`, not hard-coded string
- [ ] Logo uses `settings.logo`, not hard-coded path
- [ ] Navigation uses `getMenu()`, not hard-coded `<a>` tags
- [ ] Footer content uses site settings or widget areas
- [ ] No placeholder text like "My Blog" or "Lorem ipsum" in templates
