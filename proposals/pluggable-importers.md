---
title: Pluggable importers
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
champion: Kevin Kyburz (@swissky)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4669
created: 2026-11-05
---

# Pluggable importers

## Summary

Move the WordPress importer out of `emdash` into its own package and give core a generic import frame that any source package plugs into. Core keeps the parts every import needs: the source registry, routes addressed by source ID, the admin Import page, field mapping and the writers that create collections, entries, media, bylines, taxonomies, menus and redirects. Source packages read a foreign system and yield normalized items. Builder adapters inside a source convert page-builder content (Gutenberg, GenerateBlocks, Elementor) to Portable Text.

Two shared building blocks make large imports possible without raising per-request limits. Import jobs run in the background, so an import no longer depends on an open browser tab. A public SDK for the existing site package format lets a heavy source such as Magento or TYPO3 convert offline and use `emdash site import`.

A site that does not configure an importer does not bundle importer code. The WordPress package stays installed in the `create-emdash` templates, and the existing routes and `emdash import wordpress` keep working through a deprecation period.

## Problem and user case

EmDash's import support is built around one source system.

- **Core ships one importer.** `packages/core` contains the WordPress importer: WXR, the WordPress REST API and the EmDash Exporter plugin. That is about 10,500 lines across `src/import/`, `src/cli/wxr/`, `src/cli/commands/import/` and `src/astro/routes/api/import/`, plus the `sax` and `@emdash-cms/gutenberg-to-portable-text` dependencies. In a current build, the chunks that contain only import code total about 189 KB of the 5.4 MB in `packages/core/dist`. The admin bundles `WordPressImport.tsx` (2,592 lines) into its main chunk. Since #3199 none of this code loads at Worker startup, and `scripts/check-worker-startup.mjs` keeps it that way. Every site still installs, bundles and deploys it.
- **A second source has nowhere to go.** `ImportSource` and `registerSource()` exist and are exported from `emdash`, but `src/import/index.ts` registers the three WordPress sources unconditionally. The routes are WordPress-specific (`/_emdash/api/import/wordpress/*`, `/_emdash/api/import/wordpress-plugin/*`), and the admin UI is a WordPress wizard rather than a frame that sources plug into. `@emdash-cms/contentful-to-portable-text` exists as a package and is not wired to any import path.
- **Page builders don't fit.** Gutenberg conversion already accepts `customTransformers` keyed by block name, so GenerateBlocks or Kadence blocks could be supported with a transformer set, but there is no configuration surface to pass one. Elementor stores layouts as JSON in the `_elementor_data` post meta, not in `post_content`. The Exporter plugin already detects Elementor, Divi, WPBakery and Beaver Builder and reports them as builders whose layouts cannot be converted 1:1.
- **Large imports depend on the browser.** The admin drives a WXR import chunk by chunk, 30 posts per request (50 items for the Exporter plugin). Each request uploads the whole WXR file again and parses it in full with `parseWxrString(await file.text())`. Closing the tab stops the import. Memory per request grows with the file, and a shop or CMS with tens of thousands of items is not realistic this way.

The people affected are site owners moving to EmDash from WordPress page builders or from other systems, and developers who would write an importer for a system they know. The champion migrates client sites from WordPress and maintains the EmDash Exporter plugin in `emdash-cms/wp-emdash`.

## Example

A site that migrates from WordPress with Elementor and GenerateBlocks content:

```ts title="astro.config.mjs"
import { emdash } from "emdash/astro";
import { wordpress, gutenberg, generateBlocks } from "@emdash-cms/import-wordpress";
import { elementor } from "@emdash-cms/import-elementor";
import { heroTransformer } from "./src/import/hero.js";

export default defineConfig({
	integrations: [
		emdash({
			importers: [
				wordpress({
					builders: [elementor(), generateBlocks(), gutenberg()],
					transformers: { "acme/hero": heroTransformer },
				}),
			],
		}),
	],
});
```

The admin Import page lists the WordPress source. Analysis reports, per post, which builder adapter claimed it. The administrator maps post types to collections and starts the import. The import runs as a background job. The administrator can close the tab, come back, see progress and errors, and resume or cancel the job.

A site without `importers` has no Import entry in the sidebar, no import routes and no importer code in its bundle.

A Magento store with 40,000 products is converted on a workstation:

```sh
npx @emdash-cms/import-magento ./magento-dump.sql --out store.emdash
npx emdash site import store.emdash --analyze
npx emdash site import store.emdash --plan <digest> --confirm
```

The converter writes a site package through the site package SDK. The target site validates and imports it with the existing site transfer engine.

## Goals

- A site that configures no importer installs, bundles and evaluates no source or builder code.
- A third party can publish an importer as a package without changing `emdash`.
- Builder adapters can claim and convert content inside a source, and a site can add transformers for its own blocks or shortcodes in config.
- An import can run longer than one request and survives a closed browser tab, on Cloudflare and on Node.
- A heavy source can produce a validated site package offline without depending on EmDash internals.
- WordPress users get the same import experience out of the box as today.
- Existing routes, the `emdash import wordpress` command and the public import exports keep working through a documented deprecation period.

## Non-goals

- Importing into a site that already has content through the site package path. Site import requires an empty target today; additive package import is a separate proposal.
- Ongoing sync from an external system. A bulk upsert API keyed by external ID is a separate proposal.
- A general-purpose workflow engine. The background job contract covers resumable steps owned by core features; other uses can adopt it later in their own proposals.
- Running importers as sandboxed plugins.
- Shipping importers for Blogger, Tumblr, TYPO3 or Magento. This RFC defines the contracts; each importer is its own package and its own work.
- Changing WordPress conversion behavior. The extraction is behavior-preserving.

## Detailed design

### Layers

| Layer            | Package                                              | Responsibility                                                                        |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Import frame     | `emdash`                                             | Registry, routes, admin Import page, field mapping, writers, jobs                     |
| Source           | `@emdash-cms/import-wordpress`, third-party packages | Probe, analyze and read a foreign system; yield normalized items and media references |
| Builder adapter  | Exported by a source package or a separate package   | Claim items whose content a builder produced and convert it to Portable Text          |
| Site package SDK | `@emdash-cms/site-package`                           | Write and validate a `.emdash` package outside an EmDash runtime                      |

### Configuration

`emdash()` gains an optional `importers` option that takes importer descriptors, following the pattern of `authProviders`:

```ts
interface ImporterDescriptor {
	/** Stable source ID, for example "wordpress". Matches /^[a-z][a-z0-9-]*$/. */
	id: string;
	/** Module that exports the ImportSource. The import routes load it lazily. */
	entrypoint: string;
	/** Module that exports admin components for source-specific steps. */
	adminEntry?: string;
	/** JSON-serializable options passed to the source factory. */
	config?: unknown;
}
```

Descriptors resolve at build time into a virtual module that maps source IDs to dynamic imports. The import routes are injected only when at least one importer is configured. The manifest lists configured sources, and the admin shows the Import page only when that list is not empty.

Duplicate source IDs fail the build with a message that names both packages.

### Source contract

The existing `ImportSource` interface becomes the public contract, with three changes:

- `icon` accepts any string. The admin renders known names and falls back to a generic icon.
- `fetchContent` is replaced by a paged, resumable read: `fetchPage(input, { cursor, limit }): Promise<{ items: NormalizedItem[]; next: string | null }>`. The cursor is an opaque string the source controls, and the frame persists it between job steps.
- `analyze` and `fetchPage` receive an `ImportContext` that exposes the SSRF-checked `fetch` (today's `ssrfSafeFetch`), a reader for staged files and the configured builder adapters. Sources never receive the database.

`NormalizedItem` keeps its fields. Its `content` is either Portable Text or `{ builder: string; raw: unknown }`, in which case the frame calls the named adapter before writing.

### Builder adapters

```ts
interface BuilderAdapter {
	id: string;
	/** Return true when this adapter owns the item's content. */
	claims(item: SourceItem): boolean;
	convert(item: SourceItem, context: ConvertContext): Promise<PortableTextBlock[]>;
	/** Block types this adapter emits that the target schema must provide. */
	blockTypes?: string[];
}
```

The source asks adapters in configured order and uses the first that claims an item. The WordPress package ships `gutenberg()`, which wraps `gutenbergToPortableText` and accepts `customTransformers`, and `classic()` for pre-block HTML. `generateBlocks()` adds `generateblocks/*` transformers to `gutenberg()`. `elementor()` claims items whose meta contains `_elementor_data` and converts sections, columns and widgets.

Analysis reports, per post type, how many items each adapter claimed and how many fell through to the default. Block types an adapter needs appear as schema requirements, with the create-or-map flow the WordPress wizard uses for fields today.

### Routes

The frame owns routes addressed by source ID:

| Route                                        | Purpose                                    |
| -------------------------------------------- | ------------------------------------------ |
| `POST /_emdash/api/import/probe`             | Probe a URL against all configured sources |
| `POST /_emdash/api/import/[source]/files`    | Stage an uploaded file in storage          |
| `POST /_emdash/api/import/[source]/analyze`  | Analyze staged input or a URL              |
| `POST /_emdash/api/import/[source]/prepare`  | Create or map collections and fields       |
| `POST /_emdash/api/import/jobs`              | Start a job from an analysis and a mapping |
| `GET /_emdash/api/import/jobs/[id]`          | Job state, progress and errors             |
| `POST /_emdash/api/import/jobs/[id]/advance` | Run one step                               |
| `POST /_emdash/api/import/jobs/[id]/cancel`  | Cancel a job                               |

Every route requires `import:execute`, as today, and state-changing routes keep the `X-EmDash-Request` requirement. An uploaded file is staged in the site's storage once and read by every step, instead of being uploaded and parsed again for each chunk.

### Import jobs

A job is a row in a new `_emdash_import_jobs` table: source ID, analysis digest, mapping, cursor, counters, last error, starting user and state (`queued`, `running`, `failed`, `cancelled`, `completed`). Per-item results go to `_emdash_import_job_items`, keyed by job and source item ID, so a repeated step skips items it already wrote.

A step reads one page from the source, converts it, writes it and saves the new cursor in the same transaction as the item results where the dialect allows it. Steps stay inside the per-request budgets the site transfer engine already uses (`TransferStepBudget`). Three drivers advance a job:

- **Cloudflare:** a Workflow class exported from `@emdash-cms/cloudflare` runs one job step per Workflow step, with retries. The templates add the binding. A site without the binding uses the fallback.
- **Node:** an in-process loop started by the job route advances steps until the job finishes or the process stops. After a restart the next cron tick picks up `running` jobs.
- **Fallback for every runtime:** the admin calls `advance` while the page is open, and the cron tick advances `running` jobs. This is today's behavior plus resumption.

Only one job runs per site at a time. Starting a second returns `IMPORT_JOB_ACTIVE`.

### Site package SDK

`@emdash-cms/site-package` exports the format types, a streaming package writer and the package validator from `packages/core/src/transfer/format/`. It has no database or runtime dependency, and `emdash` depends on it instead of owning the format code. A package that passes the SDK validator passes the format checks of `emdash site import --analyze`; target-specific checks (empty target, available storage) still run on the site.

### WordPress package

`@emdash-cms/import-wordpress` contains the WXR parser, the REST and Exporter-plugin sources, the WordPress-specific helpers (menus, comments, sections, settings, taxonomies, URL rewriting), the Gutenberg and classic adapters, the WordPress admin steps and the `emdash import wordpress` command. Writers that are not WordPress-specific move into the frame.

### Admin

The Import page lists configured sources with their probe and file options. The frame owns the shared steps: analysis summary, collection and field mapping, job progress, errors, resume and cancel. A source with extra steps, such as WordPress author mapping, provides them through `adminEntry`. Frame strings go through Lingui and use logical layout classes. The source authoring guide requires the same of source-provided components.

### Errors

New error codes: `IMPORT_SOURCE_NOT_FOUND` (unknown source ID), `IMPORT_JOB_ACTIVE`, `IMPORT_JOB_NOT_FOUND`, `IMPORT_SOURCE_CHANGED` (staged file or mapping digest differs from the job; generalizes today's `WXR_IMPORT_SOURCE_CHANGED`), `IMPORT_ADAPTER_FAILED` (recorded per item, the job continues).

## Compatibility and migration

- `@emdash-cms/import-wordpress` becomes a dependency of every `create-emdash` template and appears in their `importers` config, so new sites behave as today.
- For one minor release, when `importers` is unset, `emdash` registers the WordPress importer if `@emdash-cms/import-wordpress` is installed and logs a deprecation warning that shows the config line to add. If the package is not installed, the warning tells the administrator to install it. The upgrade guide and the changeset say the same.
- The routes under `/_emdash/api/import/wordpress/*` and `/_emdash/api/import/wordpress-plugin/*` stay as aliases served by the WordPress package for the deprecation period. `emdash import wordpress` forwards to the package's command.
- The public exports `registerSource`, `getSource`, `getAllSources`, `getFileSources`, `getUrlSources`, `probeUrl`, `clearSources`, `wxrSource`, `parseWxrDate`, `wordpressRestSource` and `importReusableBlocksAsSections` stay in `emdash` as deprecated re-exports and are added to the deprecations tracking issue.
- The job tables are new and additive. Content written by earlier imports is unaffected and needs no backfill.
- Rollback: remove `importers` and the package. The job tables stay and are ignored.

## Security and privacy

- **Authorization:** every route and job action requires `import:execute` (Admin). Jobs record the starting user for the audit trail.
- **Untrusted input:** WXR files, REST responses and builder JSON are untrusted. Sources fetch only through the SSRF-checked fetch in `ImportContext`. XML parsing keeps entity expansion disabled. Adapters must not evaluate content. Elementor HTML, shortcode and script widgets convert to the existing HTML and embed blocks with today's sanitization.
- **Code trust:** importer packages run in the host with full trust, like native plugins and auth providers. The docs state that installing an importer installs code.
- **Secrets:** an Exporter-plugin application password used by a job is stored encrypted with the existing secrets mechanism and deleted when the job ends.
- **Privacy:** imported author and commenter emails are written as today. Staged files are deleted when the job completes or is cancelled. A cleanup pass removes files of jobs that have not advanced for seven days.

## Performance

- **Logged-out routes:** no change. No import code runs on public renders, and the frame adds no query to them.
- **Cold start:** `scripts/check-worker-startup.mjs` keeps rejecting eager WXR code, and the check extends to every configured importer entrypoint.
- **Install and deploy size:** a site without importers drops the import chunks, `sax` and the Gutenberg converter. The implementation measures bundle and Worker upload size on `starter-cloudflare` with and without `importers`.
- **Import throughput:** staging the file once removes the repeated upload and full parse per chunk. The implementation measures memory and CPU per step on a 50 MB WXR fixture before and after.
- **Admin:** the Import page and source steps load as lazy chunks, which removes the WordPress wizard from the admin's main chunk.
- **Database:** a job step adds one read and one write on the job row to the queries the writers already run.

## Failure handling

- A failed step keeps the cursor of the last completed step. The Workflow driver retries with backoff; the other drivers retry on the next advance. After five consecutive failures the job moves to `failed` with the last error, and the administrator can resume it.
- An item that fails conversion or validation is recorded with its source ID and error, and the job continues. The job view lists failed items and can retry only those.
- A changed staged file or mapping makes `advance` return `IMPORT_SOURCE_CHANGED` instead of writing.
- Cancel stops the job after the current step. Items already written stay, as today, and the job view links them.
- If the source package is removed while a job is `running`, the next step fails the job with `IMPORT_SOURCE_NOT_FOUND`.
- Logs use an `[import:<source>]` prefix with the job ID.

## Verification

- **Behavior preservation:** the current WordPress import tests (WXR, REST, Exporter plugin, media, menus, comments, taxonomies, i18n, URL rewriting) move with the code and pass unchanged against the package. The WordPress migration acceptance suite runs against a template with the package configured.
- **Bundle:** a build test asserts that a site without `importers` contains no import routes, no `sax` and no Gutenberg converter, and that the startup check passes with importers configured.
- **Jobs:** integration tests on SQLite, Postgres and real D1 (`tests/workerd`) for repeated steps, interrupted steps, cancel, one active job per site and resumption after a simulated restart.
- **Adapters:** fixture tests for Gutenberg, GenerateBlocks and Elementor content, including unknown widgets, malformed `_elementor_data` and empty meta.
- **SDK:** packages written with the SDK pass `emdash site import --analyze`. Invalid packages fail the SDK validator and the site analysis with the same issue codes.
- **Compatibility:** the deprecated routes, the CLI command and the deprecated exports keep working when `importers` is unset and the package is installed.
- **Manual:** a full import of a real WordPress site on Cloudflare with the tab closed mid-import, and the Import page in Arabic.

## Rollout and implementation

1. **Frame:** source registry from config, routes by source ID, staged files, jobs with the fallback driver, admin Import page. The WordPress code stays in `emdash` and registers through the new frame.
2. **Extraction:** move the WordPress code to `@emdash-cms/import-wordpress`, add the compatibility path, aliases and deprecations, and update the templates.
3. **Drivers:** the Cloudflare Workflow driver and the Node loop.
4. **Builder adapters:** the adapter contract, then `generateBlocks()` and `elementor()`.
5. **Site package SDK:** extract the format code into `@emdash-cms/site-package` and document converter authoring.

Each step ships separately with a changeset. After the deprecation period, a minor release removes the compatibility path, the aliases and the deprecated exports.

## Alternatives

- **Keep the importer in core.** No migration cost, and the code no longer affects cold start. Every site still installs and deploys it, and each further source grows core.
- **Run importers as sandboxed plugins.** Sandboxed plugins can't create collections or fields, write media in bulk or run long jobs, and they need Worker Loader. The sandbox would need capabilities far beyond what a plugin should have.
- **A separate import Worker.** It doesn't exist on Node, adds service-to-service auth and a second deploy, and runs into the same per-isolate memory limit.
- **Site packages only.** Converting everything offline removes in-site import code, but WordPress users lose the in-admin import, and package import needs an empty target.
- **Only make the existing registry public.** A smaller change, but sources would still depend on WordPress-specific routes and UI, and large imports would still depend on an open tab.

## Drawbacks

- One more package to install for WordPress migrations, and a deprecation period to maintain.
- The source contract and the site package SDK become public APIs that need versioning.
- Jobs add two system tables and a Workflow binding to the Cloudflare templates.
- Extracting about 10,500 lines risks behavior changes, which the moved tests have to catch.

## Open questions

1. Should the compatibility path auto-register the WordPress importer for one minor release or two?
2. Should Elementor ship inside `@emdash-cms/import-wordpress` or as `@emdash-cms/import-elementor`?
3. Should jobs reuse the site transfer operation tables instead of new import job tables?
4. Does the site package SDK need a "merge into existing site" mode before TYPO3 or Magento converters are useful, and if so, does that belong in this RFC?
