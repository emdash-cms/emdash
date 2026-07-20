---
"emdash": patch
---

Fixes admin-account recovery when `emdash:setup_complete` is set but the users table is empty (a wiped or sanitised database copied between environments). `/api/setup/status` already resumes the wizard at the admin step for this state, but the admin-step routes rejected it with `SETUP_COMPLETE`, leaving no UI path to an admin account. Both routes now reject on the flag only when a user also exists; the fully-set-up and admin-exists rejections are unchanged.
