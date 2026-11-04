---
"emdash": patch
---

Fixes redirects whose source path contains non-ASCII characters, such as `/stitek/domácí-zvířata`. These rules never matched before and visitors got a 404. Exact and pattern redirects now match whether the source was entered as raw Unicode or percent-encoded in either letter case, with no changes needed to existing rules. Non-ASCII characters in a redirect destination are percent-encoded in the `Location` header instead of failing the request. Loop detection, both when saving a redirect and on the Redirects page, treats raw and percent-encoded spellings of a path as the same path.
