---
"emdash": patch
---

Fixes Revisions missing the content an entry started with, so editors can compare against it or restore it after editing. In collections with revisions, the first save of an entry that has no revision yet now keeps its starting content as its oldest revision, whether that save comes from the admin, the API, MCP or a plugin. This covers new and duplicated entries, translations, imported posts, and existing entries that haven't been saved since they were created.
