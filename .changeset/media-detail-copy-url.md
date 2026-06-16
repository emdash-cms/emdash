---
"@emdash-cms/admin": minor
---

Media details show the file URL with a Copy URL action

The media library previously exposed no way to obtain a file's URL — the
detail panel now shows the absolute file URL (relative local-storage paths
are resolved against the current origin) with a one-click copy button, so
editors can paste media URLs wherever a URL field is needed.
