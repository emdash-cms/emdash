---
"emdash": patch
---

Fixes datetime fields becoming unsavable through the admin editor (#1368). A `datetime-local` input (or a seed) produces a naive value such as `2026-06-04T18:30:00` with no `Z` suffix or timezone offset, which the field validator rejected — and because the editor re-sends every field on autosave, an entry holding such a value could no longer be saved. Datetime fields now accept naive values (with or without seconds), values with a `Z` suffix or an explicit offset, and date-only values, while still rejecting non-dates.
