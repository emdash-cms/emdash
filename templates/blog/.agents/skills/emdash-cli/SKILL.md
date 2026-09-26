---
name: emdash-cli
description: Use the EmDash CLI to inspect and manage an EmDash instance from the command line, including content, schema, media, taxonomies, menus, search, authentication, seeds, migrations, generated types, and whole-site export and import.
---

# EmDash CLI

The EmDash CLI (`emdash`, with the short alias `em`) manages EmDash CMS instances. Commands fall into two categories:

- **Local commands** work with project files or a configured database: `init`, `doctor`, `seed`, `migrate`, `export-seed`, and `secrets`.
- **Remote commands** talk to a running EmDash instance: `types`, `login`, `logout`, `whoami`, `content`, `schema`, `media`, `search`, `taxonomy`, `menu`, `site`, and `plugin`.

Run `npx emdash --help` and `npx emdash <command> --help` for the installed version's exact commands and flags. Resolve the current target with a read command before a destructive or bulk mutation; examples in this skill do not authorize changing an instance the user did not place in scope.

## Authentication

Remote commands resolve auth automatically:

1. `--token` flag
2. `EMDASH_TOKEN` env var
3. Stored credentials from `emdash login`
4. Dev bypass (localhost only — no token needed)

For a localhost development server with the development bypass enabled, the client can authenticate automatically. For a remote instance, run `emdash login --url https://my-site.pages.dev` or provide a scoped token.

## Custom Headers & Reverse Proxies

Sites behind Cloudflare Access or other reverse proxies need auth headers on every request. The CLI supports this via `--header` flags and environment variables.

### Service tokens for automation

```bash
# Provide sensitive headers through the environment in CI.
export EMDASH_HEADERS="CF-Access-Client-Id: xxx
CF-Access-Client-Secret: yyy"
npx emdash whoami --url https://my-site.pages.dev
```

`emdash login --header` persists custom headers to `~/.config/emdash/auth.json` for later commands. Prefer environment-provided headers in CI so a service secret is not written to the credential file or shell history.

### Cloudflare Access Browser Flow

If you don't have service tokens and `cloudflared` is installed, the CLI will automatically:

1. Detect when Access blocks the request
2. Try to get a cached JWT via `cloudflared access token`
3. Fall back to `cloudflared access login` for browser-based auth

This works for interactive use but isn't suitable for CI. Use service tokens for automation.

### Generic Reverse Proxy Auth

The `--header` flag works with any auth scheme:

```bash
# Basic auth
npx emdash login --url https://example.com -H "Authorization: Basic dXNlcjpwYXNz"

# Custom auth header
npx emdash login --url https://example.com -H "X-API-Key: secret123"
```

## Quick Reference

### Database Setup

For normal site startup, use the project's package script. The first request runs pending migrations and applies the bundled seed when the database is empty and setup has not been completed. The Astro integration generates `emdash-env.d.ts` when the server starts.

```bash
# Start the site with its package script
pnpm dev

# Export an existing database as a seed file
# (the runtime auto-discovers .emdash/seed.json on first boot;
# `mkdir -p` because the directory may not exist yet)
mkdir -p .emdash
npx emdash export-seed > .emdash/seed.json
npx emdash export-seed --with-content=all > .emdash/seed.json
```

### Type Generation

```bash
# Generate types from local dev server
npx emdash types

# Generate from remote
npx emdash types --url https://my-site.pages.dev

# Custom output path
npx emdash types --output src/types/cms.ts
```

Writes `.emdash/types.ts` (TypeScript interfaces) and `.emdash/schema.json`.

### Authentication

```bash
# Login (OAuth Device Flow)
npx emdash login --url https://my-site.pages.dev

# Check current user
npx emdash whoami

# Logout
npx emdash logout

# Generate an encryption key for deployment
npx emdash secrets generate
```

### Content CRUD

The CLI is designed for agents. Create and update auto-publish by default so agents get read-after-write consistency without managing drafts.

```bash
# List content
npx emdash content list posts
npx emdash content list posts --status published --limit 10

# Get a single item (Portable Text fields converted to markdown)
# Returns draft data if a pending draft exists
npx emdash content get posts 01ABC123
npx emdash content get posts 01ABC123 --raw        # skip PT->markdown conversion
npx emdash content get posts 01ABC123 --published   # ignore pending drafts

# Create content (auto-publishes by default)
npx emdash content create posts --data '{"title": "Hello", "body": "# World"}'
npx emdash content create posts --file post.json --slug hello-world
npx emdash content create posts --draft --data '...'  # keep as draft
cat post.json | npx emdash content create posts --stdin

# Update (requires --rev from a prior get, auto-publishes by default)
npx emdash content update posts 01ABC123 --rev MToyMDI2... --data '{"title": "Updated"}'
npx emdash content update posts 01ABC123 --rev MToyMDI2... --draft --data '...'  # keep as draft

# Delete (soft delete)
npx emdash content delete posts 01ABC123

# Lifecycle
npx emdash content publish posts 01ABC123
npx emdash content unpublish posts 01ABC123
npx emdash content schedule posts 01ABC123 --at 2026-03-01T09:00:00Z
npx emdash content restore posts 01ABC123
```

### Schema Management

```bash
# List collections
npx emdash schema list

# Get collection with fields
npx emdash schema get posts

# Create collection
npx emdash schema create articles --label Articles --description "Blog articles"

# Delete a collection after inspecting it and confirming the target
npx emdash schema get articles
npx emdash schema delete articles

# Add field
npx emdash schema add-field posts body --type portableText --label "Body Content"
npx emdash schema add-field posts featured --type boolean --required

# Remove field
npx emdash schema remove-field posts featured
```

`schema add-field` supports the field types printed by `npx emdash schema add-field --help`. The full product schema supports additional field types that are not necessarily creatable through this command.

### Media

```bash
# List media
npx emdash media list
npx emdash media list --mime image/png

# Upload
npx emdash media upload ./photo.jpg --alt "A sunset" --caption "Bristol, 2026"

# Get / delete
npx emdash media get 01MEDIA123
npx emdash media delete 01MEDIA123
```

### Search

```bash
npx emdash search "hello world"
npx emdash search "hello" --collection posts --limit 5
```

### Taxonomies

```bash
npx emdash taxonomy list
npx emdash taxonomy terms categories
npx emdash taxonomy add-term categories --name "Tech" --slug tech
npx emdash taxonomy add-term categories --name "Frontend" --parent 01PARENT123
```

### Menus

```bash
npx emdash menu list
npx emdash menu get primary
```

### Site Export and Import

`emdash site` copies a whole site (content model, content, history, settings, and media, but no users or secrets) into a `.emdash` site package, and imports a package into an empty site. The token needs `admin`, which the `emdash login` token has, or the `transfer:export`, `transfer:analyze`, and `transfer:execute` scopes. An `INSUFFICIENT_SCOPE` error means the token has neither. A package holds every entry and the email addresses of authors and commenters: treat it like a database backup.

```bash
# Export (re-run the same command to resume after an interruption)
npx emdash site export --url https://old.example.com --output site.emdash
npx emdash site export --url https://old.example.com --output site.emdash --no-comments

# Import, step 1: upload and analyze; prints the plan and its digest
npx emdash site import site.emdash --url https://new.example.com --analyze
npx emdash site import site.emdash --url https://new.example.com --analyze \
  --map-principal editor@example.com=editor@example.com --use-target-title

# Import, step 2: execute exactly the reviewed plan
npx emdash site import site.emdash --url https://new.example.com --plan sha256:<hex> --confirm

# Follow up on an import by operation id
npx emdash site import status <operation-id> --url https://new.example.com
npx emdash site import resume <operation-id> [site.emdash] --url https://new.example.com
npx emdash site import receipt <operation-id> --url https://new.example.com

# Stop an import, or lift the write block a failed or cancelled import leaves
# (neither deletes what the import wrote; --yes skips the prompt)
npx emdash site import cancel <operation-id> --url https://new.example.com
npx emdash site import abandon <operation-id> --url https://new.example.com
```

Show the user the plan (differences from the source site, warnings, blockers, principal mappings) and get their confirmation before running `--confirm`; it writes to the target site and blocks other writes there until it finishes. `site import` exits `2` when the plan has blockers, and `site import status` exits `1` for an import that failed, was cancelled or abandoned, or expired. Only cancel or abandon an import when the user asks: abandoning leaves partial data on the site, which then has to be reset before another import. `--map-principal` takes `<principal id or email>=<user id, email, or none>` and is repeatable; decision flags only work with `--analyze`, and each change produces a new plan digest. The public site is not hidden during an import, so the target should stay private until the command prints a receipt with `receiptDigestValid: true`.

## Drafts and Publishing

The CLI auto-publishes on `create` and `update` by default. This means:

- **`create`** creates the item and immediately publishes it
- **`update`** updates the item and publishes if a draft revision was created
- **`get`** returns draft data if a pending draft exists (e.g. from the admin UI)

Use `--draft` on create/update to skip auto-publishing. Use `--published` on get to ignore pending drafts.

Collections that support revisions store edits as draft revisions. The CLI handles this transparently — agents don't need to know whether a collection uses revisions or not.

## JSON Output

All remote commands support `--json` for machine-readable output. It's auto-enabled when stdout is piped. `emdash site` always writes progress to stderr, so stdout holds only the JSON result; errors are `{ "error": { "code", "message" } }`.

```bash
# Pipe to jq
npx emdash content list posts --json | jq '.items[].slug'

# Use in scripts
ID=$(npx emdash content create posts --data '{"title":"Hello"}' --json | jq -r '.id')
```

## Editing Flow

For details on how content editing works — Portable Text/markdown conversion, `_rev` tokens, and raw mode — see **[EDITING-FLOW.md](./EDITING-FLOW.md)**.
