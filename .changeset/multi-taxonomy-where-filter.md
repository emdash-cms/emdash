---
"emdash": patch
---

Fixes collection `where` filters to apply every taxonomy key instead of silently dropping all but the first. Filtering by two or more taxonomies (e.g. `{ category: ["news"], region: ["emea"] }`) now returns the intersection — entries tagged in each taxonomy — matching how field and byline filters already compose.
