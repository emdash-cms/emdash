---
"@emdash-cms/admin": patch
---

Fixes the Portable Text editor turning bare `word.tld` text such as `README.md` and `setup.sh` into links while typing or pasting. TipTap's Link extension now only auto-links explicit URLs with a scheme or a `www.` prefix; intentional links can still be added with the toolbar link button or Markdown `[text](url)` syntax.
