---
title: Auto-updating heading links in Portable Text
type: feature-plan
status: proposed
authors:
  - Matt Kane (@ascorbic)
discussion: null
created: 2026-11-24
---

# Auto-updating heading links in Portable Text

## Problem and user case

Authors writing long-form posts, documentation, or guides in EmDash often link to other sections on the same page. Today this breaks down in three places:

- **Rendered headings have no `id`.** `Block.astro` renders bare `<h1>` through `<h6>` elements with no `id` attribute. Sites that want section anchors must wrap `emdashComponents.block` themselves (as `emdashcms.com` does in `PostBlock.astro`), and per-block overrides cannot deduplicate identical headings on the same page.
- **The link picker cannot target headings.** `LinkDestinationInput` searches entries across routable collections, but treats `#` as a raw URL and disables search. Authors have to guess or compute the target slug by hand.
- **Manual `#slug` links break when a heading changes.** If an author renames a heading or adds a second heading with the same text, every hand-typed `#slug` link pointing at it silently becomes a dead anchor.

Agents editing content through MCP hit the same friction: they write standard Markdown fragment links like `[Upgrade notes](#upgrade-notes)`, which survive as plain strings and break as soon as a human renames the heading in the admin editor.

## Proposed behavior

Portable Text automatically assigns deduplicated GitHub-style `id` attributes to headings on render, lets authors pick headings from the existing link control, keeps internal heading links updated by referencing the heading block's `_key`, and binds matching Markdown fragment links on import.

### Heading IDs and deduplication

A shared pure helper in `packages/core` computes heading IDs for any Portable Text block array in document order:

- Applies to `h1` through `h6` blocks.
- Extracts plain text from the block's spans, trims it, lowercases it, strips characters outside `/[^\p{L}\p{M}\p{N}\s_-]/gu`, and replaces each space with `-`.
- Deduplicates against a `Set<string>` of all IDs already emitted in the document. On collision, appends `-1`, `-2`, and so on until unused. Tracking emitted IDs rather than only base counts avoids collisions when a document contains both `"Setup"`, `"Setup"`, and `"Setup 1"`.
- Leaves headings with empty slugified text without an `id`.

Because the helper runs at the document level and is shared by rendering, Markdown conversion, and the editor, all three produce the same IDs.

### Stored data and render-time resolution

Internal heading links stay on the standard `link` markDef and add an optional `anchorKey` pointing to the target heading's `_key`:

```json
{
	"_type": "link",
	"_key": "k1",
	"href": "#images-are-cached-for-a-year",
	"anchorKey": "h2_abc123"
}
```

- `anchorKey` is the source of truth for same-page heading links. It survives heading text edits, heading level changes, and reordering.
- `href` is kept updated on save as a readable fallback so custom `Link` overrides, RSS feeds, exports, and headless consumers continue to receive a valid `#slug` without running EmDash's resolver.
- Changing a link's destination to an external URL, page URL, or manual `#custom-id` clears `anchorKey`.

In `PortableText.astro`'s existing pre-pass (alongside `groupBlockquoteRuns` and `buildPortableTextListTree`):

1. Walk heading blocks, compute deduplicated IDs, attach `id` to each cloned heading node (preserving any explicit `id` already set), and build a `Map<blockKey, id>`.
2. Walk `markDefs` on all blocks (including table cells). For each `link` markDef with `anchorKey`, rewrite `href` to `#${id}` when `anchorKey` resolves in the map.

`Block.astro` forwards `id={attrs.id ?? node.id}` onto `<h1>` through `<h6>`. It does not inject an `<a>` permalink inside headings by default, so existing site typography, styling, and accessibility trees stay unchanged.

### Admin editor and inline editor authoring

- **Stable heading keys before save.** `PortableTextIdentityExtension` already preserves `emdashPortableTextKey` on saved heading nodes, but newly typed headings do not receive a `_key` until serialization, and splitting or duplicating a heading can copy its key. A small ProseMirror `appendTransaction` plugin ensures every heading node in the editor has a unique `emdashPortableTextKey` immediately, so authors can link to a heading they just wrote without saving first.
- **Link mark round-trip.** TipTap's `Link` mark carries a non-rendered `anchorKey` attribute. `portable-text-to-prosemirror.ts` loads `anchorKey` from the markDef, and `prosemirror-to-portable-text.ts` writes it back while refreshing `href` to the target heading's current `#slug`.
- **Heading picker in `LinkDestinationInput`.** Typing `#` switches the input into heading search instead of disabling search. Typing `#` alone lists all headings in document order; typing `#cache` filters by heading text. Picking a heading applies `{ href: "#" + slug, anchorKey }`.
- **Link bubble menu.** When the caret is on a link with `anchorKey`, `LinkBubbleMenu` resolves the heading live from the editor document:
  - When found, it shows the current heading text (for example, `# Images are cached for a year`) and clicking the destination scrolls to that heading in the editor instead of opening a new tab.
  - When missing (target heading deleted or emptied), it shows a broken-anchor state with **Edit** and **Remove** actions.
- **Markdown link typing/pasting.** `MarkdownLinkExtension` resolves `[text](#slug)` against the live editor document and attaches `anchorKey` when `#slug` matches a heading.
- **Inline editor.** Because heading lookup reads only the local TipTap document and requires no API call, `inline-bubble-menu.tsx` can support the same `#` heading picker.

### Markdown round-tripping

`packages/core/src/client/portable-text.ts` powers MCP and client Markdown conversion:

- **`portableTextToMarkdown`:** runs the shared heading-slug helper over the blocks first. When rendering a `link` markDef with a resolvable `anchorKey`, emits `[text](#${slug})` using the current deduplicated slug. Adds `"anchorKey"` to `LINK_FIELDS` so Markdown tables containing heading links continue to serialize as GFM tables rather than raw JSON blocks.
- **`markdownToPortableText`:** after converting tokens to Portable Text blocks, runs the shared heading-slug helper to build a `slug -> heading._key` map, then scans `markDefs` (including table cells). Any `link` whose `href` starts with `#` is decoded and matched against the map:
  - **Match:** attaches `anchorKey` to the `link` markDef. Standard Markdown such as `[Upgrade notes](#upgrade-notes)` becomes an auto-updating heading link with no custom syntax.
  - **No match** (such as `#top` or a custom HTML anchor): stays a plain `{ _type: "link", href }` with no `anchorKey`.

## Goals

- Emit deterministic, deduplicated GitHub-style `id` attributes on rendered Portable Text headings (`h1`–`h6`) by default.
- Let authors insert and navigate same-page heading links from the existing link control without typing slugs manually.
- Keep same-page heading links accurate when headings are renamed, reordered, or duplicated, with zero additional database queries on the logged-out read path.
- Round-trip heading links cleanly through `portableTextToMarkdown` and `markdownToPortableText` so MCP and CLI agents automatically create auto-updating heading links using standard Markdown fragments.

## Non-goals

- Cross-page reference links (auto-updating URLs when another entry's slug changes) or Notion/Confluence-style page chips. These are separate proposals, though `anchorKey` is shaped to compose with a future cross-page `reference` field.
- Injecting visible `#` permalink `<a>` icons inside headings by default.
- Automatically generating a table of contents component (though exporting the heading-slug helper makes server-side TOCs straightforward).
- Re-binding a `#old-slug` fragment when an agent renames a heading in a full-document Markdown replacement without also updating the fragment in that same edit.

## Interfaces and compatibility

- **Portable Text `link` markDef:** adds optional `anchorKey?: string`. Strictly additive; existing content and custom `Link` components continue to work unchanged because `href` is always populated.
- **`Block.astro`:** renders `id` on `<h1>`–`<h6>` by default when the heading produces a non-empty slug. Sites that pass an explicit `id` through a custom `block` wrapper (such as `emdashcms.com`'s `PostBlock.astro`) keep their explicit `id` because `attrs.id` takes precedence over `node.id`.
- **Public helper export:** export the heading-slug/extraction helper (name to be finalized during implementation, e.g. `extractPortableTextHeadings` or `resolvePortableTextHeadings`) from `emdash` / `emdash/ui` so templates can build matching TOCs without duplicating the slug algorithm.
- **Database and hot path:** no schema migrations and zero additional database queries. All resolution happens in memory during `PortableText.astro`'s existing block pre-pass.
- **Localization and RTL:** all new admin UI strings (such as the missing-heading warning and heading picker group label) go through Lingui; list layout uses logical Tailwind classes and is verified in Arabic.

## Errors and edge cases

- **Duplicate headings:** `"Setup"`, `"Setup"`, `"Setup 1"` produce `setup`, `setup-1`, `setup-1-1` (no duplicate `id` attributes in the rendered DOM).
- **Non-Latin scripts and punctuation:** Unicode letters and combining marks (`\p{L}\p{M}\p{N}`) are preserved; headings consisting only of punctuation or emoji produce no `id` and cannot be targeted by `#` links.
- **Splitting or duplicating a heading in TipTap:** the `appendTransaction` key guard assigns a new `emdashPortableTextKey` to the new/duplicated heading so two headings never share an `anchorKey`.
- **Deleting a targeted heading:** the link keeps its fallback `href`; the editor surfaces a "Heading not found" state in `LinkBubbleMenu` rather than crashing or silently linking elsewhere.
- **Manual `#` anchors:** `#top` or custom HTML element IDs that do not match a heading stay plain `href` links with `anchorKey` unset.
- **Percent-encoded fragments in Markdown:** `[Intro](#%E6%A6%82%E8%A6%81)` is decoded safely (falling back to the raw string on malformed `%` sequences) before matching heading slugs.
- **Tables and nested blocks:** `markDefs` inside table cells are included in both render-time resolution and Markdown import/export.

## Verification

- **Unit tests (core):**
  - Slug generation and deduplication (ASCII, Unicode, punctuation, empty headings, `"Foo"` + `"Foo"` + `"Foo 1"` collision).
  - Render-time resolution in `PortableText.astro` and `Block.astro`: heading `id`s emitted, `anchorKey` rewrites `href` after heading rename/reorder/duplication, explicit `attrs.id` respected, missing `anchorKey` handled cleanly.
  - ProseMirror round-trip (`portable-text-to-prosemirror` and `prosemirror-to-portable-text`): `anchorKey` preserved, `href` refreshed on serialize, `anchorKey` cleared when changed to a non-heading URL.
  - Markdown round-trip (`portableTextToMarkdown` and `markdownToPortableText`): fragment links bind to matching headings (including duplicates and table cells), unmatched fragments stay plain links, malformed percent-encoding does not throw.
- **Editor tests (admin):**
  - `LinkDestinationInput` `#` heading picker lists, filters, and selects headings.
  - Linking to a newly typed heading before saving assigns a unique `emdashPortableTextKey`.
  - Splitting/pasting a heading produces a distinct key.
  - `LinkBubbleMenu` shows live heading title, scrolls on click, and flags deleted targets.
  - `MarkdownLinkExtension` binds `[text](#slug)` on type and paste.
- **Manual verification:**
  - Verify heading picker and link bubble in both English (LTR) and Arabic (RTL).
  - Confirm `pnpm query-counts` shows no change on logged-out routes.

## Open questions

1. **Duplicate suffix numbering:** GitHub uses `-1`, `-2` (`setup`, `setup-1`, `setup-2`); some Markdown renderers use `-2`, `-3`. This plan proposes GitHub's `-1`, `-2` to match the rest of the GitHub-style slug rules — confirm this is preferred.
2. **Deleted target heading on public render:** when `anchorKey` no longer matches any heading in the document, should `PortableText.astro` fall back to the saved `href` (survives delete-and-retype with the same heading text) or strip the link and render plain text (avoids dead `#` clicks)?
3. **Link picker discoverability:** should headings appear only when the author types `#`, or also in a "Sections on this page" group during normal title search?
