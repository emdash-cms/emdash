---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes registry and marketplace installation failing after the plugin bundle and state were written because the request runtime did not expose plugin install lifecycle hooks.

Registry consent now uses a neutral summary when a release has no build provenance, keeps record identifiers and publisher-policy mechanics under collapsed technical details, and shows the requested permission count with a scroll cue for longer lists.
