---
title: Dark mode variant for Portable Text images
type: feature-plan
status: proposed
authors:
  - vance (@mvvmm)
discussion: https://github.com/emdash-cms/emdash/discussions/1877
created: 2026-11-23
---

# Dark mode variant for Portable Text images

## Problem and user case

- Image fields support a dark variant (`options: { darkVariant: true }`, #2609). Images inserted into rich text with the editor's image button do not.
- Those images are Portable Text `image` nodes, not image fields, so they have no dark slot in the editor, the stored shape, or the renderer.
- They are mostly diagrams, charts, and screenshots in articles and case studies: the images that most need a dark version.
- Discussion #1877. #4891 covers images in plugin blocks; this covers the core rich-text image.

## Proposed behavior

New widget option on `portableText` fields, matching image fields:

```json
{ "slug": "body", "label": "Body", "type": "portableText", "options": { "darkVariant": true } }
```

Stored value: an optional `darkVariant` on the image node. It mirrors the node's own asset and media fields:

```json
{
	"_type": "image",
	"_key": "a1",
	"asset": { "_ref": "01LIGHT", "url": "/_emdash/api/media/file/light.png" },
	"alt": "Request flow",
	"width": 1600,
	"height": 900,
	"darkVariant": {
		"asset": { "_ref": "01DARK", "url": "/_emdash/api/media/file/dark.png" },
		"width": 1600,
		"height": 900,
		"dominantColor": "#0d0d0d"
	}
}
```

Editor:

- With the option on, the image settings panel shows "Add dark mode variant" below the preview.
- The variant card has Replace and Remove. Picking or removing a variant applies at once, like Replace on the primary.
- Replacing the primary keeps the variant. Removing the image removes it with the variant.
- Alt text, caption, tooltip, link, alignment, and display size belong to the node and apply to both images. The variant has no alt of its own.
- With the option off, no slot is shown. A variant already stored stays in the value and still renders.

Site rendering, no template change:

```astro
<PortableText value={post.data.body} />
```

The built-in image component renders both images inside the same `<figure>`, with the classes and CSS that `Image` uses for image fields: `emdash-image--light` on the primary and `emdash-image--dark` on the variant. Each image gets its own source, srcset, and LQIP placeholder. Display width applies to both; height follows each image's own aspect ratio unless both display dimensions are set.

Seeds can set the variant with `$media`, in the same position as the primary asset:

```json
{ "darkVariant": { "asset": { "$media": { "file": "diagram-dark.png", "alt": "" } } } }
```

## Goals

- Same editor experience and stored-variant semantics as image-field dark variants.
- Existing image nodes, renderers, and editors keep working unchanged.
- Media usage and deletion checks see the variant.

## Non-goals

- A dark version on media library items.
- Making the dark slot required.
- Images inside gallery blocks.
- Rich text editors with no field behind them (widgets, sections). They keep any stored variant but offer no slot.
- A slot in the site-side inline editor. It keeps a stored variant on save.
- Markdown export. `![alt](url)` already drops caption, link, and alignment; the variant is dropped the same way.
- Block Kit `media_picker` (#4891).

## Interfaces and compatibility

- `portableText` field: new widget option `darkVariant` (default `false`). Schema editor gets the same "Dark mode variant" switch image fields have.
- `portableText` fields in native block types accept the same `options: { darkVariant: true }` in their block-type version. Turning it on is a compatible change to the version contract; turning it off is breaking, as for block `image` fields. Block types have no field editor in the admin, so the option is set in the seed or through the block-type API.
- Rich text inside a block gets the image settings panel that rich text fields already have, so the dark slot is reachable there.
- `PortableTextImageBlock`: new optional `darkVariant`. New exported type `PortableTextImageDarkVariant`.
- Both Portable Text ⇄ ProseMirror converters (core and admin) carry the variant in both directions. The editor node gets a `darkVariant` attribute, default `null`.
- Media usage records the variant at `<node path>.darkVariant.asset._ref` (or `.url` for a local file named only by URL), following the image-field `.darkVariant` convention and the custom-block usage work in #4240.
- Additive. No migration. A node without `darkVariant` round-trips byte-for-byte as before.

## Design decisions

- **Stored shape.** The variant mirrors the node: `{ asset: { _ref, url?, provider? }, width?, height?, blurhash?, dominantColor? }`. An image-field `MediaValue` (`{ id, src, ... }`) would mix two media shapes in one node, and every reader of the node already knows the `asset` shape. `asset.meta` is not kept, as for the primary.
- **Opt-in per field.** Matches image fields and keeps the editor unchanged for sites that do not want it. The editor already receives the field definition, so gating costs one prop.
- **Shared fields.** One alt, caption, link, alignment, and display size. Two alts for one picture would drift, and the image fields' variant has no alt either.
- **Render path.** The PT image component keeps its own resolution (provider embed, display size, Astro optimization) and resolves the variant through the same path. Routing it through `Image` would change how existing nodes render.
- **Immediate apply.** The variant applies when picked, like Replace and Edit asset. Only text and layout settings wait for Apply.

## Errors and edge cases

- A `darkVariant` without an asset reference or URL is dropped on conversion.
- A variant on an image without a primary is never offered. The slot appears only on a placed image.
- No new queries on the logged-out path. Rendering a variant adds one media URL resolution, the same as a second image.
- Hidden variants are lazy, so a visitor downloads only the image for their scheme.

## Verification

- Unit: both converters round-trip the variant; nodes without it are unchanged; an asset-less variant is dropped; seeded `$media` variants are normalized.
- Unit: media usage extracts `.darkVariant`; file-URL linking covers the variant.
- Render: two `<img>`s with `emdash-image--light` / `--dark`, shared alt, own placeholder; one `<img>` without a variant.
- Component: no slot with the option off; add, replace, remove variant; replacing the primary keeps it.
- E2E: an image with a variant renders and switches with the color scheme; the panel adds a variant.
- Manual: image settings in LTR and Arabic.

## Open questions

- Feature plan or RFC? This adds a field option and an optional key to stored Portable Text.
