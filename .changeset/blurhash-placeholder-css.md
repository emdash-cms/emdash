---
"emdash": patch
---

Fixes the blurhash placeholder never showing on `<Image>`, Portable Text images and galleries while the image loads. The inline style used invalid `background` shorthand, so browsers dropped it and the image box stayed blank until the file arrived. The placeholder is now removed once the image loads or fails, so it never shows through the transparent areas of PNGs. To do this, pages that render these components now load a small client-side script, even with `placeholder={false}`. Without JavaScript, the placeholder stays behind the image. If your site has a strict Content Security Policy, check that it allows this script.
