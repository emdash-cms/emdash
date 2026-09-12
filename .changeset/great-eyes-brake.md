---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds taxonomy-term filtering to the content list, in the admin and over the API.

A collection's list could be narrowed by status, author, byline, date range, free text and any indexed custom field, but not by a taxonomy term, so a site organized by categories or tags could not be browsed by them in the screen editors work in.

The admin now shows one dropdown per taxonomy applied to the collection, beside the existing filters. Nothing is configured per site: a collection already declares which taxonomies apply to it, so a collection with no taxonomy is unchanged and one that gains a taxonomy gains its filter. Hierarchical taxonomies are indented.

Over the API, `GET /content/{collection}` accepts `termFilters`, a JSON object keyed by taxonomy name:

```
?termFilters={"topics":["rodeo","polo"],"places":["kentucky"]}
```

An entry matches **any** of a taxonomy's slugs and **every** taxonomy named: OR within a taxonomy, AND across taxonomies. Term slugs resolve through their translation group, so a term matches across locales unless the request is locale-scoped. The filter composes with `fieldFilters` and every existing filter, and `total` reflects it, so cursor pages stay consistent.

Two cases fail rather than returning a misleading list. A taxonomy that is not applied to the collection is rejected with `VALIDATION_ERROR` instead of being ignored, and a taxonomy given an empty array matches nothing instead of being treated as no filter. Callers that previously passed an unrecognised filter parameter and received an unfiltered list will now see an error where the parameter names a real but unapplied taxonomy.
