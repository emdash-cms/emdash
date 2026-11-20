---
"emdash": patch
---

Fixes `emdash content get --published` so it returns an entry's published field values when a draft is pending. Users who can read drafts previously received the draft's values. `EmDashClient.get()` accepts a matching `published: true` option.
