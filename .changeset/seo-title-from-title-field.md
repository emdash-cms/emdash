---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the default SEO title ignoring a collection's `titleField`. When an entry's SEO title is empty, `getSeoMeta()` now takes the page title from the collection's title field for entries from `getEmDashEntry()` and `resolveEmDashPath()`, and falls back to the `title` field when the collection sets no `titleField` or the entry leaves that field empty. The **SEO Title** placeholder in the editor shows the same value. Before, both read only the `title` field, so a collection that keeps its titles in a `headline` field got an empty page title.

#### What should I do?

If a collection's `titleField` names a field other than `title` and the collection also has a `title` field, its pages now take their title from the `titleField` value. To keep using the `title` field, pass it as the default title:

```ts
const seo = getSeoMeta(post, { defaultTitle: post.data.title });
```
