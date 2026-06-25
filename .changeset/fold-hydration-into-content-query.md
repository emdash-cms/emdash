---
"emdash": patch
---

Speeds up content reads by fetching each entry or collection together with its author bylines and taxonomy terms in one database query instead of three. This cuts time-to-first-byte on hosted databases like D1 where every query is a network round trip.
