---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds taxonomy term filters to the content list, in the admin and over the API.

The admin list shows a term picker for each taxonomy applied to the collection, beside the status and byline filters. It is the entry editor's searchable picker without term creation, and several terms can be picked. A collection with no taxonomy shows nothing new.

Over the API, `GET /_emdash/api/content/{collection}` accepts `termFilters`, a JSON object of term slugs keyed by taxonomy name:

```
?termFilters={"topics":["rodeo","polo"],"places":["kentucky"]}
```

An entry matches when it carries any of a taxonomy's slugs, for every taxonomy named. `total` and cursor pages follow the filter, and it combines with `fieldFilters` and the other filters. A term matches through any of its locale variants, so a list in one locale also finds entries tagged with a default-locale term. A parent term matches only entries that carry it, not entries that carry only one of its children.

A taxonomy that is not applied to the collection returns `VALIDATION_ERROR` instead of an unfiltered list, and a slug that matches no term returns an empty list.
