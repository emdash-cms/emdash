---
"emdash": patch
---

Fixes the Image, Gallery, Cover and Columns Portable Text blocks and the `Image` component so they render stored color and size values only when each is a single valid CSS value.

`dominantColor` and `overlayColor` must be a color, a keyword or a `var()` reference. `minHeight` and a column's `width` must be a length, a percentage, a keyword such as `auto`, a `calc()`, `min()`, `max()` or `clamp()` of numbers and units, or a `var()` reference. A `var()` fallback must itself be one of these values. `overlayOpacity` can be a number, a numeric string or a percentage, and a gallery's `columns` must be a positive integer. Any other value is ignored and the block uses its default: a 300px minimum height, a black overlay at the block's opacity, an automatic column width, or three gallery columns. When an image block's own `dominantColor` is ignored, the color stored with the media is used.
