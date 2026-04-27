---
"emdash": patch
---

Sanitises the `snippet` field returned by the `search()` API so it is safe to render with `set:html` / `innerHTML`. Previously SQLite's FTS5 `snippet()` function spliced literal `<mark>` tags around matched terms but left the surrounding text unescaped, meaning a post title like `Hello <script>alert(1)</script>` would render as live markup. Templates and components rendering snippets directly were exposed; the in-tree `LiveSearch` component already worked around this client-side. Snippets now contain only HTML-escaped source text plus literal `<mark>...</mark>` highlight tags, matching the documented contract.
