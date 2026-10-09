---
"emdash": patch
---

Removes up to two database round trips from the first request after a cold start on sites with the plugin marketplace or registry enabled.

With the sandbox disabled (`sandbox: false`), a failure to load the in-process plugin adapter now stops startup with an error instead of silently starting without any marketplace plugins, matching how sandboxed plugins listed in the integration config already behave.
