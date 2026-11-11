---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds support for `publishedAt`, `createdAt`, and `updatedAt` as a collection's `dateField`, so editors can see and sort by publication dates without duplicating system timestamps in a custom field. Choose **Date column source** in the existing content type's settings, or set `dateField` through the collection update API or a seed file.

Collections without a configured `dateField` still show and sort by last-updated. Entries with a missing or invalid configured date display their last-updated date, while sorting uses the configured source.
