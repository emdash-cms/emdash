---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the content editor failing to open any entry with a date field when the site timezone setting is not a valid IANA timezone (for example `Lisboa` instead of `Europe/Lisbon`). The editor now falls back to UTC for such a value instead of crashing, and the settings API and MCP settings tool reject an unrecognized timezone with a validation error. A site that already stores one can still save its other settings, and can fix the timezone in Settings > General.
