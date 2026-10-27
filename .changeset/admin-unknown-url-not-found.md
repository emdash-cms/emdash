---
"@emdash-cms/admin": patch
---

Fixes admin URLs that don't exist, such as `/_emdash/admin/does-not-exist`, showing signed-in users a bare, unstyled "Not Found" line with no sidebar and no way back. Signed-in users now see the admin's "Page Not Found" page inside the admin layout at any unknown admin URL, with a link to the dashboard. The "Collection not found" message for an unknown collection is now translated.
