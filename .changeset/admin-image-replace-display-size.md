---
"@emdash-cms/admin": patch
---

Fixes replacing an image in the rich text editor when it has a custom display size in the image's own proportions: the new image keeps the display width and takes its height from its own proportions, instead of being cropped to the old image's shape. A custom size in other proportions, such as an imported WordPress thumbnail, still applies to the new image.
