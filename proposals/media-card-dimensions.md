---
title: Image dimensions on media cards
type: feature-plan
status: proposed
authors:
  - Zach Bimson (@bimsonz)
discussion: null
created: 2026-11-21
---

# Image dimensions on media cards

## Problem and user case

Media cards in the Media Library and the media picker show an item's filename and format, and the picker's list rows add its file size. None of them shows an image's dimensions, its width and height in pixels, which is what decides whether the image suits the place it's going, such as a full-width hero, a gallery or a thumbnail. The details panel shows them under **Dimensions**, but an editor has to open each image to see them.

On one site we maintain, a gallery turned out to be built entirely from 200 × 200 thumbnails. The old site's thumbnails had been imported next to the originals under similar names, and in the picker's grid nothing told them apart.

## Proposed behavior

Every media card and list row whose item has a width and height shows its dimensions.

- **Grid cards**, in the Media Library and the picker, give the filename the card's full width on the first line. The second line shows the dimensions at the start and the format badge at the end. An item without dimensions, such as a PDF, shows only the badge there, so every card has the same height. A format badge too long for the line, such as `X-MATROSKA` on a narrow card, shortens with an ellipsis; the dimensions never do.

  ```text
  ┌───────────────────────────┐
  │                           │
  │         thumbnail         │
  │                           │
  ├───────────────────────────┤
  │ harbour-sunrise-thumb.jpg │
  │ 200 × 200            JPEG │
  └───────────────────────────┘
  ```

  Adding the dimensions to today's single line instead would cut a filename to about ten characters on a four-column grid.

- **List rows in the picker** add the dimensions after the file size: `image/jpeg · 320.1 KB · 4032 × 3024`.
- **The Media Library's list view** gets a **Dimensions** column after **Size**. An item without dimensions shows "—", and a folder row shows "—" with a screen-reader note, as it does for type, size and alt text. When the table is narrower than 42rem, the type and size move under the filename and the dimensions follow them.
- **Screen readers** hear a card's second line as its description, so a grid card is announced as its filename, then "4032 × 3024 JPEG". A list row's description is its details line. The accessible name stays the filename.

A card shows the width and height its item carries: stored for local media, reported by the provider for provider media. When a local image has none, the picker measures the original as its preview loads and saves the result, as it does today, so the card shows them from then on. A provider image without them shows none, because the picker and the library measure its preview, which can be a resized variant: Cloudflare Images previews are at most 400 or 800 pixels wide.

### Format

The dimensions are written `width × height`, as the details panel, the image field and the crop tool already write them. One helper formats them for every place in the admin that shows an image's dimensions: the cards and list rows, the details panel's **Dimensions** row, the crop tool's **Output size**, the image field's summary, the **Original** line in the editor's image and gallery panels, and an image field in revision history.

- Each number goes through `i18n.number` without a thousands separator, like the admin's other counts, so it uses the digits the browser's locale data gives the admin's language. English, German and the admin's other Latin-script languages read as they do today; Persian shows `۴۰۳۲ × ۳۰۲۴` and Bengali `৪০৩২ × ৩০২৪`. Until the file size is localized too, a Persian list row reads `image/jpeg · 320.1 KB · ۴۰۳۲ × ۳۰۲۴`.
- The dimensions are isolated with `<bdi dir="ltr">`, so the width is on the left in every language. Dimensions are a technical value, like the slugs and versions the admin already isolates left to right, and the image field's summary already shows them this way. Today the order depends on what surrounds them: in a right-to-left layout, the details panel, the crop tool and the editor's image and gallery panels put the height on the left (`3024 × 4032`), while the image field and a list row's details line put the width there.
- The `×` and the `·` separators are not translated.

In English, the places that already show dimensions look the same, except that the editor's image panel no longer shows a lone width or height on its **Original** line when the other is missing.

## Goals

- Show an image's dimensions on every media card and list row that has them, in the Media Library and the picker.
- Give the filename the card's full width on grid cards.
- Write dimensions the same way everywhere in the admin: in the admin's digits, with the width on the left in every language.

## Non-goals

- Measuring an item the admin doesn't measure today. Uploads record the width and height of images and of video the browser can read. In the library, a local item without them shows no dimensions, as in the details panel, until the picker measures it.
- Finding the real dimensions of a provider image whose provider doesn't report them.
- Filtering or sorting by dimensions, or warning when an image is smaller than the field it goes into.
- Localizing the file size. `formatFileSize` prints Latin digits and English units in every language, and the details panel's file size reverses in right-to-left layouts (`KB 320.1`). Each is a separate fix.

## Interfaces and compatibility

- **Public interfaces.** None. There's no new configuration, API route, stored data or exported component; media items already carry `width` and `height`.
- **Translations.** Two new strings: the **Dimensions** column header and its folder note, "Dimensions are not applicable to folders".
- **Table layout.** The Media Library's list table has six columns. Rows that span the table, such as **Loading folders**, the folder error and **Load more folders**, span six instead of five.
- **Visual baselines.** The `media` and `media-mobile` visual regression screens change in LTR and RTL, so the implementation pull request needs new baselines.

## Errors and edge cases

- A width or height that is missing or `0` shows no dimensions.
- On the narrowest grid card, 195px wide in the library's six-column layout, `12000 × 8000` fits beside a `JPEG` badge.

## Verification

- Unit tests for the helper: width before height, no thousands separator, Persian digits, and nothing when either side is missing or `0`.
- Component tests: the picker's grid cards and list rows, and the library's grid cards and **Dimensions** column, show the dimensions, and the picker's cards are described by them; Persian digits reach the cards; an item without dimensions shows none; a local image without stored dimensions shows them once the picker has measured it; a provider image without reported dimensions shows none after its preview loads.
- Right-to-left layout tests measure that the width is left of the height on a picker grid card and in the details panel, both in Arabic through `LocaleDirectionProvider`, and in the **Dimensions** column. Each fails on `main` and with the isolation removed.
- Layout tests: a 195px grid card keeps `12000 × 8000` whole and shortens an `X-MATROSKA` badge in both directions; the phone-width list shows the dimensions under the filename; the 716px list keeps them on one line.
- The table tests and the Playwright spec `e2e/tests/media-library.spec.ts` count the table's columns from its header instead of expecting five.
- A manual check on `demos/simple` in English and Arabic: the library's grid and list, the picker's grid and list, the details panel, the crop tool and the editor's image panel.

## Open questions

- In a right-to-left layout, should the width sit on the right, where a reader meets it first? The editor's image panel lays out its **Width** and **Height** inputs that way, just below its **Original** line. This plan keeps the width on the left everywhere, as the image field already does; isolating the dimensions in the admin's direction instead would put it on the right.
