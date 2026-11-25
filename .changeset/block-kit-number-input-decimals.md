---
"@emdash-cms/blocks": patch
---

Fixes Block Kit forms rejecting valid `number_input` values such as `5.00` and `5.25` when the minimum is `0.01`.
