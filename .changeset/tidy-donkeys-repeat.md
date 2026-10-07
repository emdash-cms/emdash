---
"@emdash-cms/plugin-forms": patch
---

Fixes embedded forms showing only the browser's validation bubble instead of the plugin's inline field errors. Native validation is turned off by the client script once it loads, so readers without JavaScript keep it.
