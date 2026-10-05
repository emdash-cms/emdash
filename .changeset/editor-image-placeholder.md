---
"@emdash-cms/admin": minor
"emdash": patch
---

Adds empty image blocks to the rich text editor, like the empty video block. `/image` and the toolbar's **Insert image** now add an image block and open the media picker, and choosing an image fills the block as before. Closing the picker leaves the block in place as a dashed placeholder, so you can plan where images go and add them later: click it, drop an image file on it, or select it and press Enter or paste an image. The image toolbar appears once the block has an image.

An empty image block is saved with an empty `asset._ref` and `asset.url`. `Image` from `emdash/ui`, which `PortableText` uses for image blocks, now renders nothing for an image block without a source, instead of an empty `<img>` and its caption.

#### What should I do?

If your site renders image blocks with its own component, skip blocks whose `asset._ref` and `asset.url` are both empty.
