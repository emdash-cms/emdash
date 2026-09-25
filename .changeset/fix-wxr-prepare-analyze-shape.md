---
"emdash": patch
---

Fixes `POST /_emdash/api/import/wordpress/prepare` so it also accepts the post-type shape returned by `/import/wordpress/analyze` (`suggestedCollection` and `requiredFields`), in addition to the existing `collection`/`fields` shape.
