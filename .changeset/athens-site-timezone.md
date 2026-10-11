---
"emdash": minor
"@emdash-cms/admin": minor
---

Updates the default site timezone from UTC to `Europe/Athens` when a site has no timezone setting. Local dates and times entered for content and schedules now use Athens time, including daylight saving time. Stored timestamps remain UTC, and sites with a saved timezone keep that value.

To retain the previous behavior on a site without a timezone setting, set its timezone to `UTC` in General Settings before upgrading.
