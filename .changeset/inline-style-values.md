---
"emdash": patch
---

Fixes the Image, Gallery, Cover and Columns Portable Text blocks and the `Image` component so that stored color and size values can only set the property they belong to. Before this change, a value such as a `dominantColor` of `transparent;position:fixed;inset:0` added its own declarations to the element's inline `style`.

These fields now render only when they hold a single CSS color or keyword (`dominantColor`, `overlayColor`), a single length or percentage (`minHeight`, a column's `width`), or a number (`overlayOpacity`, a gallery's `columns`). Any other value is ignored and the block uses its default: a 300px minimum height, a black overlay at the block's opacity, an automatic column width, or three gallery columns. A `minHeight` or column `width` written as `calc()` or `auto` also falls back to the default.
