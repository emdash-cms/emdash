---
"emdash": patch
---

Registry install and update now evaluate the full moderation label set (package and publisher cascades, CID-bound labels, negation and expiry) instead of a single yanked-label string match. The update-check and artifact proxy endpoints also gate on this evaluation.
