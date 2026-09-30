---
"@emdash-cms/blocks": patch
---

Fixes Block Kit `select` elements showing the selected option's value instead of its label, so a plugin page, form or editor panel that offers `{ value: "eip155:84532", label: "Base Sepolia" }` now displays "Base Sepolia". The value sent to the plugin is unchanged.
