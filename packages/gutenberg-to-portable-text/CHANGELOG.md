# @emdash-cms/gutenberg-to-portable-text

## 1.2.0

### Patch Changes

- [#3762](https://github.com/emdash-cms/emdash/pull/3762) [`f09797c`](https://github.com/emdash-cms/emdash/commit/f09797c847778e29a697f83ae76f9e7f253cbdcf) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes WordPress imports turning tables in Classic editor posts into a single paragraph. Tables whose cells hold only text now import as tables, keeping their rows, header row, formatting and links. Tables with images, headings, lists or merged cells, with a caption or footer rows, or inside a `<div>` or `<figure>` keep their previous output.
  
  `gutenbergToPortableText()` also sets `hasHeaderRow: true` on tables whose first row holds only `<th>` cells.

- [#3837](https://github.com/emdash-cms/emdash/pull/3837) [`bfd05b0`](https://github.com/emdash-cms/emdash/commit/bfd05b08043017ee45a76fa7bb3fd72969fb3767) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes WordPress imports failing with "Maximum call stack size exceeded" when a post contains thousands of nested inline tags, such as unclosed `<b>` or `<span>` tags. Preformatted, verse, pullquote, and button blocks, and image and gallery captions, no longer fail on this markup either.
  
  Formatting that is nested inside the same formatting, such as `<strong><b>bold</b></strong>`, now gives the span a single `strong` mark instead of repeating it. Text inside a link nested in another link, which HTML only allows inside elements such as `<svg>` or `<object>`, now carries only the innermost link.

- [#3893](https://github.com/emdash-cms/emdash/pull/3893) [`d1065a1`](https://github.com/emdash-cms/emdash/commit/d1065a157eb1009f649c06e6c6b49130f60bbf27) Thanks [@swissky](https://github.com/swissky)! - Fixes buttons imported from WordPress losing their link. WordPress stores the button link in the block markup, which the converter ignored. Buttons inside a button group now also drop unsafe links such as `javascript:` URLs, matching single buttons, and a button in a group without a usable link now gets an empty `url` instead of none.

- [#3792](https://github.com/emdash-cms/emdash/pull/3792) [`2881234`](https://github.com/emdash-cms/emdash/commit/2881234fad52162ea730bba3cd57919526dc5d3e) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes WordPress imports stalling on `core/table` blocks that contain many unclosed tags, such as thousands of `<tr>` or `<td>` tags without a closing tag. Conversion time for this markup grew with the square of its length and now grows linearly. Converted tables are unchanged.

## 1.1.0

No changes in this release.

## 1.0.1

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. Before upgrading from 0.42, read the [upgrade guide](https://docs.emdashcms.com/upgrade-to-v1/), which lists each change and how to migrate.
  
  From this release, breaking changes ship only in a new major version.

## 1.0.1-rc.1

No changes in this release.

## 1.0.1-rc.0

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. The other entries for this version describe each one and how to migrate; check them before upgrading from 0.42.
  
  From this release, breaking changes ship only in a new major version.
  
  The first 1.x version is 1.0.1. npm also lists a deprecated `emdash@1.0.0`, published by mistake from 0.7-era code; do not install it.

## 0.42.0

No changes in this release.

## 0.41.0

No changes in this release.

## 0.40.1

No changes in this release.

## 0.40.0

### Patch Changes

- [#3167](https://github.com/emdash-cms/emdash/pull/3167) [`ed51c68`](https://github.com/emdash-cms/emdash/commit/ed51c685bec26ba745624a7c54e9cf96e5e0c927) Thanks [@kwmr](https://github.com/kwmr)! - Adds optional `link` on portable-text image blocks: editor link buttons work on image selection, and `Image.astro` wraps images in a sanitized `<a>` when `link.href` is set. Legacy `link: "https://…"` strings written by WordPress/Gutenberg imports are normalised on read, so already-imported linked images keep their link and are upgraded to the object shape on their next edit.

## 0.39.1

No changes in this release.

## 0.39.0

No changes in this release.

## 0.38.0

No changes in this release.

## 0.37.0

## 0.36.0

## 0.35.0

## 0.34.0

## 0.33.0

## 0.32.0

## 0.31.1

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.1

## 0.25.0

## 0.24.1

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.1

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release
