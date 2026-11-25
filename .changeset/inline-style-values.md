---
"emdash": patch
---

Fixes the Image, Gallery, Cover and Columns Portable Text blocks and the `Image` component so they render stored color and size values only when each is a single valid CSS value.

`dominantColor` and `overlayColor` must be a color, a keyword or a `var()` reference. `minHeight` and a column's `width` must be a length, a percentage or a `var()` reference. `overlayOpacity` and a gallery's `columns` must be numbers; `overlayOpacity` can also be a numeric string. Any other value is ignored and the block uses its default: a 300px minimum height, a black overlay at the block's opacity, an automatic column width, or three gallery columns. A `minHeight` or column `width` written as `calc()` or `auto` also falls back to the default.
