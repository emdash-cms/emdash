---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes isolated HTML blocks seeing the full address of the page they are on, including its query string and fragment, when the block's JavaScript removes the frame's `<base>` element. `document.baseURI` in an isolated block is now always the site's root address, in the admin preview as well as on the site.

The block's document now sits in a second sandboxed frame inside the block's frame. Blocks render, resize and open links as before, and messages still pass between the block and the page. In the block's JavaScript, `parent` is now the outer frame rather than the page, so `top` is no longer the same as `parent`, `document.referrer` is empty, and messages from the page arrive with the outer frame as `event.source` and an `origin` of `"null"`. Under a content security policy that blocks the block's styles, the inner frame keeps the browser's default height of 150 pixels even if your site's styles make the block's frame taller. Browser tests that look inside an isolated block need one more frame step, such as `page.frameLocator("iframe[data-emdash-html-block]").frameLocator("iframe")`. `buildHtmlBlockFrame()` from `@emdash-cms/admin/html-block` accepts an optional `title` for the inner frame.
