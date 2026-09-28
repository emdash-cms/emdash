---
"emdash": patch
---

Fixes the WordPress media URL rewrite matching a URL map key that carries a query string by its base URL. A key such as an attachment's `?attachment_id=7` shortlink also matched the home page, so the rewrite pointed links to the home page at that file. Such a key now matches that URL only, and inside a text field only where the URL ends with it.
