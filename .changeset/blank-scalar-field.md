---
"emdash": patch
---

Fixes entries that could not be saved after an optional URL or date field was cleared in the admin. The admin sent a blank string for the emptied field and validation rejected it, for example with "Website must be a valid URL.", so every save and autosave of the entry failed. Blank or whitespace-only values for optional `url`, `datetime`, `number`, and `integer` fields are now stored as empty (`null`) when sent through the admin, the content API, or MCP, and an entry that already stores a blank URL is repaired the next time it is saved. Blank values in required fields are still rejected as missing.
