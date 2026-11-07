---
"emdash": patch
---

Fixes broken incoming links after importing a WordPress site through the admin WXR importer when EmDash's `urlPattern` resolves a different path than WordPress did. This commonly affects `{year}/{month}/{day}` patterns for posts published near midnight UTC. The importer now creates a 301 redirect from each published, routable entry's original WordPress `<link>` to its EmDash URL, honoring Astro's `base` and `trailingSlash` settings.

If you already imported your content or later change a collection's `urlPattern`, rerun the same WXR file with **skip existing** enabled before serving the migrated site. Changing the pattern alone does not retarget previously generated redirects. The rerun creates missing redirects, updates the importer's enabled 301 redirects, and removes them where the old path now serves published content, including content imported in later chunks. Manual, disabled, pattern, and non-301 rules are not changed.

Date tokens still use UTC, so upgrading does not change existing canonical URLs. Redirects use the stored WordPress link, including historical local/GMT date inconsistencies, rather than converting the GMT date with the site's current timezone. Review reported conflicts, loops, invalid links, or unresolved paths manually. Query-based permalinks are skipped; paths bypassed by the redirect middleware, such as `.html` permalinks, are reported as unsupported when a redirect is needed. Configure redirects for these paths at your web server. Exact original canonical routes still require custom routing that preserves the original permalink data.
