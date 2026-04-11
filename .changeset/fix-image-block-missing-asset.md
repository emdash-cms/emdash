---
"emdash": patch
---

Fixes admin editor crash when image blocks lack the `asset` wrapper. Image blocks with `url` at the top level (e.g. from CMS migrations) now render correctly instead of throwing `TypeError: Cannot read properties of undefined (reading 'url')`.
