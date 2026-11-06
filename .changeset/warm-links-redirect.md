---
"emdash": patch
---

Fixes the admin WXR importer so published, routable entries use the original WordPress permalink in the export to create a 301 redirect to the resolved EmDash canonical URL. Rerunning the same WXR with **skip existing** enabled repairs missing redirects and updates the importer's enabled redirects after a `urlPattern` change, removing rules whose sources now serve published content. Manual and disabled rules are not overwritten.

Date tokens remain UTC and `site:timezone` remains unused, so existing generated URLs do not change. The importer uses the stored WordPress link rather than deriving the original local date from GMT, which supports historical WordPress date data. Review reported conflicts, loops, invalid links, or unresolved paths manually. Query-based WordPress permalinks are skipped because redirect matching uses pathnames. Exact original canonical routes still require custom routing that preserves the original permalink data.
