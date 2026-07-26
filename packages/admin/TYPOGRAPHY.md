# Admin typography

This document defines the typography direction for the EmDash admin UI and the rollout process for applying it beyond the Dashboard.

## Objective

Keep Noto Sans for internationalization coverage while making the admin feel deliberate through a restrained type scale, consistent hierarchy, appropriate weight, readable line height, and semantic colour.

The Dashboard is the approved reference implementation. Apply its rules page by page; do not treat this as permission for a bulk class replacement.

## Approved decisions

These decisions came from reviewing the Dashboard in the browser:

1. **Noto Sans stays.** Internationalization coverage takes priority over replacing the typeface.
2. **Improve hierarchy without changing layout.** Typography work must not quietly alter page padding, card padding, control height, grid gaps, or section spacing.
3. **Preserve the existing Dashboard rhythm.** Its top-level stack remains `space-y-6` (`24px`).
4. **Use one card-heading treatment.** Metric cards, content cards, activity cards, and plugin cards use a text-only `h2` inside Kumo's default `LayerCard.Secondary`, with the same inner inset as the content directly beneath it.
5. **Do not shrink operational labels to `12px`.** Labels such as “Draft”, “Media files”, “User”, “Content”, and “Recent Activity” remain at Kumo's default `14px` card-heading size.
6. **Make values lead without making labels disappear.** Large metric values can be more prominent, while their labels remain readable and consistent with other card headings.
7. **Use semantic Kumo colour tokens.** Do not introduce raw colour utilities or `dark:` variants.
8. **Keep all layout changes RTL-safe.** Typography changes must not introduce physical alignment, margin, padding, or border utilities.

## Reference styles

The approved Dashboard implementation lives in `src/components/Dashboard.tsx`.

| Role                        | Tailwind treatment                                            | Notes                                                                                                                  |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Page title                  | `text-2xl font-semibold leading-tight`                        | `24px`, weight `600`; replaces oversized `text-3xl font-bold` on standard admin pages                                  |
| Page subtitle               | `mt-1 text-sm leading-5 text-pretty text-kumo-subtle`         | Keep descriptive copy in the same heading block as the page title; the classic light-theme token preserves AA contrast |
| Card heading                | Kumo `LayerCard.Secondary` with a text-only `h2` using `px-3` | Keep one `14px` treatment and repeat the inset on direct card content                                                  |
| Metric value                | `text-3xl font-semibold leading-none tabular-nums`            | `30px`, weight `600`; tabular digits prevent count changes from shifting                                               |
| Primary row label           | `text-base font-medium leading-5`                             | `14px`, weight `500`; suitable for collection and activity titles                                                      |
| Secondary row metadata      | `text-xs font-normal leading-5 text-kumo-subtle`              | `12px` is reserved for metadata, not card headings or primary actions                                                  |
| Dynamic time/count metadata | Add `tabular-nums`                                            | Use for relative times, counts, prices, durations, or other changing numeric values                                    |
| Empty-state text            | `text-sm` or `text-base` with `leading-6 text-pretty`         | Use `13px` in compact cards and `14px` in full-page panels                                                             |

The semantic heading element still follows the document outline. Choose `h1`, `h2`, or `h3` for structure, then apply the visual role above; do not choose a heading level for its browser-default size.

Kumo maps `text-xs` through `text-lg` to `12px`, `13px`, `14px`, and `16px`. `text-xl`, `text-2xl`, and `text-3xl` remain `20px`, `24px`, and `30px`.

## Hierarchy rules

### Standard admin pages

- Use one `h1` per page.
- Standard page titles use the approved `24px/600` treatment.
- Place a page description directly below its title using the page-subtitle role.
- A lower heading level must never render larger than a higher heading on the same page.
- Use `font-semibold` sparingly for titles and section headings. Use `font-medium` for row titles and labels.
- Do not make all visible text medium or semibold. Metadata needs a normal-weight, lower-contrast role.
- Avoid one-off font sizes. Use the reference roles before adding a new size.
- Keep the default `text-2xl` line height when a title uses `truncate`; combining its hidden overflow with `leading-tight` can clip tall glyphs.
- Never use `tracking-*` utilities. Preserve the font's default spacing across Latin, CJK, Arabic, Persian, Thai, and other supported scripts.

### Cards and metrics

- Let Kumo own card-heading size, weight, padding, border, and surface styling.
- Do not override one category of card heading merely to make the card feel more or less important.
- Use the value, icon, semantic colour, or card position to establish metric hierarchy.
- Apply `tabular-nums` to values that may change.

### Rows, tables, and lists

- Primary row text normally uses Kumo's `text-base`: `14px/500` with a `20px` line height.
- Metadata may use `12px/400` when it is genuinely secondary and remains readable.
- Use `truncate` or `line-clamp-*` only when the complete value remains available through the destination, tooltip, or expanded view.
- Do not tighten row padding as part of typography work.

### Descriptions and prose

- Body copy that may wrap across several lines needs a line height around `1.5`–`1.6`.
- Use `text-pretty` for short descriptions and empty states.
- Cap explanatory prose near `60–75` characters per line rather than letting it span the full admin content area.
- Use `text-balance` only for short headings that can wrap; do not apply it to long body text.

### Forms

- Kumo's default `text-base` input text is `14px`. Inputs that must avoid iOS focus zoom need an explicit `text-lg` (`16px`) on mobile and may use `sm:text-base` on larger viewports.
- Labels must remain at least `14px` unless they are auxiliary metadata.
- Placeholders and help text may be subtle, but still need sufficient contrast.
- Continue using Kumo inputs, labels, selects, dialogs, and buttons rather than reproducing their typography locally.

## Font foundation

- Continue loading Noto Sans through `--font-emdash` and Tailwind's `--font-sans` mapping in `src/styles.css`.
- Serve web fonts as `.woff2`.
- Keep explicit role weights as the cross-platform source of hierarchy; do not depend on rasterizer-specific smoothing for perceived weight.
- Apply font smoothing to the route-scoped admin body as a macOS enhancement so page content and portalled overlays render consistently there. Windows and Linux retain their native text rasterization.
- Add `font-synthesis: none` at the root only after verifying every used Noto Sans weight and style is actually loaded; missing weights should not be silently faked.
- Prefer CSS properties such as `font-weight` and `font-variant-numeric` over raw OpenType tags.

## Colour and accessibility

- Use `text-kumo-default`, `text-kumo-subtle`, and other semantic Kumo tokens.
- Regular text must meet WCAG AA contrast (`4.5:1`); large text must meet `3:1`.
- The classic light-theme `text-kumo-subtle` token must meet the regular-text contrast floor before it is used for page subtitles or metadata.
- Never reduce contrast and size at the same time without checking the rendered result.
- UI copy should rarely go below `12px`. Treat `12px` as metadata size, not a default UI size.
- Verify zoom and text resizing do not clip titles, labels, or controls.

## Layout guardrail

Every typography change must begin with a layout diff check.

Do not change these unless the task explicitly includes layout:

- `space-*`, `gap-*`, margin, or padding utilities
- grid columns or breakpoints
- width, height, or min/max-size utilities
- card, table, dialog, and control padding
- sidebar or header dimensions

If a typographic change makes the layout feel wrong, first adjust type size, weight, line height, or contrast. Propose any spacing change separately and state its exact pixel impact.

## Rollout plan

### Phase 1: Standard index pages

Start with pages that currently use `text-3xl font-bold` and otherwise follow the standard admin shell:

- Menus
- Plugins
- Redirects
- Sections
- Widgets
- Taxonomies
- Plugin Registry
- Marketplace
- Themes

For each page, normalize the page title first, then inspect section headings, cards, rows, metadata, counts, empty states, and truncation.

### Phase 2: Detail and editor pages

- Menu editor
- Plugin and theme detail pages
- Content list and content editor chrome
- Media library and media detail panel
- Content types, bylines, sections, and widgets editors

These screens are denser. Preserve control dimensions and editor workspace area while improving text hierarchy.

### Phase 3: Management and settings pages

- Settings index and individual settings pages
- Users and user detail
- Comments inbox and detail
- Import and backup flows
- Plugin settings

Focus on form labels, help text, table density, status text, and long descriptions. Verify mobile input sizing.

### Phase 4: Separate contexts

Review these as their own typography systems instead of forcing the standard page scale onto them:

- Login, signup, invitations, and device authorization
- Setup wizard and welcome dialog
- Dialog titles and compact panels
- Portable Text editor menus, toolbars, and document outline

They may share the same font and semantic roles, but their viewing distance and density differ from full admin pages.

## Per-page workflow

1. Capture the page before editing in light and dark mode.
2. Inventory text by role: page title, section heading, card heading, primary row text, metadata, body copy, form label, help text, and dynamic numeric value.
3. Record existing layout utilities and leave them unchanged.
4. Apply the smallest set of typography-only changes using Tailwind and Kumo.
5. Compare the rendered page at desktop and narrow widths. Read real wrapped text instead of checking only class names.
6. Verify the heading outline remains semantic and descending.
7. Verify dynamic numeric values use tabular figures where appropriate.
8. Test Arabic for directionality, CJK for default font spacing, and a long-text locale or pseudo-locale for wrapping.
9. Confirm both light and dark themes retain readable contrast.
10. Run `pnpm lint:quick`, `pnpm typecheck`, focused tests, and the relevant admin build.

Do not include generated `messages.po` changes in typography-only work.

## Page acceptance checklist

- [ ] Noto Sans is loaded; the intended weights are not synthesized.
- [ ] The hierarchy remains clear with macOS font smoothing unavailable, as on Windows and Linux.
- [ ] The page has one clear `h1` using the standard page-title role where applicable.
- [ ] Heading levels are semantic and visually descending.
- [ ] Headings and metrics preserve the font's default tracking in every supported script.
- [ ] Card headings use one consistent Kumo treatment.
- [ ] Primary labels are not reduced to metadata size.
- [ ] Metadata is visibly secondary without becoming hard to read.
- [ ] Changing numbers use `tabular-nums`.
- [ ] Wrapped copy has comfortable line height and a sensible measure.
- [ ] Truncated content remains discoverable.
- [ ] Existing spacing, padding, control size, and layout remain unchanged.
- [ ] Light mode, dark mode, Arabic RTL, CJK, and narrow layouts have been checked.
- [ ] Lint, typecheck, focused tests, and the admin build pass.

## Dashboard status

The Dashboard currently demonstrates the approved direction:

- standard `24px/600` page title
- consistent Kumo card headings
- prominent `30px/600` metric values with tabular figures
- `14px/500` primary row titles
- `12px/400` secondary metadata
- readable empty states
- original `24px` section rhythm and existing card padding preserved

Use it as a visual reference, not as a source for copying every class into every context.
