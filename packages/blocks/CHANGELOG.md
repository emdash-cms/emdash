# @emdash-cms/blocks

## 0.10.0

### Minor Changes

- [#717](https://github.com/emdash-cms/emdash/pull/717) [`5eb4318`](https://github.com/emdash-cms/emdash/commit/5eb431876cbfb69a961735fbb6ab09c9de937f28) Thanks [@lsngmin](https://github.com/lsngmin)! - Add Tab block to Block Kit for tabbed panel layouts

## 0.9.0

### Minor Changes

- [#790](https://github.com/emdash-cms/emdash/pull/790) [`7b8d496`](https://github.com/emdash-cms/emdash/commit/7b8d4964c619821937d1a738cbd6f81e98095a91) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Adds an `accordion` Block Kit block: a collapsible container that wraps nested blocks under a labeled trigger. Open/closed state is local to the rendered component (with optional `default_open`), so plugin admin pages can hide advanced settings, FAQs, or auxiliary panels without paginating or round-tripping through `block_action`.

- [#731](https://github.com/emdash-cms/emdash/pull/731) [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea) Thanks [@drudge](https://github.com/drudge)! - Adds a `media_picker` Block Kit element: a thumbnail preview with a modal library picker and mime-type filter. Usable in plugin block forms and in Block Kit field widgets. The stored value is the selected asset's URL string, so it is value-compatible with a plain `text_input` — existing content continues to work after swapping. The `mime_type_filter` is restricted to image MIME types (`image/` or `image/<subtype>`); wildcards and non-image types are rejected.

- [#814](https://github.com/emdash-cms/emdash/pull/814) [`a838000`](https://github.com/emdash-cms/emdash/commit/a83800068678daf6391e02bba8acf27ff4db0e19) Thanks [@arashackdev](https://github.com/arashackdev)! - rtl srtyle improvements and LTR/RTL compatible arrow/caret icons

## 0.8.0

### Minor Changes

- [#792](https://github.com/emdash-cms/emdash/pull/792) [`6e0e921`](https://github.com/emdash-cms/emdash/commit/6e0e9215e00f6f2e84ade30447e4c30b1812dbf5) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Adds an `empty` Block Kit block: a styled empty-state placeholder with title, optional description, copyable shell command, size variant (`sm`/`base`/`lg`), and an optional list of action elements (CTAs). Plugin admin pages can now render proper empty states for lists, tables, and onboarding flows without rolling their own layout.

- [#679](https://github.com/emdash-cms/emdash/pull/679) [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d) Thanks [@drudge](https://github.com/drudge)! - Adds a `repeater` Block Kit element: array-of-objects with scalar sub-fields, drag-to-reorder, and collapsible item cards. Plugin block forms can now capture repeating data (FAQ rows, carousel slides, card grids) inline in the portable-text editor.

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

### Patch Changes

- [#246](https://github.com/emdash-cms/emdash/pull/246) [`e1349e3`](https://github.com/emdash-cms/emdash/commit/e1349e342f90227c50f253cc2c1fbda0bc288a39) Thanks [@estepanov](https://github.com/estepanov)! - Adds overflow-hidden and text-ellipsis to field value elements, with a title attribute for full-text tooltip on hover

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release
