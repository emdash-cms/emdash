---
"emdash": minor
---

Adds site transfer: export a whole EmDash site as a `.emdash` package and import it into an empty EmDash site, on Cloudflare (D1 and R2) or Node (SQLite or PostgreSQL). A package carries content, revisions, schema and block types, taxonomies, bylines, menus, widgets, redirects, SEO, settings, media files, and comments unless you leave them out. Imports are checked before anything is written, run in bounded steps, and end with a receipt issued only after the imported site is verified against the package.

#### From the command line

```sh
emdash site export --output site.emdash --url https://old.example.com
emdash site import site.emdash --analyze --url https://new.example.com
emdash site import site.emdash --plan sha256:… --confirm --url https://new.example.com
```

- `site export` runs the export on the server, downloads and checks it file by file, and writes the package atomically. `--no-comments` leaves out comments and reactions. Run it again with the same `--output` to resume an interrupted export.
- `site import <file> --analyze` checks the package locally, uploads only what the target is missing, and prints the plan: record counts, package users and suggested matches, the changes the import makes, warnings, blockers, and the plan digest. Map package users with `--map-principal <id or email>=<user id, email, or none>` (repeatable), and keep this site's title or tagline with `--use-target-title` and `--use-target-tagline`. The command exits with `2` when the plan has blockers.
- `site import <file> --plan <digest> --confirm` runs the reviewed plan and prints the receipt. It refuses to run if the plan changed after review.
- `site import status|resume|receipt <operation-id>` inspects, continues, or prints the receipt of an import. Resuming an import that is still uploading needs the package file as a third argument.

Every command accepts `--json`; errors print as `{ "error": { "code", "message" } }`. The client adds matching `transfer*` methods and `users()`.

#### REST API

The API lives under `/_emdash/api/admin/transfer`. Exports: `POST exports` (with an optional `Idempotency-Key`), `POST exports/:id/advance` until `nextRequestInMs` is `null`, then `GET exports/:id/archive` for one archive or `GET exports/:id/manifest` and `GET exports/:id/files/<path>` file by file. Imports: `POST imports` with the package's `manifest.json`, `PUT imports/:id/files/<path>` for each file listed by `GET imports/:id/missing`, `POST imports/:id/analyze` until the plan is ready (optionally with `decisions`), `POST imports/:id/execute` with the reviewed `{ packageDigest, planDigest }`, `POST imports/:id/advance` until it finishes, and `GET imports/:id/receipt`. `GET capabilities` reports supported formats and limits and whether this site can receive an import.

A plan lists every change the import makes as `transformations`, including those the exporter already made (for example, records left out because their parent no longer existed, or content that refers to media files the origin site did not have). `warnings` hold findings that need attention, and any `blockers` prevent execution.

#### MCP

The MCP server adds `site_transfer_capabilities`, `site_export_start`, `site_export_status`, `site_import_analyze`, `site_import_start`, `site_import_resume`, `site_import_status`, and `site_import_receipt`. Package files are uploaded over HTTP. Tool results are bounded summaries and never include record values, principal emails, media bytes, or download URLs.

#### Access

Site transfer needs the `transfer:export` or `transfer:import` permission (admins). API and OAuth tokens need `transfer:export` to export, `transfer:analyze` to upload and analyze, and `transfer:execute` to run, cancel, or abandon an import. The `admin` scope includes all three, so existing admin tokens and `emdash login` credentials can use site transfer; grant a single transfer scope to give a token, such as an agent's, narrower access.

An MCP token without `admin` or the needed transfer scope can still start an export or import once an admin approves it: the tool fails with `TRANSFER_APPROVAL_REQUIRED` and an `approvalId`, a signed-in admin approves the request under **Settings → Transfer** (or `POST approvals/:id/approve`), and the agent repeats the call with `approvalId`. A request must be approved within 15 minutes, and an approval must be used within 15 minutes. It is single-use and bound to the user, the token, and the exact request.

The audit log records who creates an export or import, requests, cancels, or abandons an import, or approves or denies a transfer request, and whose request completed or failed each import. Entries hold operation and approval ids, digests, record counts, and error codes, never package content.

#### Writes during an import

While an import is writing, and after a failed or cancelled import until it is abandoned, content and settings changes through the REST API, MCP, public comment and reaction forms, plugin routes, sandboxed plugins, and scheduled publishing return `503 TRANSFER_IMPORT_IN_PROGRESS`. Reads, sign-in, user management, API token management, and entry edit locks keep working. Do not send visitors to an imported site until its receipt is available.

When the site cannot check whether writes are allowed, writes that returned `503 MEDIA_USAGE_ACTIVATION_CHECK_FAILED` now return `503 TRANSFER_FENCE_CHECK_FAILED`, in REST, MCP, and plugin route responses. Update any client that matches the old code.

The public media route now refuses storage keys under `transfers/`. System cleanup removes an import's staged files 24 hours after it finishes and an export's when it expires.
