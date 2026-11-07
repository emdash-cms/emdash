---
"emdash": patch
---

Fixes the blurhash placeholder never showing on `<Image>`, Portable Text images and galleries while the image loads. The inline style used invalid `background` shorthand, so browsers dropped it and the image box stayed blank until the file arrived. The placeholder now also shows through the transparent areas of PNGs; pass `placeholder={false}` to turn it off for an image.
