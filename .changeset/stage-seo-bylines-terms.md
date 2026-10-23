---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes SEO, bylines and taxonomy terms going live as soon as a published entry is saved. On a collection with revisions, a change to a published entry's SEO, bylines, or topics and other terms now waits in the draft with its other changes and goes live when the draft is published, including by a scheduled publish. This covers terms ticked in the editor's taxonomy sidebar, the REST API's `seo`, `bylines` and `taxonomies`, the content-terms API, and the MCP `content_update` tool. After a terms change, the editor shows the entry as having unpublished changes. Discarding the draft drops the change, the revision history records it, and restoring a revision brings back the SEO, bylines and terms that revision saved.

Editors and API clients that can read drafts see the queued SEO, bylines and terms when they open the entry; the public site keeps showing the published values until publication. Entries that have never been published still save these values immediately, as before.
