# @emdash-cms/registry-lexicons

## 0.6.0

### Minor Changes

- [#3171](https://github.com/emdash-cms/emdash/pull/3171) [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated schema, translation, public URL, and content revision discovery for plugins.
  
  Declare `schema:read` to list collection and field definitions through `ctx.schema`. Existing `content:read` access can inspect safe content identity, discover locale siblings with `getTranslations()`, and resolve published routes with `getPublicUrl()`. Public URL resolution follows the site's collection pattern, locale routing, and trailing-slash policy and returns `null` for content without a public route.
  
  Revision snapshots require the separate `content:revisions:read` capability because retained history can contain field values that an administrator removed later. This capability implies ordinary `content:read` access. Installation and plugin updates show both new authorities for consent, and the native, Cloudflare Worker Loader, and Node.js workerd runtimes expose the same methods.

- [#3184](https://github.com/emdash-cms/emdash/pull/3184) [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated redirect access for sandboxed plugins. Declare `redirects:read` to list redirect rules with cursor pagination and read a rule with an opaque `_rev`. Declare `redirects:write` to create, update, and delete redirect rules; write access implies read access and installation consent states that the plugin can change where visitors are sent.
  
  Redirect mutations use EmDash's redirect validation and cache invalidation path. Writes are serialized across runtimes so duplicate-source and loop validation use a consistent rule graph. The expanded redirect schema remains compatible with writes from previous host processes during rolling deployments. Loop validation runs when a rule is created or its source or destination changes; enabled-only updates retain the host API's existing behavior. Updates and deletes require the latest `_rev`, reject concurrent changes with `CONFLICT`, and do not let plugins set the host-owned automatic redirect marker. The Cloudflare Worker Loader and Node.js workerd runners expose the same API, and `createPluginRuntimeTestHost()` includes redirect fixtures and inspection for production-boundary tests.

- [#3170](https://github.com/emdash-cms/emdash/pull/3170) [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `comments:read` and `comments:moderate` for sandboxed plugins. `ctx.comments` can get, count, and cursor-page through non-trashed comments, and can change a comment between `approved`, `pending`, and `spam` when the caller supplies the status it previously observed.
  
  `comments:read` exposes comment bodies, author names and email addresses, pseudonymous IP hashes, user agents, and moderation metadata. It does not expose the linked EmDash user-account ID. `comments:moderate` implies that read access, and installation or an update that requests either capability requires operator consent.
  
  Status changes use the core moderation path. A stale expected status rejects with `COMMENT_STATUS_CONFLICT`, and an overlapping transition can reject with `COMMENT_MODERATION_IN_PROGRESS`; a successful transition runs `comment:afterModerate` once with the calling plugin's origin and preserves approval notifications. Hard deletion and bulk status replacement are not included.

- [#3251](https://github.com/emdash-cms/emdash/pull/3251) [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds explicit, consented access to selected unsaved content for sandboxed editor panels and actions.
  
  Plugins can request `admin.editor-draft:read` to receive extension-selected field values after an editor invokes them, and `admin.editor-draft:patch` to propose atomic whole-field `set` or `clear` operations. Patch access does not imply read access. Each extension must declare explicit collection scope and narrow its access to field slugs, translatable fields, or both.
  
  EmDash authenticates and authorizes the saved entry, reloads its schema and revision, validates snapshot and patch limits, and rejects stale or invalid responses. The admin shows a host-rendered before-and-after preview, applies accepted changes to the visible form, marks it dirty, and leaves saving to the editor. Panel load and ordinary typing do not expose draft data or invoke the plugin.
  
  `createPluginRuntimeTestHost()` now provides draft capture and host-validated patch application helpers for production-boundary plugin tests.

- [#3172](https://github.com/emdash-cms/emdash/pull/3172) [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds separate sandboxed-plugin capabilities for reading media bytes and editing media metadata.
  
  Declare `media:bytes:read` to use `ctx.media.readBytes()`. Reads are available only for ready media, default to a 10 MiB limit, enforce the caller's limit while consuming the storage stream, and cannot request more than 16 MiB. The result includes the content hash; ordinary `media:read` metadata excludes content hashes, storage keys, and author identity.
  
  Ready-media metadata URLs use an authenticated media ID route. Authenticated callers with the `media:read` permission can fetch the asset without receiving its storage key; logged-out requests are rejected before the route queries media.
  
  Declare `media:metadata:write` to use `ctx.media.updateMetadata()` for alt text, captions, and focal points. This capability cannot upload, replace, move, or delete media. It does not imply `media:read` or `media:bytes:read`.
  
  `@emdash-cms/plugin-test` also provides binary media fixtures and inspection through the runtime-backed host so plugin tests can exercise the production Worker Loader bridge.

- [#3194](https://github.com/emdash-cms/emdash/pull/3194) [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds separately consented publication and restore actions to native and sandboxed plugin contexts.
  
  Plugins with `content:publish` can read an entry with an opaque revision and publish, unpublish, schedule, or unschedule it through the same runtime behavior as REST and MCP. Each mutation requires the revision returned by the read or preceding action, and a plugin cannot recursively run the same action for the same entry. The capability implies `content:read` but not `content:write`.
  
  Plugins with `content:restore` can read and restore trashed entries without receiving ordinary content-read or write authority. Restore is revision-fenced and returns the next revision. Existing plugin installations receive neither capability unless a new version declares it and the administrator approves the expanded access.

- [#3185](https://github.com/emdash-cms/emdash/pull/3185) [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `hooks.content-policy:register` for sandboxed and native plugins that need to inspect and reject publication, scheduling, or unpublication without receiving content read, write, or publication-action access.
  
  Policy plugins can register `content:beforePublish`, `content:beforeSchedule`, and `content:beforeUnpublish`. Each event identifies the API, MCP, visual editor, plugin, scheduler, or system origin and includes the authenticated actor when one exists. Return `{ cancel: true, reason }` to reject the action with a stable error code. EmDash validates the reason as 1–500 plain-text characters. For allowed actions, the revision read before policy evaluation becomes the mutation precondition.
  
  Scheduled content runs `content:beforePublish` again when it becomes due. A policy rejection unschedules the entry, lists its public-safe reason and entry link on the dashboard, and avoids retrying the same permanent rejection on every scheduler tick. Successful rescheduling, publication, or deletion clears the record; administrators can dismiss stale records. `@emdash-cms/plugin-test` exposes stored scheduler rejections through `inspect.scheduledPolicyRejections()`.

- [#3169](https://github.com/emdash-cms/emdash/pull/3169) [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds the `taxonomies:write` sandboxed-plugin capability for creating taxonomy terms and adding or removing term assignments through `ctx.taxonomies`.
  
  Assignment methods accept term row IDs or translation-group IDs and apply idempotent deltas, so they do not replace existing assignments and concurrent additions are preserved. EmDash validates collection attachment, entry existence, term ownership, configured locales, translation identity, and hierarchy before changing taxonomy state. Sandboxed `createTerm()` rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. The capability implies `taxonomies:read` and requires renewed consent when an installed plugin first declares it.
  
  Existing REST and MCP term mutations also reject creating or updating a term with a parent in a non-hierarchical taxonomy. Callers that assign parents must mark the taxonomy as hierarchical before creating or reparenting terms.
  
  This release includes migration `082_taxonomy_translation_locale_unique`, which enforces one term per translation group and locale. If an existing database contains duplicate rows, the migration preserves them as independent term groups and copies their assignments before adding the unique index. It can restart safely after any completed statement.
  
  `@emdash-cms/plugin-test` adds taxonomy fixtures and an assignment inspector for production-boundary tests. Taxonomy definition management, assignment replacement, term updates, and term deletion remain unavailable to sandboxed plugins.

### Patch Changes

- [#3120](https://github.com/emdash-cms/emdash/pull/3120) [`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `registryLoader()` for reading the moderated EmDash plugin registry through Astro live content collections. Collection loads support free-text and exact publisher/package searches, capability filters, and limits. Single-entry loads resolve a publisher handle or DID and include the latest visible release when one exists.
  
  Registry searches recognize exact handles, DIDs, and identity/slug pairs. Package views include the publisher's current verified handle when available.

## 0.5.0

### Minor Changes

- [#3078](https://github.com/emdash-cms/emdash/pull/3078) [`befce6d`](https://github.com/emdash-cms/emdash/commit/befce6dcbbedcf2766d6540214a65f3bbb9e745a) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a fail-closed first-release exemption to the plugin registry's optional minimum release age policy. A package's first release can install immediately only when the aggregator reports exactly one retained release and confirms that it continuously observed the package's release history.
  
  Existing packages, backfilled packages, and packages with missing or incomplete history remain subject to the configured holdback. Deleted releases still count, and explicit publisher or package exemptions continue to work.

- [#2742](https://github.com/emdash-cms/emdash/pull/2742) [`4cc150e`](https://github.com/emdash-cms/emdash/commit/4cc150e931313644a96b796627e5ec74b46c0aec) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `moderation-manipulation` findings so labelers can distinguish direct attempts to bypass automated moderation from quoted or descriptive discussion of prompt injection.

## 0.4.0

### Minor Changes

- [#2765](https://github.com/emdash-cms/emdash/pull/2765) [`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates plugin publishing to host package bundles, icons, banners, and screenshots as blobs on the publisher's Personal Data Server by default. Run `emdash-plugin publish` from the plugin directory; the CLI builds the bundle, checks the stored OAuth grant, uploads the artifacts, and writes CID-bound checksums into the release record.

  Existing scripts can keep externally hosted package bundles with `emdash-plugin publish --url <https-url>`. The CLI still downloads that URL to validate and hash the served bytes. Listing images are uploaded as publisher blobs on both paths.

  The experimental aggregator release envelope replaces `mirrors` with typed `artifactCaches`. The field is optional during rolling upgrades, and updated clients treat an omitted field as an empty cache list. A record-scoped cache descriptor supplies its service endpoint; clients derive `/r/{did}/{collection}/{rkey}/{recordCid}/{blobCid}` so cache admission is bound to the exact release revision.

  Install and update verify raw cache, PDS, and external fallback bytes against the signed checksum and blob metadata. The authenticated image proxy may serve a transformed record-scoped cache rendition; if that cache is unavailable, it falls back to checksum-verified PDS or external bytes. Listing images remain capped at 1 MiB.

  Sites must upgrade EmDash before installing a release whose package artifact is available only as a PDS blob. Older EmDash versions require an external package URL.

  #### What should I do?

  Remove `--artifact-base-url` from publish scripts and stop pre-uploading listing images. The CLI rejects the removed option with migration guidance. Replace any experimental `releaseView.mirrors` access with `releaseView.artifactCaches ?? []`. If an existing granular login reports `MISSING_BLOB_SCOPE`, run `emdash-plugin logout` and log in again to grant `blob:application/gzip` and `blob:image/*`.

- [#2644](https://github.com/emdash-cms/emdash/pull/2644) [`6178888`](https://github.com/emdash-cms/emdash/commit/61788888bf5933e2a9ac310a931f1c241fa63878) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds shared, CID-bound plugin-listing moderation contracts for reducing signed AT Protocol labels and deciding which package-profile and release revisions are eligible for display.

  The registry Lexicons add experimental public assessment and policy queries. The contracts cover publisher-controlled listing metadata and displayed media; they do not assess plugin code.

## 0.3.0

### Minor Changes

- [#2067](https://github.com/emdash-cms/emdash/pull/2067) [`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds the `packageProfileExtension` lexicon and its generated types, plus a `provenance` reference field on the package release extension.

## 0.2.0

### Minor Changes

- [#1719](https://github.com/emdash-cms/emdash/pull/1719) [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260) Thanks [@swissky](https://github.com/swissky)! - Adds a `taxonomies:read` plugin capability with read-only taxonomy access: plugins that declare it get `ctx.taxonomies` to list taxonomy definitions (`getAll()`), fetch the terms of a taxonomy (`getTerms()`), and read the terms assigned to a content entry (`getEntryTerms()`) — in-process and in both sandbox runners.

## 0.1.1

### Patch Changes

- [#1447](https://github.com/emdash-cms/emdash/pull/1447) [`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `@atcute` peer dependency warnings on install ([#1435](https://github.com/emdash-cms/emdash/issues/1435))

  Installing EmDash pulled in mismatched `@atcute` package versions, so `pnpm install` / `npm install` reported unmet peer warnings for `@atcute/identity` and `@atcute/lexicons`. The bundled `@atcute` dependencies are now aligned on v2 and installs are clean. If your project also depends on `@atcute` packages directly, note they have moved to v2 (`@atcute/client` 5, `@atcute/lexicons` 2, `@atcute/atproto` 4, `@atcute/oauth-node-client` 2).

- [#1461](https://github.com/emdash-cms/emdash/pull/1461) [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.

## 0.1.0

### Minor Changes

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `RECORD_NSIDS` and `QUERY_NSIDS` const arrays alongside the existing `NSID` map. They enumerate the record-shaped and query-shaped lexicons in this package so consumers (e.g. tooling that builds OAuth `repo:` / `rpc:` scopes) can derive their list from the lexicon set instead of hand-rolling one that drifts.

### Patch Changes

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/registry-lexicons`: generated TypeScript types and runtime validation schemas for the EmDash plugin registry lexicons (`com.emdashcms.experimental.*`). EXPERIMENTAL — NSIDs and shapes will change while RFC 0001 is in flight; pin to an exact version.
