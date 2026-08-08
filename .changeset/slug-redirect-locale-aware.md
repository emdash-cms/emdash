---
"emdash": patch
---

Fixes renaming a translation taking its canonical page offline. When two locale variants share a slug, renaming either one created a 301 away from a URL the other still serves, making the live page unreachable. Slug-change redirects are now skipped when another entry still holds the old slug.
