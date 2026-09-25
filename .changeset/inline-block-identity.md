---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes saving from visual editing changing custom blocks identified by `url`, such as embeds imported from WordPress, to use `id`, which dropped their `url`. Blocks now keep the identity field they were stored with: blocks with both `id` and `url` keep both, and blocks with neither no longer gain an empty `id`. Custom blocks inserted in the content editor no longer gain an empty `id` when no ID is entered.
