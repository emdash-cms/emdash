---
"@emdash-cms/blocks": patch
---

Fixes `number_input` rejecting in-range decimal values, including prices such as `5.00` and `5.25` when `min` is `0.01`. Number inputs now accept any decimal precision while continuing to enforce `min` and `max`. Plugins that require whole numbers should validate them in their action handlers.
