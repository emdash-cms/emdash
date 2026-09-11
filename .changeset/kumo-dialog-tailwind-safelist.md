---
"@emdash-cms/admin": patch
---

Fixes Kumo dialogs rendering off-screen by ensuring the Tailwind utilities used by `Dialog`'s runtime `cn()` calls are included in the shipped stylesheet.
