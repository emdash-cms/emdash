---
"emdash": patch
---

The editor footer now counts CJK (Chinese, Japanese, Korean) characters in its word count and reading-time estimate. Because these scripts have no spaces between words, the footer previously counted a whole paragraph as a single word and showed "1 min read" for long CJK drafts, even though the published page reported the correct reading time. The footer now matches the published reading time for CJK content; English and other space-delimited text is unchanged.
