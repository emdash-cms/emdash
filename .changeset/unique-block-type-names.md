---
"emdash": patch
---

Fixes `emdash-env.d.ts` declaring the same type name twice when a name generated for a blocks field or one of its block types matched a collection's interface name, another generated block name, or a type imported from `emdash`. For example, a `content` blocks field on `pages` next to a `page_content_blocks` collection declared `PageContentBlock` twice, and one of the two silently took the other's type. The clashing declaration now gets a number suffix, such as `PageContentBlock2`, and `.emdash/types.ts` uses the same names. Collection interface names, and generated block names that don't clash, stay the same.
