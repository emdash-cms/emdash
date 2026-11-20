---
"emdash": patch
---

Fixes exact redirect rules for paths with file extensions, such as `/old/report.pdf`, being saved but never applied. A file request also matches an exact rule saved with a trailing slash. Only exact rules apply to file requests; named and catch-all patterns do not redirect them. File requests are not recorded in the 404 log.
