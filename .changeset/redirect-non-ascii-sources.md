---
"emdash": patch
---

Fixes redirects whose source path contains non-ASCII characters, such as `/stitek/domácí-zvířata`. These rules never matched before and visitors got a 404. Exact and pattern redirects now match whether the source was entered as raw Unicode or already percent-encoded, with no changes needed to existing rules.
