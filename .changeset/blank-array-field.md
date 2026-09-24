---
"emdash": patch
---

Fixes entries that could not be saved because a rich text, multi-select, or repeater field held a blank string, typically left behind by an import. Saving failed with `expected array, received string` on a field the editor never touched. Blank or whitespace-only values for these fields are now stored as empty (`null`) when sent through the admin, the content API, or MCP, so such entries save normally and are repaired the next time they are saved from the admin. Blank values in required fields are still rejected as missing.
