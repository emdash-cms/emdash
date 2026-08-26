---
"emdash": patch
---

Fixes SQLite and D1 sites where an interrupted upgrade left the byline credits table staged as `_emdash_content_bylines_new`, so pages, feeds and the admin reported no entries although the content was intact. The next migration run restores the table and the stored credits.
