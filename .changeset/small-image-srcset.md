---
"emdash": patch
---

Fixes blurry small images, such as avatars and icons, on high-density screens, and stops requesting high-density sizes larger than the original image.

Media-provider images in `Image` from `emdash/ui`, Portable Text images, and galleries now get a `srcset` with the rendered width and, up to 1920 pixels, a high-density candidate: twice the rendered width, or the original width when that is smaller. Before, provider images narrower than 320 pixels had no `srcset` at all, and other provider images could list widths larger than the original. Provider images shown at their original size, as gallery images always are, now also offer that original width, even above 1920 pixels.

`Image` applies the same high-density candidate to media URLs from another origin, such as a public R2 bucket.
