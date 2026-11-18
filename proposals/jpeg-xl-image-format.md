---
title: Add JPEG XL to image formats
type: feature-plan
status: proposed
authors:
  - Jack Skipworth (@jackskip22)
discussion: null
created: 2026-11-18
---

# Add JPEG XL to image formats

## Problem and user case

`<Image formats={["avif", "webp"]}>` lets a site offer a newer format with a fallback ([#3302](https://github.com/emdash-cms/emdash/issues/3302)). JPEG XL can't be offered this way. Safari 17 and later and current Chrome show it, and the media library accepts `.jxl` uploads since [#3580](https://github.com/emdash-cms/emdash/pull/3580), but `formats` only takes `webp`, `avif`, `jpeg` and `png`.

Passing `jxl` anyway breaks the image in exactly the browsers that ask for it. They pick the `<source type="image/jxl">` and request `/_image?...&f=jxl`. Neither image service can write JPEG XL. The Cloudflare Images binding has no JPEG XL output, and the sharp build Astro installs reports none. On Node, sharp fails, Astro's fallback calls a logger the endpoint doesn't pass, and the endpoint answers `500`. On Cloudflare, `f=jxl` fails validation and the endpoint answers with the whole original file.

Plugins can store JPEG XL copies, but today they can only answer the WebP URL by negotiating on `Accept`. That works with the route cache, because Workers Cache honors `Vary`. Each distinct `Accept` string then becomes its own entry, though, and any cache that ignores `Vary` can hand JPEG XL to a browser that can't show it. An `f=jxl` URL needs neither, the same way AVIF already has its own URL.

## Proposed behavior

- `jxl` is a valid entry in `formats` and a valid `f` value. `formats={["jxl", "webp"]}` renders a `<source type="image/jxl">` in front of the WebP `<img>`, through the existing `<picture>` path. Browsers without JPEG XL skip the source and never request it.
- JPEG XL is only ever a `<source>`. When `jxl` would be the `<img>`, as in `formats={["jxl"]}`, the `<img>` uses the default format. EmDash therefore writes an `f=jxl` URL only where the browser chose JPEG XL itself.
- The image endpoints answer `f=jxl` in the default format, WebP, at the requested size, with `Content-Type: image/webp`. Browsers show an image by its bytes, so the source never breaks. The ETag already includes `f`, so this answer has its own validators.
- Middleware or a plugin with a JPEG XL copy answers the `f=jxl` URL before the endpoint, as plugins already answer `/_image`. The URL names the format, so the answer needs no `Accept` check and no `Vary`.

A prototype ran on the `simple` demo on Node, with a 1600 × 1200 JPEG rendered by `formats={["jxl", "webp"]}`. Playwright's Chromium 153 decoded JPEG XL with no flag, and `--disable-features=JXLImageFormat` gave the same browser without it. The middleware answered `f=jxl` from a stored JPEG XL copy.

| Browser         | EmDash today                    | Prototype                    | Prototype with middleware                 |
| --------------- | ------------------------------- | ---------------------------- | ----------------------------------------- |
| With JPEG XL    | requests `f=jxl`, `500`, broken | requests `f=jxl`, gets WebP  | requests `f=jxl`, gets JPEG XL, no `Vary` |
| Without JPEG XL | requests `f=webp`, gets WebP    | requests `f=webp`, gets WebP | requests `f=webp`, gets WebP              |

Every image decoded at 1600 pixels except the one marked broken. On the prototype, `formats={["jxl"]}` rendered the same `<picture>` and gave the same results. The prototype is on [`proto/jxl-image-format`](https://github.com/jackskip22/emdash/compare/main...proto/jxl-image-format).

## Goals

- A site can offer JPEG XL with one entry in `formats`.
- No browser gets a broken image, with or without a JPEG XL source behind the URL.
- JPEG XL has its own URL, so every cache keeps one entry for it.
- A plugin can supply JPEG XL without a new hook or a template change.

## Non-goals

- Encoding JPEG XL in EmDash. When an image service can write it, the endpoint can write it at the same URL with no change to markup.
- A site-wide default for `formats`, or `formats` for Portable Text images and galleries. These would serve AVIF the same way and belong in their own plan.
- A plugin hook for image formats. Middleware already runs before the endpoint.
- Serving uploaded `.jxl` originals inline.
- Changing `Accept` negotiation. Plugins that negotiate keep working.

## Interfaces and compatibility

- `ImageTransformFormat` gains `"jxl"`, so `formats` accepts it. `fallbackFormat` keeps the four formats the services write, as the new type `WrittenTransformFormat`.
- `emdash/media/image-endpoint` exports `writtenFormat()`, which maps `jxl` to the default format. The Node and Cloudflare endpoints both call it. `resolveTransformQuality` takes a written format. Existing callers compile unchanged.
- `f=jxl` answered `500` on Node and the original on Cloudflare. It now answers WebP at the requested size. No other URL changes.
- No configuration, stored data or default changes. It ships as a minor release with a changeset for `emdash` and `@emdash-cms/cloudflare`.
- [Cache media files in the route cache](media-route-cache.md) stores every successful variant. A WebP answer to `f=jxl` isn't stored, so a JPEG XL copy written later isn't hidden behind it for a year. This pull request amends that plan.

## Errors and edge cases

- **No JPEG XL copy.** The endpoint answers WebP. A plugin that converts uploads in the background answers once its copy exists. The browser revalidates on every view and gets the new representation, because its validators differ.
- **`jxl` last or alone in `formats`.** The `<img>` uses the default format and `jxl` stays a `<source>`.
- **A hand-written `<img>` with `f=jxl`.** EmDash answers WebP, which every browser shows. A plugin's JPEG XL answer would then reach browsers that can't show it. EmDash's components never write one.
- **External media providers** keep their own URLs, as for `formats` today.
- **`HEAD`, `304` and failed transforms** behave as for every other format.

## Verification

- Unit tests that `f=jxl` parses, that `writtenFormat` maps only `jxl`, and that both endpoints answer `f=jxl` with WebP bytes, the WebP content type and `f=jxl` in the ETag.
- Render tests on both `<picture>` paths: `["jxl", "webp"]` renders a JPEG XL source and a WebP `<img>`, and `["jxl"]` and `["avif", "jxl"]` keep `jxl` a source.
- Once the route cache ships, a test that a WebP answer to `f=jxl` doesn't call `cache.set`.
- A manual check in a browser with JPEG XL and one without, with and without middleware answering `f=jxl`, on Node and on Cloudflare.
