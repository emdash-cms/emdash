---
"emdash": patch
---

Fixes embed blocks whose HTML contains an iframe from a host other than YouTube or Vimeo, such as Google My Maps embeds imported from WordPress, or whose HTML is empty after sanitizing. They rendered as an empty frame or box; they now link to the embed URL, and any other HTML in the embed still renders.
