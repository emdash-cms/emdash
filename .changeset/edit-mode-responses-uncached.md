---
"emdash": patch
---

Fixes feeds, JSON endpoints and other responses that are not full HTML pages keeping their route's `Cache-Control` header when rendered for an editor with the toolbar's edit mode on. These responses include unpublished revisions, so a CDN or caching reverse proxy in front of the site could store one and serve it to visitors. Every edit-mode response is now sent with `Cache-Control: private, no-store`, as pages showing the toolbar already were. This also applies to pages on sites that set `toolbar: false`. Stored media served through the image endpoint stays cacheable.
