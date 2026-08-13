---
"emdash": patch
---

Fixes returning visitors getting a page without CSS or JavaScript after a deploy that changed only code. Cached routes now revalidate against the build as well as the content, so a browser holding HTML from an earlier deployment is served a fresh page instead of a 304 pointing at asset files that deployment no longer has.
