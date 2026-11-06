---
"@emdash-cms/plugin-atproto": patch
---

Fixes AT Protocol re-syndication to update or recreate the document before updating its Bluesky cross-post. If the document cannot be saved, the Bluesky post is no longer updated.
