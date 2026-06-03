---
"emdash": patch
"@emdash-cms/admin": patch
---

Add search and filtering to the media library (#1221). The media list endpoint now accepts a `q` parameter for a case-insensitive filename substring search (which also matches extensions, with LIKE wildcards escaped), alongside the existing `mimeType` filter. The Media Library page gains a filename search box and a type filter (images / video / audio / documents), and the media picker in the content editor now searches the local library by filename too. Previously neither surface could search or filter local media, which made large libraries hard to navigate.
