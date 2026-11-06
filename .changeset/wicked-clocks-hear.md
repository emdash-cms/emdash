---
"emdash": patch
---

Fixes WordPress WXR and plugin imports discarding dates on posts imported as drafts. Publishing those posts now keeps the imported date and date-based permalink. This also applies to genuine WordPress drafts with a source date, including the local-date fallback, rather than dating them at first publication in EmDash. Future posts still get their publication date from the final schedule.
