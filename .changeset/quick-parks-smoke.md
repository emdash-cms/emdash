---
"emdash": patch
---

Fix crash on fresh deployments when the first request hits a public page before setup has run. The middleware now detects an empty database and redirects to the setup wizard instead of letting template helpers query missing tables.
