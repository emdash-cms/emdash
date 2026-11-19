---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes media usage tracking missing files linked by their `/_emdash/api/media/file/` URL. **Used in** now includes Portable Text paragraph link marks, HTML block `href` and `src` attributes, and whole string or URL field values, including fields inside blocks and repeaters.

Counts both root-relative URLs and full same-site URLs copied from the Media Library. Full URLs must match the site origin resolved from configuration or environment, the Site URL setting, or the setup URL when neither is set. External URLs and URLs embedded in plain text are not counted. Deleting media still requires reviewing its references first; usage tracking does not prevent deletion.

#### Upgrade action

Existing entries are not re-indexed automatically. After upgrading, run `npx emdash media repair-usage --all` against the upgraded instance (use `--url` to select the site), or save the affected entries again. Alternatives are the `media_usage_repair` MCP tool or `POST /_emdash/api/admin/media-usage/repair`, both with `{ "scope": "all" }`. Until repair completes or the entries are saved again, coverage can still show as complete and a linked file can show **No tracked references found**. See the [upgrade instructions](https://docs.emdashcms.com/deployment/updating/#fixed-media-url-link-usage) for connection options and verification.
