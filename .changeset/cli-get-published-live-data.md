---
"emdash": patch
---

Fixes `emdash content get --published` returning draft values when an entry has a pending draft. It now returns the published values. `EmDashClient.get()` also accepts a `published: true` option.
