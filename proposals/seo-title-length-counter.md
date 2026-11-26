---
title: Show estimated SEO title length in the SEO panel
type: feature-plan
status: proposed
authors:
  - Santiago (@SantiagoSM2000)
discussion: null
created: 2026-11-26
---

# Show estimated SEO title length in the SEO panel

## Problem and user case

In the content editor's SEO panel (`SeoPanel`), **Meta Description** shows a live character count (`{count}/160 characters`) below the field, while **SEO Title** shows no character count at all.

Meanwhile, `getSeoMeta()` builds the rendered `<title>` by appending the site title suffix whenever both a page title and `siteTitle` are present:

```ts
const separator = options.titleSeparator || " | ";
const fullTitle = siteTitle && pageTitle ? `${pageTitle}${separator}${siteTitle}` : pageTitle;
```

On a production news/publication site I maintain on EmDash, the site suffix (`" · <Site Name>"`) adds 16 characters to every article `<title>`. An article with a 69-character headline produces an 85-character `<title>` in the published HTML. While editing that entry in EmDash, the SEO panel shows the fallback title as a placeholder and counts characters for **Meta Description**, but gives no length estimate for **SEO Title**—forcing editors to mentally add the site suffix to judge whether an entry's default title needs a shorter override.

## Proposed behavior

Add a live, informational character count below the **SEO Title** input in `SeoPanel`, matching the visual slot, muted styling (`text-xs leading-4 text-kumo-subtle`), and accessibility wiring (`aria-describedby`) of the existing **Meta Description** counter.

The count is an **estimate based on site settings** (`siteTitle` and `seo.titleSeparator`, following `getSeoMeta()`'s convention). Templates remain free to compose `<title>` differently—for example, `templates/blog/src/pages/posts/[slug].astro` and `templates/starter/src/pages/posts/[slug].astro` pass `siteTitle` to `getSeoMeta()` without passing `titleSeparator`, and custom layouts may apply site-specific rules (such as skipping the brand suffix when the title already includes the site name).

Computation rules:

1. **Effective page title:** `draft.title || defaultTitle || ""` (the typed **SEO Title** override when non-empty; otherwise the entry's fallback title already displayed as the placeholder, so editors immediately see when the default title plus suffix is already long).
2. **Estimated site suffix:** when both the effective page title and `siteTitle` are non-empty, `suffixLength = (titleSeparator || " | ").length + siteTitle.length`; otherwise `0`.
3. **Estimated total:** `effectiveTitle.length + suffixLength`.

Rendered helper text (neutral `text-kumo-subtle` tone at all lengths, matching **Meta Description**):

- When a site suffix applies (`suffixLength > 0`):
  ```text
  85 characters (includes 16 from site title and separator)
  ```
- When no site suffix applies (`siteTitle` is unset/empty, or both **SEO Title** and `defaultTitle` are empty):
  ```text
  69 characters
  ```

Reporting the suffix contribution as a number rather than quoting the literal site title keeps the helper line compact inside the narrow editor sidebar and avoids mixing LTR/RTL site names inside translated sentences.

Worked example (`siteTitle` = `"Daily Gazette"`, `titleSeparator` = `" · "` → 16-character suffix):

| SEO Title input               | Entry `defaultTitle`          | Estimated `<title>` | Helper line                                                 |
| ----------------------------- | ----------------------------- | ------------------- | ----------------------------------------------------------- |
| _(empty)_                     | 69-character article headline | 69 + 16 = 85 chars  | `85 characters (includes 16 from site title and separator)` |
| 42-character shorter override | 69-character article headline | 42 + 16 = 58 chars  | `58 characters (includes 16 from site title and separator)` |
| _(empty)_                     | _(empty)_                     | 0 chars             | `0 characters`                                              |

Because search engines truncate title links by rendered pixel width rather than a fixed character cap (and may rewrite titles), the counter does not enforce a hard limit or color-code a fixed threshold; it stays purely informational, like **Meta Description**.

## Goals

- Give editors an immediate, site-aware character length estimate under **SEO Title** in `SeoPanel`.
- Count the entry's fallback title (`defaultTitle`) when **SEO Title** is blank so editors can tell before typing whether a shorter override is warranted.
- Require zero extra HTTP requests or database queries when opening the content editor, and work for every role that can edit content (including Authors, who do not have `settings:read`).
- Keep the counter accessible (`aria-describedby`), translatable (Lingui), compact in the editor sidebar, and clean in right-to-left locales.

## Non-goals

- Enforcing a hard character limit or blocking saves.
- Rendering a SERP snippet preview card or estimating pixel width.
- Changing `getSeoMeta()`, template `<title>` rendering, or how `titleSeparator` is stored.
- Changing the existing **Meta Description** counter.

## Interfaces and compatibility

- **`GET /_emdash/api/manifest` (`EmDashManifest` / `AdminManifest`):** Add an optional `seoTitleSeparator?: string` field. `packages/core/src/astro/routes/api/manifest.ts` already reads `site:title` and `emdash:site_title` in a single `OptionsRepository.getMany([...])` call; adding `"site:seo"` reads `seo.titleSeparator` with zero additional database queries and exposes it to all editor roles (not only `EDITOR+` roles with `settings:read`).
- **`SeoSettings` (`packages/admin/src/components/settings/SeoSettings.tsx`):** Invalidate `["manifest"]` alongside `["settings"]` after saving SEO settings (matching `GeneralSettings.tsx`), so changes to **Title Separator** are reflected in the content editor without a full reload.
- **`SeoPanelProps` (`packages/admin/src/components/SeoPanel.tsx`):** Add optional `siteTitle?: string | null` and `titleSeparator?: string | null` props. `ContentSettingsPanel` passes `manifest?.siteTitle` and `manifest?.seoTitleSeparator`. Both props are optional, keeping existing callers and tests backwards-compatible.
- **Database / public API:** No database migrations and no breaking API changes.

## Errors and edge cases

- **`siteTitle` unset or blank:** Treated as absent; `suffixLength` is `0` and the counter renders `{count} characters` without a suffix note, matching `getSeoMeta()`.
- **`titleSeparator` unset or empty string `""`:** Falls back to `" | "` (3 characters), matching `options.titleSeparator || " | "` in `packages/core/src/seo/index.ts`.
- **Both `SEO Title` and `defaultTitle` empty (untitled entry):** Renders `0 characters` without adding `suffixLength`, matching `getSeoMeta()` returning `""` when `pageTitle` is empty.
- **Older server manifest without `seoTitleSeparator`:** Optional field is `undefined`, falling back to `" | "`.
- **Template divergence:** Because the panel derives the estimate from site settings (`siteTitle` and `seo.titleSeparator`), sites whose templates omit `titleSeparator` (including the current `blog` and `starter` templates) or apply custom title formatting may render a slightly different `<title>` length than the estimate.
- **Input stability:** Updating the counter while typing must not unmount or reset the **SEO Title** `<Input>` (same invariant tested for **Meta Description**).

## Verification

- **Admin browser tests (`packages/admin/tests/components/SeoPanel.test.tsx`):**
  - Renders `{total} characters (includes {suffix} from site title and separator)` when `SEO Title` is typed with `siteTitle` and default `" | "` separator.
  - Accounts for custom `titleSeparator` when provided (e.g. `" · "`).
  - Counts `defaultTitle + suffix` when `SEO Title` is empty and `defaultTitle` is set.
  - Renders `0 characters` when both `SEO Title` and `defaultTitle` are empty.
  - Omits the suffix note when `siteTitle` is unset.
  - Keeps the `SEO Title` input mounted while typing and associates the counter via `aria-describedby`.
- **Core unit test (`packages/core/tests/unit/astro/manifest-route.test.ts`):** Verify `GET /_emdash/api/manifest` returns `seoTitleSeparator` when `site:seo.titleSeparator` is non-empty and omits it when unset or empty.
- **Manual verification:** Check the content editor SEO panel in `demos/simple` in English (LTR) and Arabic (RTL) with before/after screenshots, and verify that updating **Title Separator** in **Settings → SEO** refreshes the count in the editor.

## Open questions

- **Uncapped count vs. `/60` guideline:** This plan proposes an uncapped count (`85 characters (includes 16 from site title and separator)`) because search engines truncate titles by pixel width rather than a fixed character limit. Should we keep it uncapped, or show a `/60` editorial guideline (`85/60 characters ...`) for visual parity with **Meta Description**'s `{count}/160 characters`?
