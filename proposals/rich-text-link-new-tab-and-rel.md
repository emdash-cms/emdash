---
title: New tab and rel for rich text links
type: feature-plan
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
discussion: https://github.com/emdash-cms/emdash/discussions/4745
created: 2026-11-11
---

# New tab and rel for rich text links

## Problem and user case

The link field in the rich text editor takes only a URL. An author can't make a link open in a new tab, and can't mark a link as `sponsored`, `nofollow` or `ugc`. Image links already have an **Open in new tab** checkbox in the image details panel. Text links don't.

Google asks sites to mark paid links, such as ads, with `rel="sponsored"` or `rel="nofollow"`, and links added by visitors, such as in comments, with `rel="ugc"` ([Qualify your outbound links to Google](https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links)). That choice belongs to the individual link, so a site-wide rule in the theme can't make it.

The stored data and the renderer already go part of the way. A link's entry in `markDefs` can hold `blank: true`, and the built-in `Link` mark component then renders `target="_blank"` and `rel="noopener noreferrer"`. The WordPress importer writes `blank: true` for links that opened in a new tab. Links added in the editor can't get it, so imported and new posts behave differently. In [Discussion #4745](https://github.com/emdash-cms/emdash/discussions/4745), one migrated blog has 672 of 780 text links with `blank: true` after the import. There's no field for `rel` at all.

The author of #4745 works around this with a native plugin. It lists a saved entry's links with checkboxes, patches the draft so each link's entry holds `rel: ["nofollow", "sponsored"]`, and the site replaces the `link` mark component to render it. The plugin can't extend the link field, works only on saved entries, skips table cells, and loses its patch when the content changes first. [Discussion #2769](https://github.com/emdash-cms/emdash/discussions/2769) asks for the same per-link choice and for `ugc`, and asks that the attributes survive the editor, the CLI and MCP.

## Proposed behavior

The link field gets a **Link settings** button next to the button that applies the link. It shows these options under the URL:

- **Open in new tab**, the same label as on image links.
- **Sponsored** (`sponsored`): a paid, affiliate or sponsored link.
- **No follow** (`nofollow`): don't pass ranking credit to the linked page.
- **User-generated** (`ugc`): a link someone else added, such as in a comment.

Each option is a checkbox with a one-line description. The options open already expanded when the link has any of them set. They apply together with the URL, whether the author clicks the apply button, presses Enter or picks an entry from the search results, so a link can be changed in one step. Removing the link removes its options. Changing the URL keeps them.

This applies to both places where the admin edits a text link (the floating toolbar on a selection and the editor toolbar's link button) and to the link bar of the visual editor, which matches the admin's toolbar since [#4117](https://github.com/emdash-cms/emdash/pull/4117).

A same-page link, such as `#pricing`, always opens in the same tab today. For such a URL the **Open in new tab** checkbox is disabled, with a short note saying why.

The built-in `Link` mark renders the stored options. A link stored as

```json
{
	"_type": "link",
	"_key": "a1",
	"href": "https://shop.example.com/kit",
	"blank": true,
	"rel": ["nofollow", "sponsored"]
}
```

renders as

```html
<a href="https://shop.example.com/kit" target="_blank" rel="noopener noreferrer nofollow sponsored">
```

`noopener noreferrer` comes first whenever the link opens in a new tab, as today. The chosen values follow in a fixed order, `nofollow`, `sponsored`, `ugc`, each once. A link without `blank` renders only the chosen values, and a link without options renders exactly as today.

## Goals

- Let authors choose a new tab and `sponsored`, `nofollow` and `ugc` for each text link, in the admin editor and the visual editor.
- Render the choices with the built-in `Link` mark.
- Keep the choices through every edit and save in both editors, through REST, CLI and MCP writes, through the Markdown that CLI and MCP read and write, and through site export and import.
- Keep `nofollow`, `sponsored` and `ugc` when the WordPress importer converts a link.
- Read links that the #4745 workaround already stored, unchanged.

## Non-goals

- Site-wide rules, such as opening every external link in a new tab or adding `nofollow` to every external link. A theme or plugin can still do that in its own `link` mark component.
- Other `rel` values (`me`, `external`, `author` and so on) or a free-text `rel` field. Adding a value later is an additive change.
- `rel` on image links, buttons, menus and Block Kit links.
- The page-level robots `nofollow`. Design PR [#4765](https://github.com/emdash-cms/emdash/pull/4765) covers it.
- Markdown syntax for the options. A Markdown link (`[text](url)`) creates a link without options.
- Changing content that's already stored. There's no migration.
- Letting plugins add fields to the link field.

## Interfaces and compatibility

- **Stored data.** A link's `markDefs` entry gains an optional `rel`, an array of strings. The editors write only `nofollow`, `sponsored` and `ugc`, lowercase, each once, in that order. They leave the key out when no value is chosen and the link had no `rel` before. It's the same shape the #4745 workaround stores, so its links open in the link field with their options checked and render without the site's own component. `blank` keeps its meaning.
- **Types.** `PortableTextLinkMark`, exported from `emdash`, gains `rel?: string[]`. That's an additive change to an exported type.
- **Rendering.** `marks/Link.astro` renders `rel` as described above. A site that replaces the `link` mark component receives `rel` on the mark definition and decides itself whether to render it. The docs gain a description of the link fields `href`, `blank`, `title` and `rel` for such components.
- **Editors.** The editors' link mark gets the `rel` values as a list that starts empty. TipTap's Link extension defaults `rel` to `noopener noreferrer nofollow`, so without that override every new link would be saved with `nofollow`, the way every link was saved with `blank: true` in [#4105](https://github.com/emdash-cms/emdash/issues/4105). The three pairs of converters between Portable Text and the editor document (in core, in the admin editor and in the visual editor) map `rel` the way they map `blank`. On save the value comes from the link mark, so a change in the link field wins over the stored entry. Links with the same URL but different options keep separate `markDefs` entries. The visual editor's converter currently reuses one entry per URL, so it changes too.
- **Paste.** A pasted link keeps `nofollow`, `sponsored` and `ugc` from its `rel` and drops other values.
- **REST, CLI and MCP.** Writes already accept any extra fields inside a rich text value, so `rel` in Portable Text JSON passes through unchanged.
- **Markdown.** CLI and MCP can read rich text as Markdown and write it back. Today a link in a paragraph becomes `[text](url)`, so a write back drops its `blank` and `title`, and would drop `rel`. A table whose links carry such fields is already written as an opaque `<!--ec:block {…} -->` line, which comes back unchanged. Paragraphs, headings and list items get the same rule: a block whose links carry fields beyond `href` is written as an opaque line. Links with only `href` stay plain Markdown. This also stops the loss of `blank` and `title`, so it can land first as a bug fix.
- **WordPress import.** `@emdash-cms/gutenberg-to-portable-text` reads `rel` on each `<a>` it converts, keeps `nofollow`, `sponsored` and `ugc` regardless of case, and drops the rest. `noopener` and `noreferrer` are dropped because the renderer adds them for links that open in a new tab. Links with the same URL but different values keep separate entries. Design PR [#4670](https://github.com/emdash-cms/emdash/pull/4670) moves the importer into its own package but keeps this converter, so the two plans don't conflict. Content imported before this change has no `rel`.
- **Other designs.** [#4636](https://github.com/emdash-cms/emdash/pull/4636) keeps unknown marks in the editors and leaves links unchanged. Both plans change the same converters, so whichever is implemented second adapts to the other. [Real-time co-editing](real-time-co-editing.md) moves the admin editor's converter into a shared export that co-editing also uses to save entries, so co-edited entries keep `rel` through the same change.
- **Compatibility.** No migration, and no new route, function or option. Links without `rel` behave as before. An older EmDash version renders content with `rel` as if the field weren't there.

## Errors and edge cases

- **Invalid stored values.** If `rel` isn't an array, or holds values other than the three, the renderer ignores what it doesn't know. The link field shows only the known values. A save keeps unknown values unless the author changes that link's options, which writes the known values the author chose.
- **Case.** Stored values are compared regardless of case, as in HTML. The editors write lowercase.
- **Same-page links.** A `#` link never opens in a new tab, as today. Its `rel` values still render.
- **Unsafe URLs.** `sanitizeHref` keeps deciding what the `href` becomes. `rel` doesn't change that.
- **Tables.** Links inside table cells get the same options.
- **Markdown output.** A paragraph with a new-tab or `rel` link reads as JSON in Markdown output. That's less pleasant for an agent to edit than `[text](url)`, but it no longer loses data on a write back.
- **Accessibility and languages.** The options are checkboxes with visible labels, reachable by keyboard from the URL field. In the admin they're Kumo checkboxes, every label and description goes through Lingui, the value names (`nofollow` and the others) stay untranslated, and the layout uses logical classes and is checked in Arabic. The visual editor's labels stay English, like its other labels today.

## Verification

- Renderer tests for `Link.astro`: every combination of `blank` and the three values, the fixed order, `noopener noreferrer` with `blank`, a same-page link, unknown, duplicate and uppercase values, a non-array `rel`, and a link without options rendering as today.
- Converter tests run through one fixture against the core, admin and visual editor converters: `rel` survives a round trip; a new link gets no `rel`; changing the options on an existing link saves the new values; two links to one URL with different options stay separate; unknown values survive an edit elsewhere in the block.
- Admin component tests for the link field: the options open expanded for a link that has them; **Apply link** saves URL and options together; the checkbox is disabled for a `#` URL; removing a link removes its options.
- A browser test in the admin and in the visual editor: set the options, save, reload, and check the rendered HTML on the site.
- Importer tests: `rel="nofollow sponsored noopener"` keeps `nofollow` and `sponsored`; values differing only in case; two links to one URL with different values.
- Markdown converter tests: a paragraph, a heading and a list item with a `blank`, `title` or `rel` link survive reading as Markdown and writing back; a link with only `href` stays `[text](url)`.
- Manual checks in English and Arabic, with before-and-after screenshots of both link fields and the visual editor's link bar in the implementation PR.
