---
"emdash": patch
---

Fixes hyperlinks to imported WordPress media keeping their old WordPress URL after a WordPress import. The media URL rewrite now also rewrites a link's `href` in text and in table cells, a file block's URL, a button's URL, and a cover block's background and the content drawn over it, so a "Download the brochure" link points at the imported file.
