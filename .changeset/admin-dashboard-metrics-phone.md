---
"@emdash-cms/admin": patch
---

Fixes the dashboard's Drafts, Media files, and Users counts stacking into one card per row on phones and other screens narrower than 640px. Two or three counts now share one row at every width, and four counts, when something is scheduled, show as two rows of two until the screen is 1024px wide, where they share one row as before. On those narrow screens the counts and labels are slightly smaller, and a long label wraps inside its card instead of running past it.
