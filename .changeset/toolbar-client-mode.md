---
"emdash": minor
"@emdash-cms/admin": patch
---

Adds a `toolbar` config option for reliable editor-toolbar delivery behind shared caches. `toolbar: "client"` keeps public HTML identical for every visitor and shows a client-side "Edit" pill for logged-in editors that opens a fresh, uncached editor render via an `_edit` query param; `toolbar: false` disables the toolbar entirely. The toolbar can now also be dismissed in the browser via its × button. The default (`"server"`) is unchanged.
