---
"@emdash-cms/admin": patch
---

Fixes new content always being created with locale `en` regardless of which locale is selected in the collection locale switcher. The "Add New" link now forwards the active locale to the new-content route, and the new-content page passes it through to the create API.
