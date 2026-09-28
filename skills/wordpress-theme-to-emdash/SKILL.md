---
name: wordpress-theme-to-emdash
description: Port a WordPress theme's design and template behavior to an EmDash-powered Astro site. Use for theme migrations, design matching, PHP-template conversion, and CMS wiring. Do not use for WordPress plugin behavior that does not affect the site theme.
---

# Port a WordPress theme to EmDash

Recreate the theme's relevant layouts and interactions as an Astro site backed by EmDash. Preserve the user's requested visual fidelity and feature scope; do not assume every WordPress template or demo feature belongs in the port.

Load [building-emdash-site](../building-emdash-site/SKILL.md) for current EmDash schema, query, rendering, caching, and seed patterns. Load [agent-browser](../agent-browser/SKILL.md) when a live reference site is available for rendered comparison.

## Choose the evidence

Use the best available sources in this order:

1. theme source and `theme.json`, stylesheets, templates, and `functions.php`;
2. a live demo at representative desktop and mobile viewports;
3. screenshots or design files supplied by the user;
4. explicit design decisions where the source is ambiguous.

Do not infer that demo content or images share the theme code's license. Reuse an asset only when its license or the user's rights permit it; otherwise use a clearly licensed substitute with similar dimensions and visual weight.

## Plan the port

Inventory only the page types, components, responsive states, and interactions needed for the requested site. Map WordPress responsibilities before implementing:

- PHP templates become Astro routes, layouts, and components.
- Custom post types, metadata, and taxonomies become EmDash collections, fields, and taxonomies.
- Theme Customizer values become site settings or explicit project configuration.
- Menu locations become named EmDash menus queried by templates.
- Sidebars and widgets become widget areas or ordinary Astro components.
- Shortcodes and plugin-owned behavior may require a separate plugin migration.

Read [WordPress theme concept mapping](references/concept-mapping.md) when translating template hierarchy, `functions.php` registrations, template tags, hooks, widgets, or reusable blocks.

Dynamic EmDash content routes must remain server-rendered. Use the EmDash `Image` component for EmDash media fields; ordinary theme assets can use Astro's asset handling.

## Work in scoped phases

Read a phase file only when that phase applies:

- [Discovery and reference capture](phases/1-discovery.md)
- [Design extraction](phases/2-design.md)
- [Template conversion](phases/3-templates.md)
- [Dynamic EmDash features](phases/4-dynamic.md)
- [Schema and seed data](phases/5-seed.md)
- [Rendered verification](phases/6-verify.md)

When creating a standalone theme project, start from the repository's current site template or the user's existing project. Confirm the destination before writing and do not replace an existing site structure without explicit direction.

## Verify the result

Build the site and exercise each in-scope page and interaction. Compare matched viewports against the reference, including responsive navigation, content with long and missing values, RTL when admin or theme behavior depends on direction, and relevant empty or error states.

Capture before-and-after or reference-and-result screenshots when visual fidelity is part of acceptance. Report deliberate deviations, missing source evidence, unsupported WordPress behavior, and asset substitutions.

## Licensing and attribution

Inspect the source theme's actual license and notices. Preserve required copyright and attribution, include the applicable license text for reused code, and identify third-party assets separately. Do not label a port GPL-2.0-or-later merely because the source is a WordPress theme.
