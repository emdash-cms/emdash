---
"@emdash-cms/admin": minor
---

Adds **Settings → Transfer** for moving a site between EmDash installations.

- **Export**: admins export the site as a `.emdash` package, optionally without comments, and download it. The browser fetches and checks the export file by file, so large sites download on Cloudflare Workers too; small sites can also be downloaded as one archive.
- **Import**: on a site with no content of its own, admins choose a package file. The browser checks and uploads it in parts, then shows what will be imported and what the import changes, which user on this site should own each author's content (matched by email where possible), whether to keep this site's title and tagline, which starter content will be removed, and any warnings or blockers. After confirmation the import runs and ends with a verified receipt that can be copied. Leaving the page does not lose an unfinished import; an interrupted upload needs the same file chosen again. On a site that already has content, the page lists what prevents an import.
- **Approvals**: the page lists requests from MCP clients to start an export or import, so an admin can approve or deny them.

The setup wizard now asks how to start the site: with the template's sample content, as an empty site, or by importing an existing EmDash site, which replaces the "Include sample content" checkbox. Choosing import skips the sample content and opens Transfer at the import step once your account is created. While a site has no content, the dashboard shows a dismissible suggestion that links to the import, and Backups settings link to Transfer.

When creating an API token, admins can select the `transfer:export`, `transfer:analyze`, and `transfer:execute` scopes to give a token, such as an agent's, narrower access than Admin, which includes them. The OAuth consent screen lists them when a client requests them.
