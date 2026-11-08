---
"emdash": patch
---

Reduces database queries on pages that render the same byline more than once in a single request, such as several `getEmDashCollection()` lists or a `getEmDashEntry()` page with a related-posts list, when byline custom fields are defined. Each byline's custom field values are now loaded once per request instead of once per list, including when several lists render at the same time.
