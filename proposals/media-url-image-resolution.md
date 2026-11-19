---
title: Render media library URLs as full media in Image
type: feature-plan
status: proposed
authors:
  - vance (@mvvmm)
discussion: null
created: 2026-11-19
---

# Render media library URLs as full media in Image

## Problem and user case

- A Block Kit `media_picker` stores the picked asset's URL string, for example `/_emdash/api/media/file/01ABC.png`. The [dark variant design](https://github.com/emdash-cms/emdash/pull/4891) stores its variant the same way, under `<action_id>_dark`.
- Sites render these values with `<Image image={node.logo} darkVariant={node.logo_dark} />`.
- `<Image>` turns a string into `{ id: "", src }`. Without `width` and `height`:
  - Astro builds no transform, so the full-size original ships. A 2400 px PNG goes to a 600 px box.
  - No `srcset`, no constrained layout, no reserved aspect ratio. The image shifts layout when it loads.
  - No blurhash or dominant color placeholder.
- The media library already holds all of this for the file: dimensions, MIME type, blurhash, dominant color, focal point.
- Image fields don't have this problem: their value is a full media object, light and dark.
- Plugin authors can't fix it in a site. There is no public lookup by storage key, and a media item's `id` and `storageKey` are separate ULIDs.

## Proposed behavior

When `<Image>` receives a string `image` or `darkVariant` that is an EmDash media library URL, it reads that item's record and renders it as a full media value.

- A string matches when `matchInternalMediaKey()` returns a storage key: `/_emdash/api/media/file/<key>`, relative or same-origin absolute.
- `<Image>` fills `width`, `height`, `mimeType`, `blurhash`, `dominantColor`, `focalX`, and `focalY` from the `ready` media item with that storage key.
- The result renders as if the caller had passed the media object: transform `srcset`, constrained layout, placeholder, focal point.
- Caller props still win: `alt`, `width`, `height`, `sizes`, `priority`, `placeholder`.
- `alt` is not filled from the library. A picked URL carries no per-use alt text, and the library's alt describes the file, not its use on the page.
- Lookups are request-scoped and batched. Every string image on a page that is rendered in one render pass costs at most one query. Repeated keys are read once.

Example: a block renders `<Image image={node.logo} darkVariant={node.logo_dark} />` with two picked PNGs.

| | Today | With this plan |
| --- | --- | --- |
| Light `<img>` | `src` = original PNG, no size | `/_image` webp `srcset`, size, blurhash |
| Dark `<img>` | Same as light | Its own `srcset`, size, blurhash |
| Queries | 0 | 1 |

## Goals

- `media_picker` images, including dark variants, render like image field media: transformed, sized, with placeholders.
- No change to stored data, Block Kit, or the `<Image>` call sites.
- Bounded cost: one batched, indexed query per render pass that has string media.

## Non-goals

- Changing what `media_picker` stores. A media object value would break every consumer that reads a string.
- Resolving external URLs or other providers' URLs.
- Portable Text `image` nodes and `Gallery`. They already reference a media item.
- Filling `alt` from the media library.
- Media usage tracking for picked URLs. Depends on #4240.

## Interfaces and compatibility

- `<Image>`: string media library URLs render as full media. Additive; other strings render as today.
- Rendered HTML changes for string media URLs: `srcset`, `width`/`height`, placeholder style. Sites that styled the untransformed `<img>` may see layout differences, as they would after switching to an image field.
- `MediaRepository`: a batched record lookup by storage key beside `findIdsByStorageKeys`. Uses the existing `idx_media_storage_key` index.
- Optional public helper, for site code that normalizes picked values itself: `resolveMediaUrls(urls)` returns media values keyed by URL. See open questions.
- Route cache: when a page renders resolved media, it adds the item's `emdash:media:<storageKey>` tag to its cache hint. A replace that changes dimensions or blurhash then purges the page with the file. The tag already exists for the media route cache.
- No migration. No config.

## Errors and edge cases

- Unknown key, `pending` or `failed` item, or non-image MIME type: render the string as today.
- A lookup error logs once per render pass and renders the strings as today. A database error never fails the page.
- An item without dimensions (some SVGs): fill the other fields and render untransformed, as an image field does.
- SVG and GIF keep today's untransformed rendering by MIME type, as image field media does.
- An unsafe storage key from `matchInternalMediaKey()` is never looked up.
- A string that matches but sits on another origin (not `publicUrl` or the request origin) renders as today.

## Verification

- Unit: URL matching (relative, same-origin absolute, foreign origin, unsafe key); batched lookup returns `ready` items only; repeated keys read once.
- Render: a string `image` and a string `darkVariant` each render their own `srcset`, `width`/`height`, and blurhash; caller `width`, `height`, `sizes`, and `placeholder={false}` win; unknown and non-image keys render as today; one query for several string images.
- Cache: a page that renders resolved media carries its `emdash:media:<storageKey>` tag.
- E2E: the dark-variant plugin fixture renders transformed light and dark images.

## Open questions

- Feature plan or RFC? `<Image>` output changes for existing string values, and the render path gains a database read.
- Batching scope: one query per component render, or a request-wide loader that collects keys across components? A request-wide loader saves queries but needs a render-pass boundary.
- Ship `resolveMediaUrls()` publicly, or keep the lookup internal to `<Image>`?
- Should `Gallery` and Portable Text helpers use the same resolver for string `src` values?
