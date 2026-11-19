---
"emdash": patch
---

Fixes exact redirect rules for paths with file extensions, such as `/old/report.pdf`, being saved but never applied. A file request also matches an exact rule saved with a trailing slash. File requests continue to skip pattern rules and 404 logging.
