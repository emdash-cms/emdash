---
title: Custom icons for plugin admin pages
type: feature-plan
status: proposed
authors:
  - Jon Henshaw (@henshaw)
discussion: null
created: 2026-10-18
---

# Custom icons for plugin admin pages

## Problem and user case

A plugin's admin pages can only use a [Phosphor](https://phosphoricons.com) icon, chosen by name (`icon: "toggle-right"`). Pages that share a `group` appear in one sidebar folder, and the folder shows its first page's icon. For a plugin with several pages, that folder is where people find the plugin in the admin. The plugin can't show its own mark there, so it uses a generic glyph that usually means something else, such as a toggle, a puzzle piece or a gear.

I hit this with Coywolf Pack, a native plugin I run on four EmDash sites. It groups many admin pages in one folder, and the folder shows a toggle switch, which reads as a setting rather than as the plugin. The same applies to any plugin with its own logo, and to plugins whose subject has no Phosphor glyph.

## Proposed behavior

A plugin can give an admin page an icon drawn from SVG path data instead of a Phosphor name:

```ts
admin: {
	pages: [
		{
			path: "/features",
			label: "Features",
			group: "Coywolf Pack",
			icon: {
				viewBox: "0 0 1200 1200",
				path: "M842.68 665.22 C843.92 663.05 …Z",
			},
		},
	],
},
```

- The icon renders wherever the page's icon renders today: the sidebar (expanded and icon-only), the folder the page leads, and the command palette.
- It's drawn in the current text color (`fill="currentColor"`), so it follows light and dark mode, hover and active states like the built-in icons, and needs no colors of its own.
- Built-in icons switch from the regular to the fill weight when their item is active. A custom icon can do the same with an optional `activePath`. Without it, the same shape is used in both states.
- Phosphor names keep working exactly as they do now.
- Block Kit plugins declare the same field, so they get custom icons too.

## Goals

- Plugins can show their own icon in the admin sidebar, its folders and the command palette.
- Custom icons look and behave like built-in icons: same size, theme colors and active state.
- No plugin-supplied markup, styles, scripts or URLs reach the admin page.
- Native and sandboxed plugins declare icons the same way.

## Non-goals

- Raster images, icon URLs or arbitrary SVG markup.
- Multicolor icons. Icons stay single-color so they match the admin theme.
- Custom icons for collections, taxonomies, Portable Text block types, field widgets or dashboard widgets.
- Icons for plugin listings in the marketplace or registry, which have their own image assets.

## Interfaces and compatibility

`PluginAdminPage.icon` (native plugins) and `admin.pages[].icon` in the sandboxed plugin manifest widen from `string` to:

```ts
type PluginPageIcon =
	| string // a Phosphor icon name, as today
	| {
			/** SVG viewBox. Defaults to "0 0 256 256", Phosphor's grid. */
			viewBox?: string;
			/** Path data, filled with the current text color. */
			path: string | string[];
			/** Path data for the active state. Defaults to `path`. */
			activePath?: string | string[];
			/** Defaults to "nonzero". */
			fillRule?: "nonzero" | "evenodd";
	  };
```

The admin manifest carries the object through unchanged. The admin renders it as an `<svg>` with one `<path>` per entry, with path data set as an attribute through React, never as HTML. Existing plugins and stored data don't change, and a string `icon` behaves exactly as it does now.

The plugin docs that show page icons (`creating-native-plugins/react-admin.mdx`, `creating-plugins/block-kit.mdx` and `creating-plugins/manifest.mdx`) gain a short example of a custom icon.

## Errors and edge cases

- **Validation.** Path data may contain only SVG path commands, numbers, signs, commas, dots and whitespace. All of an icon's path data together is limited to 16 KB. `viewBox` must be four finite numbers with a positive width and height.
- **Sandboxed plugins.** The manifest schema rejects an invalid icon, so the problem shows up when the plugin is built or installed, not in the sidebar.
- **Native plugins.** An invalid icon logs one warning and the admin shows the default plugin icon. The plugin still loads.
- **Unexpected shapes.** If anything else reaches the admin, it falls back to the default plugin icon, as an unknown Phosphor name does now.
- **Size and alignment.** The icon is scaled to the same box as built-in icons. Plugins should leave a little padding inside the viewBox, as Phosphor does.
- **Accessibility.** Icons stay decorative (`aria-hidden`). The page label is the accessible name, as now.
- **Right-to-left layouts.** Custom icons aren't mirrored, matching most Phosphor icons.

## Verification

- **Schema tests:** valid icons pass; bad characters, oversized path data and bad viewBoxes fail; string icons are unaffected.
- **Rendering tests:**
  - A custom icon renders in the sidebar, in a folder that inherits it, in the icon-only sidebar and in the command palette.
  - The active state uses `activePath` when it's given.
  - Invalid data falls back to the default icon.
- **Sandboxed round trip:** a sandboxed plugin's custom icon survives the manifest round trip to the admin.
- **Visual regression:** screenshots of a plugin folder with a custom icon in light, dark and right-to-left layouts.
- **Manual check:** with a real plugin in the demo site.

## Open questions

- Does widening the plugin page `icon` type need an RFC, or is a feature plan enough? The change is additive and doesn't affect existing plugins.
- Should a plugin be able to set its folder's icon separately from its first page's icon? This plan keeps the current rule: the folder shows its first page's icon.
- Should the same icon type later apply to other plugin-declared icons, such as Portable Text block types? That's out of scope here, but the type is named so it could be reused.
