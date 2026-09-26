---
"emdash": patch
---

Fix plugin one-shot schedules that use a space-separated date and time or a UTC offset. New and existing one-shot due times are stored as canonical UTC timestamps, so the scheduler wakes and runs them at the intended instant. Invalid saved task data or a recurring schedule with no future run is now disabled after it is claimed instead of blocking the rest of the batch and being retried indefinitely.
