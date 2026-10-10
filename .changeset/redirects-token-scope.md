---
"emdash": patch
---

Fixes API tokens being unable to manage redirects without the `admin` scope. Reading redirects now takes `content:read` and creating, updating or deleting one takes `settings:manage`. The token owner's role is still checked.
