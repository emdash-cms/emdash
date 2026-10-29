---
"@emdash-cms/admin": patch
---

Fixes uploads into Media Library folders: empty folders offer an upload action, completed picker uploads stay visible in their destination, and queued or retried files keep their original folder. Each upload into a folder creates a new media item, even if the same file already exists in that folder or elsewhere, rather than reusing or moving existing media. Main-library uploads retain duplicate detection and keep reused items visible in the picker even when the existing item belongs to a folder.
