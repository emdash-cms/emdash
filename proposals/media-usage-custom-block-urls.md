---
title: Track media URLs in custom Portable Text blocks
type: feature-plan
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
discussion: null
created: 2026-10-11
---

# Track media URLs in custom Portable Text blocks

## Problem and user case

The Media Library **Used in** tab does not list a file that is used only inside a custom Portable Text block, such as a plugin's block. It shows **No tracked references found** for that file, and an editor who trusts that result can delete a file a published page still shows. [#3208](https://github.com/emdash-cms/emdash/issues/3208) reports this for gallery and video-poster images in a site's own blocks. [#3413](https://github.com/emdash-cms/emdash/pull/3413) fixed the site-settings part of that issue and left custom blocks out.

Custom blocks often refer to library files by URL. The admin's Block Kit `media_picker` element stores `/_emdash/api/media/file/<storage key>` for a library file, and the site in that issue stores the file's public URL in its own blocks. The usage extractor reads only image, video and gallery blocks in Portable Text, and it ignores URL strings even in fields it does read. The Media Library guide documents this limit.

## Proposed behavior

When EmDash indexes an entry, it also looks at every string inside a custom block, except in text blocks nested in it. A string counts as a reference to a library file when it is exactly that file's URL in one of these forms:

- the internal file route, `/_emdash/api/media/file/<storage key>`;
- the URL that the configured storage returns for the file's storage key. `local()` returns `<baseUrl>/<key>`. `s3()` and the R2 binding return `<publicUrl>/<key>` when `publicUrl` is set, and the internal file route otherwise.

The match is on the whole string. A URL with a query string or fragment, a URL on another host, a path inside a longer text, and a percent-encoded key do not match. The indexer takes the part of a string after its last `/` as a candidate storage key, and keeps the candidate only when the string equals the internal file route or the storage URL for that key. It then looks the remaining candidates up in the media table, so a string counts only when its key belongs to a library file.

Matched references appear in **Used in** like any other content reference. The result names the entry and the field that contains the block. In `GET /_emdash/api/media/{id}/usage`, the occurrence has the field's slug, a field path to the string, and the existing reference type for the file's kind:

```json
{
	"fieldSlug": "content",
	"fieldPath": "content[3].items[0].imageUrl",
	"occurrenceIndex": 0,
	"referenceType": "portable_text_image"
}
```

Image files use `portable_text_image` and video files use `portable_text_video`. Files of other kinds are not matched in this plan.

A custom block is a block in a Portable Text value whose `_type` the extractor does not already read: anything other than `block` (text), `image`, the core `video` block and `gallery`. This covers Portable Text fields at the top level and inside `blocks` fields.

For text, rich text nested inside a custom block is treated exactly like rich text at the top level of the field: text blocks (`_type: "block"`) are never searched, at any depth, so a link to a file in body text is not counted wherever that text sits. Today a plugin block's editing form has no rich-text field, so only data written outside that form, through the API, an import or a seed, or by a site's or plugin's own code, can put a text block inside a custom block. That changes if [#2674](https://github.com/emdash-cms/emdash/pull/2674), an open pull request that adds `portable_text` and `block_list` Block Kit fields, lands.

## Goals

- List an image or video that a custom block refers to by its exact library URL in **Used in**, with the entry and field.
- Count a URL only when it names an existing library file exactly.
- Keep logged-out page renders at their current query count.
- Keep the usage API response shape and the index tables unchanged.

## Non-goals

- Matching URLs inside longer strings, HTML, Markdown or text-block links.
- Matching files other than images and videos. That needs a new `referenceType` value, which is a change to the public API.
- An API for plugins or sites to declare which values hold media.
- Reading `{ _type: "image", asset }` objects nested inside custom blocks.
- Rewriting stored URLs or changing what `media_picker` stores.
- URLs that a `media_picker` in a plugin field widget stores in a field outside Portable Text.

## Interfaces and compatibility

**Usage API.** The response shape and the `referenceType` values stay the same. Existing values gain one more source, with field paths that point into a custom block. The admin shows the field's label, so the **Used in** list needs no change. Its empty-state note, which says custom rich text blocks aren't checked, is reworded to match the tracked references.

**Storage in the indexer.** Matching the public URL needs the configured storage. Today the indexing code receives only the database. The plan passes an optional URL resolver, built with the existing `createPublicMediaUrlResolver(storage)`, through the internal indexing functions from the places that index content: the runtime after a content write, the media usage progress and repair routes, the `media_usage_repair` MCP tool, and the development setup bypass. Without a resolver, only the internal file route matches. `handleMediaUsageRepair`, which the `emdash` package exports and the playground initializer calls, keeps its signature and matches the internal route only. The repair route and the MCP tool call an internal variant that takes the resolver.

**Stored data.** No migration. Content is not changed. New occurrences go into `_emdash_media_usage` with existing columns and values.

**Existing indexes.** Indexes built before this change can miss these references while reporting complete coverage. The plan raises `CONTENT_SOURCE_SCHEMA_VERSION` from 2 to 3, as the gallery fix did, so every collection's coverage reads as stale until it is rebuilt. On current `main` the maintenance step does not rebuild a complete index from an older version: the settings page shows **Needs attention** and points to the recovery API. An administrator rebuilds with `POST /_emdash/api/admin/media-usage/repair`. The changeset states this.

**Performance.** Lookups happen only while indexing: after content writes and in the authenticated maintenance and repair requests. Logged-out page renders do not index content, so they gain no query. For each batch of entries that the indexer loads together, it collects the candidate storage keys and resolves them with one `SELECT id, storage_key, mime_type FROM media WHERE storage_key IN (...)`. A batch with no candidates runs no extra query. A batch stops taking entries once its distinct candidate keys would exceed `SQL_BATCH_SIZE` (50), so a batch normally runs one lookup. Only a single entry with more than 50 distinct candidate keys runs more, in chunks of 50. The query uses `idx_media_storage_key` and is the same on SQLite, D1 and PostgreSQL.

**Documentation.** The Media Library guide lists exact library URLs of images and videos in custom blocks among the tracked references, and its caution keeps naming what stays untracked: other URL forms, other file kinds, generated HTML and custom code. The REST API reference, which says usage does not include custom Portable Text blocks, changes the same way.

## Errors and edge cases

- **False positives.** A string matches only when it equals a library file's URL in full, so the indexer counts a file only where the content names that exact file. Counting too much makes deletion more cautious, so a matching string in a field the template never renders still counts.
- **Keys.** Candidate keys must match the storage-key pattern already used for public URL rewriting (`[A-Za-z0-9._-]+`), so a candidate key with `?`, `#` or `%` is skipped before the lookup. The media upload routes take a key's extension from the uploaded file name without checking it, so a key can fall outside the pattern, for example when the extension contains a space. The URLs of such a file do not match.
- **Several rows with one key.** The storage key column is indexed but not unique, and the usage table allows one row per field path and occurrence index in an entry. Every matching row counts as used, so each one gets its own occurrence index under the same field path.
- **Upload status.** ID references are indexed without checking the media row's status. URL matches follow the same rule, so a pending or failed row with a matching key counts.
- **Storage configuration changes.** A match uses the storage configuration at index time. After `publicUrl` changes, strings that hold the old public URL stop matching when their entry is next indexed. The internal file route keeps matching.
- **Storage errors.** If the resolver throws for a key, as the playground storage does for unknown keys, the string can still match the internal file route, and the rest of the entry is indexed.
- **Budgets.** The lookups count toward the maintenance step's query budget like any other indexing query. Sites with many library URLs in custom blocks index in smaller batches and need more steps.
- **Drafts.** Draft revision data is matched the same way, so the draft overlay source lists references that exist only in the draft.

## Verification

Unit tests for the extractor:

- a custom block with `imageUrl: "/_emdash/api/media/file/<key>"` yields a candidate;
- a nested gallery of items with absolute public URLs yields one candidate per item when the resolver returns that public URL;
- `{ _type: "image", asset: { _ref } }` and `{ provider: "local", id }` nested in a custom block yield none;
- a text block nested in a custom block whose span text or link `href` is exactly a library URL yields none;
- a text block whose span text is exactly a library URL, a URL on another host, a URL with a query string and a percent-encoded key yield none.

Integration tests with `describeEachDialect`, using real media rows and a real `local()` storage with an absolute `baseUrl`:

- internal route and public URL matches produce `portable_text_image` or `portable_text_video` occurrences with the expected field path;
- a key that is not in the library, a URL on another host and a PDF produce nothing;
- two media rows with one storage key produce two occurrences under one field path;
- a draft-only reference appears in the draft overlay source;
- a batch with up to 50 distinct candidate keys runs one lookup, a batch with none runs no lookup, and a batch stops taking entries before it would exceed 50 keys;
- an index written at schema version 2 reads as stale, and repair brings it to complete.

The query-count snapshots stay unchanged for logged-out routes. A manual check adds a test plugin block with a `media_picker` field, picks an image, publishes, and confirms that the image's **Used in** tab lists the entry.

## Open questions

- A caller of the exported `handleMediaUsageRepair` gets no public-URL matches, so a repair through it drops those references until the entry is next saved or repaired through the route. The playground is unaffected because its storage returns the internal route. Giving the export an optional resolver argument would close the gap, but it adds an option to a public API, which the README lists as an RFC trigger.
- Should the maintenance step rebuild indexes from an older schema version on its own instead of requiring the repair call? That gap already exists for indexes from before the gallery fix.
- Should the absolute form of the internal file route (`https://example.com/_emdash/api/media/file/<key>`) match when the site URL is configured?
- Should links in text blocks (`markDefs` hrefs) be matched under the same exact-URL rule? One answer covers text blocks at every depth, including those nested inside custom blocks.
