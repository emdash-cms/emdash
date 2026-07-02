---
"emdash": minor
---

Excluding sample content when seeding (`emdash seed --no-content`, or unchecking "Include sample content" in the setup wizard) now also skips the seed's sample bylines and taxonomy terms, so a schema-only setup starts with no sample data at all. Taxonomy definitions, collections, menus, and other structure are still applied. The dev-only setup bypass endpoint accepts `?content=0` to do the same.
