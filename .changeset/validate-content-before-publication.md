---
"emdash": patch
---

Fixes Publish accepting entries that fail the current collection schema, including required fields, reference selections, and media MIME restrictions. All publication paths validate complete saved content before it becomes public; field-schema errors retain field-level issues. Updates to `status: "published"` validate the live content they write without promoting revision-backed drafts. Partial draft saves remain supported, and invalid scheduled entries stay scheduled for correction and retry.
