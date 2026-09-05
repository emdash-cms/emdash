---
"emdash": patch
---

Fixes the media-usage cleanup sweep reading its entire pending backlog on every run once it resumes from a saved cursor. On SQLite and D1 the sweep now stops at its page limit instead of scanning and sorting every row between the cursor and the cutoff. A reported sweep over a 157,000-row `_emdash_media_usage` table read 427,020 rows to return a 250-row page; it now reads about 500. D1 sites with a large media-usage backlog will see rows read by the cleanup task fall accordingly, with no configuration change.
