---
"emdash": patch
---

Fixes incoming WordPress links that break after an admin WXR import because EmDash resolves a different permalink, including dated URLs near midnight UTC. The importer creates 301 redirects from the export's original paths where safe and reports conflicts. Exact redirect rules also match lowercase UTF-8 URL escapes, including WordPress's. Existing UTC canonical URLs are unchanged.

#### What should I do?

Configure the final collection `urlPattern` before importing. If you already imported your content or change the pattern afterwards, rerun the same WXR with **skip existing** enabled before serving the migrated site. Review any reported conflicts.

See the [WordPress permalink migration guidance](https://docs.emdashcms.com/migration/content-import/#preserve-wordpress-permalinks) for redirect safeguards, protected rules, and unsupported URL shapes.
