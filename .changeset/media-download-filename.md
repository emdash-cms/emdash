---
"emdash": patch
---

Names media downloads after the file that was uploaded. The public media file route previously sent `Content-Disposition: attachment` with no `filename`, so browsers fell back to the last path segment of the URL and saved every PDF, DOCX or CSV under its storage key. The route now looks the original filename up by storage key and emits both the quoted ASCII `filename` and the RFC 5987 `filename*` form, so non-ASCII names survive.

Media with no matching database row is served exactly as before, and a failed lookup never fails the download.
