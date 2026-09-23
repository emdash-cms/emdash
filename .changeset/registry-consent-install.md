---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes registry and marketplace installation failing after the plugin bundle and state were written because the request runtime did not expose plugin lifecycle hooks. Failed plugin updates now restore the previous state, remove the failed bundle, and reactivate the previous version after resynchronizing the runtime. Registry update and uninstall requests are also registered in generated Astro sites instead of returning `404 Not Found`.

Registry consent now uses a neutral summary when a release has no build provenance, keeps record identifiers and publisher-policy mechanics under collapsed technical details, and shows the requested permission count with a scroll cue for longer lists.
