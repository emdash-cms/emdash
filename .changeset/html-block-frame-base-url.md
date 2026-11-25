---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes isolated HTML blocks seeing the full address of the page they are on, including its query string and fragment, when the block's JavaScript removes the frame's `<base>` element. `document.baseURI` in an isolated block is now always the site's root address, in the admin preview as well as on the site.

The block's document now sits in a second sandboxed frame inside the block's frame. Blocks render, resize and open links as before, and messages still pass between the block and the page, though messages the page posts arrive at the block with an `origin` of `"null"`, and `parent` in the block's JavaScript is the outer frame rather than the page. Browser tests that look inside an isolated block need one more frame step, such as `page.frameLocator("iframe[data-emdash-html-block]").frameLocator("iframe")`. `buildHtmlBlockFrame()` from `@emdash-cms/admin/html-block` accepts an optional `title` for the inner frame.
