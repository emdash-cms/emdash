---
"emdash": patch
---

Fixes term translations that could sit under a different parent than the term they translate. A translation created without a parent through the REST API, MCP `taxonomy_create_term`, the plugin `createTerm()` API, a seed file or a WordPress import now takes its term's parent and position instead of becoming a root term in its locale; sending `parentId: null` does the same as leaving it out. A translation created under a different parent moves the term in every locale, as changing the parent through any locale already did.

On sites where earlier versions left a term's locales under different parents, saving the term's parent from any locale now moves every locale under it. The admin's term dialog sends the current parent on every save, so the first save of such a nested term, even a label change, settles its parent for all locales.
