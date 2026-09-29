---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds CSS and JavaScript to HTML blocks, and changes how new HTML blocks render on the site.

Previously, every HTML block rendered inline, and the site sanitized its HTML, removing scripts and styles. HTML blocks created in the admin editor, or with `/html` in visual editing, now render in a sandboxed iframe that runs their HTML, CSS and JavaScript. Anyone who can edit content (Contributor and up) can add JavaScript that runs for visitors once the entry is published. The iframe can't reach the site's cookies, storage or pages, and the site's styles don't apply inside it. There is no site-wide setting for this; to render a block the previous way, choose **Inline** in its menu.

Existing HTML blocks, and blocks created through imports, REST or MCP, keep rendering inline unless they set `isolated: true`.

In the editor, an HTML block has HTML, CSS and JS tabs with a code editor, and a Preview tab that shows the block as the site renders it. A saved block that runs JavaScript waits for **Run preview**. HTML blocks can no longer be nested in quotes, lists or table cells, where saving dropped them.

#### New fields

`htmlBlock` gains optional `css` and `js` strings and an `isolated` flag. They're written only when set, so existing content is unchanged when it's opened and saved.

#### What should I do?

- If your site replaces the `htmlBlock` renderer, pass blocks with `isolated: true` to `HtmlBlock` from `emdash/ui`, or render them in an iframe whose `sandbox` omits `allow-same-origin`. Otherwise isolated blocks render without their CSS and JavaScript.
- If you render Portable Text outside EmDash's components, handle `isolated` blocks the same way.
- With Astro's content security policy turned on, the browser blocks the styles and scripts inside isolated blocks, so they render without their CSS, JavaScript or automatic height.
