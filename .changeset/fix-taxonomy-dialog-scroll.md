---
"@emdash-cms/admin": patch
---

Fix taxonomy term edit dialog overflow with many locales (#1269)

Adds `max-h-[85vh] flex flex-col` to the `TermFormDialog` and makes its body
scrollable with `flex-1 overflow-y-auto`, keeping the header and footer pinned.
This prevents the Cancel/Update buttons from falling off-screen when the
Translations panel lists a large number of locales.
