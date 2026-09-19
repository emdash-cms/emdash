---
"emdash": patch
---

Search: treat the FTS5 operators as uppercase-only, so an ordinary query containing the word "and" is no longer sent through the raw path. Combined with an apostrophe, and any possessive has one, that path raised an FTS5 syntax error which was returned as an empty result, so a perfectly reasonable search silently found nothing. It also silently dropped prefix matching for those queries.
