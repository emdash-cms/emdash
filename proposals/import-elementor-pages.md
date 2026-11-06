---
title: Import pages built with Elementor
type: feature-plan
status: proposed
authors:
  - Dmytro (@dmythro)
discussion: null
created: 2026-11-06
---

# Import pages built with Elementor

## Problem and user case

Elementor keeps a page's content as JSON in the post meta `_elementor_data` and marks the page as its own with `_elementor_edit_mode` set to `builder`. The page's `post_content` holds only a copy that Elementor writes for search engines and for sites that turn the plugin off: the widgets' text as plain HTML, without their structure.

EmDash's WordPress importers convert `post_content` and nothing else. The WXR source, the WXR execute route, the CLI command and the WordPress plugin source all call `gutenbergToPortableText(post.content)`, so an Elementor page imports as that copy. Its galleries become links with no images, its videos and maps are missing, and its columns, tabs and box links are flattened or lost. After the import there is nothing left in EmDash to repair the page from.

This affects anyone moving a WordPress site built with Elementor to EmDash. In one production export used to test this plan, 74 entries were built with Elementor: pages, posts and entries of two custom post types. They hold 1,124 widgets of 20 types in 858 containers, among them 42 galleries, 18 videos and 9 sets of tabs.

## Proposed behavior

### Which posts are converted

A post is imported from its Elementor data when its `_elementor_edit_mode` meta is `builder` and its `_elementor_data` meta holds a JSON array of elements. Elementor adds both to any post type it edits, so pages, posts and custom post types are treated alike. Every other post imports from `post_content` as it does today.

### How the conversion works

A new package, `@emdash-cms/elementor-to-portable-text`, walks the element tree in document order and writes each widget as WordPress block markup, which `gutenbergToPortableText` then converts. Images, galleries, embeds, columns, lists, quotes and links therefore import exactly as they do from the block editor, media mapping included, and the importers keep a single conversion to Portable Text.

| Elementor widget                                       | Imported as                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Heading                                                | A heading, at least `h2`, since the page title is the `h1`                      |
| Text Editor                                            | Paragraphs, headings, lists, quotes, tables and images, each a block of its own |
| Image                                                  | An image, with its link when it has one                                         |
| Gallery, Basic Gallery, Image Carousel                 | A gallery                                                                       |
| Video                                                  | An embed for YouTube and Vimeo, a video block for a file                        |
| Google Maps                                            | A paragraph linking to the address on Google Maps                               |
| Button                                                 | A paragraph with the link                                                       |
| Icon List                                              | A list; an item with only an icon shows its link's address                      |
| Icon Box, Image Box                                    | The image, heading and text                                                     |
| Counter                                                | The final number, with thousands grouped as Elementor shows them, and the title |
| Tabs, Accordion, Toggle, Nested Tabs, Nested Accordion | Each section as a heading followed by its content                               |
| Testimonial, Testimonial Carousel                      | A quote with the person's name and title                                        |
| Slides                                                 | The heading and text of each slide                                              |
| Post Info                                              | Its dates as text; other items are reported                                     |
| Spacer, Divider, Menu Anchor                           | Nothing: they only lay out the page                                             |
| HTML                                                   | See the open questions                                                          |
| Posts, Loop Grid, Form, Nav Menu, Search, Share Buttons | Reported and not imported: the site's own templates provide them                |
| Any other widget, including add-ons                    | Reported with its widget type                                                   |

### Layout

Sections, columns and containers do not become blocks of their own: their content follows in document order. Two layouts keep their structure:

- A row whose children all have widths set in percent becomes one or more columns blocks. Children fill a row until it is full, as Elementor wraps them, so a grid of cards stays a grid.
- A box that holds only headings over a background image, such as a photo card with a label, becomes an image with the headings as its caption. The background images of a page's sections, and of boxes that hold text, are decoration and are dropped.

Elements hidden on desktop are usually the phone version of what desktop shows, so they are left out. When the text of such an element appears nowhere else on the page, the import reports it.

### Links and dynamic values

- A dynamic tag that names an entry or a file by its WordPress ID (`internal-url`) becomes that entry's or file's address from the export. `post-url` becomes the page's own address and `site-url` the home page. The importers then treat these like any other link to the old site.
- A dynamic tag that filled in text when the page was rendered, such as the post title or an ACF field, is reported. Its placeholder, such as "Add Your Heading Text Here", is never imported.
- A link on a whole box, from a container rendered as a link, goes onto the box's first heading and image.
- A link to a place on the same page (`#…`) is reported, because imported content has no element IDs for it to land on.

### Templates in the export

An export also holds Elementor's library: `elementor_library` posts. The converter reads two kinds of template from it:

- A button that opened a popup gives way to the popup's content, placed after it, once per page. Sites keep text only in popups, such as a job's full description.
- A global widget is replaced by the widget its template holds.

Nothing from the library becomes content of its own through this feature.

### Reporting

The import result lists, per entry, what was not carried over: the widget's type, its label or text, and the reason. The analysis step counts the entries built with Elementor, so the review screen can say how many will be converted from their Elementor data.

### Example

This row of two half-width containers:

```json
[
	{
		"elType": "container",
		"settings": { "flex_direction": "row" },
		"elements": [
			{
				"elType": "container",
				"settings": { "width": { "unit": "%", "size": 50 } },
				"elements": [
					{
						"elType": "widget",
						"widgetType": "heading",
						"settings": { "title": "Opening hours", "header_size": "h3" }
					},
					{
						"elType": "widget",
						"widgetType": "text-editor",
						"settings": { "editor": "<p>Wednesday to Sunday, 10:00–18:00</p>" }
					}
				]
			},
			{
				"elType": "container",
				"settings": { "width": { "unit": "%", "size": 50 } },
				"elements": [
					{
						"elType": "widget",
						"widgetType": "button",
						"settings": { "text": "Tickets", "link": { "url": "https://example.com/tickets" } }
					}
				]
			}
		]
	}
]
```

imports as a columns block with two columns: an `h3` heading and a paragraph in the first, a paragraph with a "Tickets" link in the second.

## Goals

- An entry built with Elementor imports as editable Portable Text with its text, headings, images, galleries, videos, links and column layout.
- Every importer that has the post's meta converts it the same way: the WXR import in the admin and in the CLI, and the WordPress plugin source.
- Whatever is not carried over exactly is reported for its entry.
- Entries not built with Elementor import exactly as before.

## Non-goals

- Styles: colors, typography, spacing, borders, animations, motion effects and custom CSS.
- Responsive settings. The import follows the desktop layout.
- Theme Builder templates (header, footer, single, archive, loop, search results, 404) and the Kit's global settings. They are the site's theme, not its content.
- Values rendered when a page is viewed: dynamic tags other than links, display conditions, forms, post lists and loops.
- Converting widgets from third-party add-ons, beyond reporting them by type.
- Elementor 4's atomic elements, whose types start with `e-`. Elementor turns them on by default only for sites first installed with version 4.0 or later, or after an opt-in, and no site available for testing this plan uses them. This plan reports them by type like any other unknown widget. Converting them is a separate follow-up once this import ships and a site that uses them can be tested.

## Interfaces and compatibility

- **New package:** `@emdash-cms/elementor-to-portable-text`, beside `@emdash-cms/contentful-to-portable-text`. `elementorToPortableText(elements, options)` returns `{ content, notes }`. Its options are the export's Elementor templates by ID, a lookup from WordPress post and attachment IDs to their old addresses, the page's own and home addresses, the page's dates, and the media map that `gutenbergToPortableText` already takes. It depends on `@emdash-cms/gutenberg-to-portable-text`.
- **Importers:** one helper chooses a post's content source. The WXR source, the WXR execute route, the CLI command and the WordPress plugin source call it where they call `gutenbergToPortableText(post.content)` today.
- **Import result:** `ImportResult` gains an optional list of notes per entry. The admin's result screen shows them under the counts, and the CLI prints them.
- **Import analysis:** `ImportAnalysis` gains an optional count of the entries built with Elementor.
- **Stored data, migrations, configuration and plugin surface:** none. Converted content is ordinary Portable Text.

Posts without Elementor data import exactly as before. An entry imported before this change is converted only when it is imported again.

## Errors and edge cases

- `_elementor_data` that is not valid JSON, or not an array, falls back to `post_content` with a note. So does a document that converts to nothing.
- `_elementor_data` without `_elementor_edit_mode` set to `builder` means the post was last edited in another editor. Its `post_content` is the content of record and is used.
- Elementor data is untrusted input, like `post_content`. Widget text goes through the same converter and URL sanitizing, and the walk is iterative or limited in depth, so a crafted, deeply nested document cannot exhaust the stack.
- Documents mix Elementor's older sections and columns with flexbox containers after an upgrade. Both are read.
- A popup opened by several buttons is inserted once. A popup or global widget missing from the export is reported.
- An image whose attachment is not in the export keeps its URL, as images from the block editor do today.
- The placeholder text of a dynamic setting is never imported.

## Verification

- Unit tests for each widget in the table; for the layout rules, rows of columns and photo boxes; for hidden phone copies, dynamic links, popups and global widgets; and for each fallback.
- An integration test that imports a WXR fixture with an Elementor page and its library templates through the execute route, and checks both the content and the notes.
- A manual import of a real Elementor export. A prototype of this conversion, run outside EmDash on the production export described above, imported the text of every Elementor entry, as a page-by-page comparison with the live site confirmed, together with its galleries, videos and links. The widgets it could not convert, mostly post lists, were reported.

## Open questions

- **HTML widget:** should it import as an HTML block, which EmDash renders through its sanitizer, or only be reported? Scripts in it do not run either way.
- **Google Maps:** a link, as proposed, or an embed, if EmDash gains a map block?
- **WordPress plugin source:** does the WordPress plugin send `_elementor_data`, `_elementor_edit_mode` and the library templates? If it leaves out protected meta, whose keys start with `_`, the plugin needs a change.
- **Review screen:** is the list on the result screen enough, or should the review screen also list the widget types that will not convert before the import starts?
