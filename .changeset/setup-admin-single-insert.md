---
"emdash": patch
---

Fixes the setup wizard creating two administrator accounts when two passkey setup verifications finish at the same time. Whichever verification saves its account second now fails with `ADMIN_EXISTS`, and no second account is created.
