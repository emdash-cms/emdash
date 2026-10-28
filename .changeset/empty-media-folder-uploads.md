---
"@emdash-cms/admin": patch
---

Fixes uploads into Media Library folders: empty folders offer an upload action, completed picker uploads stay visible in their destination, and queued or retried files keep their original folder. Uploading into a folder creates a new media item even if the same file already exists elsewhere, rather than reusing an item outside that folder or moving existing media. Main-library uploads retain duplicate detection.
