---
"@emdash-cms/admin": patch
---

Fixes admin URLs that don't exist, such as `/_emdash/admin/does-not-exist`, showing a bare, unstyled "Not Found" line with no sidebar and no way back. Every unknown admin URL now shows the admin's "Page Not Found" page inside the admin layout, with a link to the dashboard. The "Collection not found" message for an unknown collection is now translated.
