---
"@emdash-cms/plugin-cli": patch
---

Fixes plugin builds that import helpers such as `portableTextToMarkdown` from `emdash/client`. The probe and runtime bundles include those helpers so the plugin can load without an installed EmDash package in its sandbox.
