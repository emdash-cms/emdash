---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds numbered page navigation and page-size controls to the local Media Library. Media list requests can opt into numbered pages with `page` and receive an exact `totalCount`; cursor pagination remains the default.

`MediaLibrary` accepts controlled numbered pagination through `pagination`. Existing `hasMore` and `onLoadMore` props remain supported when `pagination` is omitted.
