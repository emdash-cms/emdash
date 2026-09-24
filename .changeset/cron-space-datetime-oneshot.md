---
"emdash": patch
---

Fixes plugin cron schedules that use a space-separated datetime (e.g. `2030-01-02 03:04:05`) so they are treated as one-shot tasks instead of recurring. The executor also now disables any recurring task whose schedule has no future occurrence, preventing a single bad row from leaving itself and the rest of the claimed batch stalled.
