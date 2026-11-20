---
"emdash": patch
---

Fixes searches in the admin Media Library and media picker failing on Cloudflare D1 for long search terms, including multibyte text, and fixes the same limit in folder search. Media search also matches storage keys and media IDs, and accepts pasted media file URLs. Short terms may return more results because they can match keys and IDs as well as filenames.
