---
"emdash": patch
---

Fixes re-enabling a plugin reporting success when its `plugin:activate` hook fails. Failed activation now returns an enable error and leaves the plugin inactive, with its routes, hooks, sandbox host access, and cron tasks disabled.
