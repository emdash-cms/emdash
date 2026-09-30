---
"emdash": patch
---

Speeds up the image endpoint EmDash installs (`/_image` by default): its requests no longer wait for the database setup check and runtime startup that delayed the first images on a fresh server instance, such as a new Cloudflare Worker isolate. Signed-in requests still get `locals.user`, but on D1 with `session` enabled their responses no longer set the D1 bookmark cookie, so an edge-cache route rule for `/_image` now also caches admin media thumbnails.

On these requests `locals.emdash` holds only `storage`, plus `db` for a signed-in user; the page and admin helpers it carried before are not set. Playground requests are unchanged. While `check` or `manual` migration mode answers other requests with the 503 "Database migrations are required" response, image endpoint requests are still served.
