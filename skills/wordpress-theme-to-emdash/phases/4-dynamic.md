# Phase 4: Wire dynamic EmDash features

Map the theme's dynamic surfaces to current EmDash site APIs. Read [site features](../../building-emdash-site/references/site-features.md) for the canonical settings, menus, taxonomies, widgets, search, SEO, comments, and page-contribution APIs.

## Site settings

Use CMS settings for values editors are expected to change, such as title, tagline, logo, favicon, and presentation preferences exposed by the target site. Keep build-time implementation choices in project configuration rather than inventing a CMS setting for every WordPress Customizer option.

## Menus

Map WordPress menu locations to stable EmDash menu names such as `primary` or `footer`. Render nested items recursively when the reference theme supports submenus. Preserve keyboard access, focus visibility, current-page state, and mobile open/close behavior.

## Taxonomies

Create only the taxonomies used by the target content model. The taxonomy name passed to `getTerm()`, `getTaxonomyTerms()`, `getEntryTerms()`, and `getEntriesByTerm()` must match the seed or schema exactly. Use `entry.data.id`, not the URL slug in `entry.id`, when an API requires the content database ID.

## Widgets and sidebars

Use an EmDash widget area when editors need to manage an ordered region. Use an ordinary Astro component for fixed theme chrome. Do not assume that a WordPress widget type has a built-in EmDash equivalent; verify the available widget types and component registrations in the target project.

## Plugin-owned behavior

Separate theme presentation from functionality supplied by a WordPress plugin. Forms, synchronization, scheduled work, custom admin workflows, and external-service integrations may need a plugin port. Load [wordpress-plugin-to-emdash](../../wordpress-plugin-to-emdash/SKILL.md) for that work instead of embedding the behavior in a template.
