---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes isolated HTML blocks seeing the full address of the page they are on, including its query string and fragment, when the block's JavaScript removes the frame's `<base>` element. `document.baseURI` in an isolated block is now always the site's root address, in the admin preview as well as on the site.

The block's document now sits in a second sandboxed frame inside the block's frame. Blocks render, resize and open links as before. A few details change:

- **Block JavaScript:** `parent` is now the outer frame, so it is no longer the same as `top`, and `document.referrer` is empty. Send messages to the page with `parent.postMessage()`, not `top.postMessage()`: the outer frame passes them on, and the site only accepts messages from it. Messages from the page arrive with the outer frame as `event.source` and an `origin` of `"null"`.
- **Sites with a content security policy:** if the policy blocks the block's styles, the block's content stays 150 pixels tall even if your site's styles make the frame taller. If the policy sets `base-uri 'none'`, isolated blocks don't load; allow `'self'` in `base-uri` to show them.
- **Browser tests:** a test that looks inside an isolated block needs one more frame step, such as `page.frameLocator("iframe[data-emdash-html-block]").frameLocator("iframe")`.
- **`buildHtmlBlockFrame()`** from `@emdash-cms/admin/html-block` accepts an optional `title` for the inner frame.
