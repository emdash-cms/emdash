---
"emdash": patch
---

fix(core): accept naive datetime-local values for datetime fields so they round-trip (#1368)

A `datetime` field could not be saved through its own admin editor. The generated validator was `z.string().datetime().or(z.string().date())`, which only accepts ISO with a `Z` suffix or a bare `YYYY-MM-DD` date. But `<input type="datetime-local">` (and many seeds) produce a naive datetime such as `2026-06-04T18:30:00` (no `Z`, no offset). Because the admin re-sends every loaded field on autosave, a stored naive datetime failed validation and the entry became unsavable — the same class of round-trip bug as #867.

The validator now uses `z.iso.datetime({ offset: true, local: true }).or(z.iso.date())`, which accepts ISO with `Z`, ISO with a timezone offset, naive datetimes (with or without seconds), and date-only values, while still rejecting non-dates and impossible dates. This also replaces the deprecated `z.string().datetime()` API.
