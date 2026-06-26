---
"@emdash-cms/admin": patch
---

Fixes the publish controls not updating after editing a published post. Saving a change now immediately shows the "Publish changes" button, and publishing immediately switches it to "Unpublish" — previously, on sites without i18n configured, both required a manual page refresh. Closes #1557.
