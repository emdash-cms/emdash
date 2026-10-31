---
"emdash": patch
---

Fixes Registry plugin installs and updates failing with `AGGREGATOR_RECORD_MISMATCH` when a newer package profile is awaiting listing review. Releases still have to match the publisher's signed records, and verification and consent continue to use the publisher's current signed release policy. While a newer profile is awaiting review, installed and updated plugins take their name and description from the approved registry listing.
