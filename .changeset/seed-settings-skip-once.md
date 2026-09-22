---
"emdash": patch
---

Fixes seed application overwriting admin-managed site settings. The default `skip` mode preserves existing settings such as `site:title` and `site:tagline` while filling in missing settings; use `update` to overwrite supplied settings or `error` to stop at the first conflict.
