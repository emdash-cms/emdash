---
"@emdash-cms/admin": patch
---

Fixes the byline search box reloading the whole page on every keystroke. The search term is now debounced (300ms) before it feeds the bylines query, and the full-page loader only takes over when there is no data yet (`isLoading && !data`) instead of on every new query key. Typing now stays responsive and keeps the input focused, matching the behaviour of the users page. The load-more snapshot and its filter-match check both use the debounced search value so appended pages are no longer discarded.
