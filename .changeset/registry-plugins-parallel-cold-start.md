---
"emdash": patch
---

Fixes slow cold starts on sites with plugins installed from the registry or marketplace. Each plugin's bundle was read from storage one file and one plugin at a time, including an `admin.js` the runtime never uses. The runtime now reads the manifest and backend of every installed plugin concurrently and skips `admin.js`, so a cold start waits for one round of storage reads instead of three per plugin. Plugins still register in the same order.
