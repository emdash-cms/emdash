---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds an iframe block for embedding pages from other sites. In the editor, type `/iframe` and paste an embed code or a link into the Code tab; YouTube and Vimeo links become their players, and the Preview tab shows the embedded page. When an entry opens, a saved block waits for **Load preview**. Iframe blocks pasted from another website or browser tab arrive empty. On the site, `Iframe` from `emdash/ui` renders the `iframe` block as a responsive, lazy-loading iframe.

The iframe is sandboxed and sends a `strict-origin-when-cross-origin` referrer. Only https sources render, pages on the site's own host lose same-origin access, and only the permissions video and map players need (such as autoplay, fullscreen and picture-in-picture) reach the embedded page.

The admin's content security policy now allows https frames (`frame-src 'self' https:`), so previews can load embedded pages, including frames inside HTML block previews.

#### What should I do?

- If a plugin already defines an `iframe` block, the editor keeps using the plugin's block and doesn't offer the built-in one. On the site, the plugin's renderer still wins; a plugin without one gets `Iframe` for blocks that have only the built-in fields. In TypeScript, narrowing `PortableTextBlock` on `_type === "iframe"` now gives `PortableTextIframeBlock | PortableTextUnknownBlock`, so reading the plugin's own fields needs a check such as `"theme" in block`.
- With Astro's content security policy turned on, allow the embedded hosts in `frame-src`. Iframe blocks also lose their custom size under that policy.
