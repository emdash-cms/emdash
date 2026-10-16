---
"@emdash-cms/blocks": patch
---

Fixes Block Kit forms inside the content editor producing nested HTML forms. Saving with the button or Enter validates only the plugin controls and submits their current values without submitting the surrounding editor.
