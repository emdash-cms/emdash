---
name: wordpress-theme-to-emdash
description: Port WordPress themes to EmDash CMS. Use when asked to convert, migrate, or port a WordPress theme to EmDash, or when creating an EmDash site that should match an existing WordPress site's design. Handles design extraction, template conversion, and EmDash-specific features like menus, taxonomies, and widgets.
---

# WordPress Theme to EmDash

Port WordPress themes to EmDash in six phases. **Read the phase file before starting each phase.**

## Critical Rules

1. **Copy scaffold first** - Start every theme by copying `scaffold/` from this skill
2. **Take screenshots of demo** - Identify the demo URL and capture all page types using agent-browser before starting work
3. **No hard-coded content** - Use `getSiteSettings()` for title/tagline, `getMenu()` for navigation
4. **Server-rendered pages** - Never use `getStaticPaths()` for EmDash content
5. **Astro 6** - Use `ClientRouter` not `ViewTransitions`, Zod 4 syntax, Node 22+
6. **Use emdash Image component** - For all images, import Image from "emdash/ui"

## Phases

| Phase | File                    | Summary                                         |
| ----- | ----------------------- | ----------------------------------------------- |
| 1     | `phases/1-discovery.md` | Download theme, screenshot demo, capture images |
| 2     | `phases/2-design.md`    | Extract CSS variables, fonts, colors            |
| 3     | `phases/3-templates.md` | Convert PHP templates to Astro                  |
| 4     | `phases/4-dynamic.md`   | Site settings, menus, taxonomies, widgets       |
| 5     | `phases/5-seed.md`      | Create seed file with demo content              |
| 6     | `phases/6-verify.md`    | Screenshot, compare, iterate, build             |

## Checklist

### Setup

- [ ] Copy `scaffold/` to new theme directory. Unless otherwise specified by the user, make this a subdirectory of `themes/` and name it after the WordPress theme (e.g., `themes/twentytwentyfour/`).
- [ ] Rename folder, update `package.json`
- [ ] Verify build: `pnpm build`

### Phase 1: Discovery

- [ ] Theme source downloaded
- [ ] Demo site identified
- [ ] `discovery/` folder created with `screenshots/`, `images/`, `notes.md`
- [ ] All page types screenshotted
- [ ] Sample images downloaded

### Phase 2: Design

- [ ] CSS variables in `global.css`
- [ ] Fonts loading
- [ ] Colors match demo

### Phase 3: Templates

- [ ] Homepage, single post, archive, category, tag, page, 404
- [ ] Components extracted (PostCard, etc.)

### Phase 4: Dynamic

- [ ] Site settings (title, tagline, logo from CMS)
- [ ] Navigation menus (from CMS, not hard-coded)
- [ ] Taxonomies
- [ ] Widget areas (if applicable)

### Phase 5: Seed

- [ ] Seed file created with demo images
- [ ] Validates: `emdash seed --validate`

### Phase 6: Verify

- [ ] Seed applied
- [ ] Output screenshots captured
- [ ] Visual comparison done
- [ ] Build succeeds: `pnpm build`
- [ ] LICENSE file downloaded (GPL-2.0 in most cases)
- [ ] README credits original theme

## Reference Documents

- `references/astro-essentials.md` - Astro 6 patterns
- `references/template-patterns.md` - PHP → Astro conversion
- `references/concept-mapping.md` - WP → EmDash concepts
- `references/emdash-api.md` - Full API reference
- `references/design-extraction.md` - CSS extraction techniques
