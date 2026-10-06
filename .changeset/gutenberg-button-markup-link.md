---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes buttons imported from WordPress losing their link. WordPress stores the button link in the block markup, which the converter ignored. Buttons inside a button group now also drop unsafe links such as `javascript:` URLs, matching single buttons, and a button in a group without a usable link now gets an empty `url` instead of none.
