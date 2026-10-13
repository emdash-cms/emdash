---
"emdash": minor
---

Adds an image picker and an image toolbar to the visual-editing rich text editor.

Typing `/image` now opens a picker below the line instead of a full-screen dialog. It shows the media library nine images a page, newest first, with a tab for each media provider the site has set up. One click, or the arrow keys and Enter, inserts an image.

The picker no longer uploads images. To use a new image, upload it to the media library in the admin first, then choose it with `/image`. When the library is empty, the picker links to the media library, which opens in a new tab.

Images now show as they publish, with their alignment and a caption field right underneath. Selecting one shows a toolbar to replace it, edit its alt text, or delete it. Replacing an image keeps its caption and takes the new image's alt text.

Typing `/image` now opens a picker only in the editor it was typed in, not in every editor on the page, and an inserted image no longer gets its file name as its alt text. An image inserted from a line inside a quote or list now goes after the quote or list; saving used to drop an image inside one.
