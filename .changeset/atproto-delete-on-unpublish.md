---
"@emdash-cms/plugin-atproto": patch
---

Fixes Unpublish leaving an entry's standard.site document and Bluesky post on the AT Protocol network. The plugin removed them only when the entry was moved to the trash; unpublishing now removes them too, and publishing the entry again creates new ones. If the records can't be removed, the entry shows as an error on the plugin's status page instead of as synced. Entries unpublished before this update keep their records until they are moved to the trash, or published and unpublished again.
