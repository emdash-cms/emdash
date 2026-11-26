---
title: Built-in search on PostgreSQL
type: rfc
status: proposed
authors:
  - Hrishikesh Kokate (@hrishikesh-k)
champion: Hrishikesh Kokate (@hrishikesh-k)
sponsor: TBD
discussions:
  - https://github.com/emdash-cms/emdash/discussions/5138
created: 2026-11-26
---

# Built-in search on PostgreSQL

> **Draft.** This RFC still needs a Maintainer sponsor and an Ideas Discussion. A working prototype is already available; see [Verification](#verification).

## Summary

EmDash already has built-in search, but it's currently limited to SQLite, D1, and libSQL. PostgreSQL is also a supported database, yet sites using it can't use built-in search today. All search endpoints return `503 SEARCH_UNAVAILABLE`.

This RFC proposes adding PostgreSQL support without changing the existing search API or requiring sites to migrate to another database.

- **Opt-in per database.** Search can be enabled with `postgres({ search: true })`. Custom adapters can enable it by wrapping their dialect with `withPostgresSearch()`. Nothing changes for PostgreSQL sites that don't opt in.
- **Existing search API, unchanged.** `search()`, `searchCollection()`, suggestions, REST endpoints, field weights, title scope, and site imports continue to work as they do today. Queries retain the existing FTS5 syntax, including prefix terms, quoted phrases, and `AND`/`OR`/`NOT`/`NEAR` with the same precedence.
- **PostgreSQL-native indexing.** Each collection with search enabled gets its own index table containing a weighted `tsvector` column and a GIN index. Triggers keep the index in sync with content changes.

## Problem and user case

PostgreSQL is already a supported EmDash database, and it's available through several managed hosting providers. However, sites using it don't have built-in search.

I'm working on a Netlify adapter for EmDash, and Netlify Database uses PostgreSQL. That means search currently doesn't work there without patching EmDash itself.

There are a few alternatives, but none feels like a great fit for a CMS. An external search service means setting up another account, maintaining a sync pipeline, and paying for an additional service. A plugin also can't reuse EmDash's existing search API, admin interface, or import handling.

PostgreSQL already has full-text search built in, so supporting it directly in EmDash seems like a reasonable way to solve this without introducing another dependency.

## Example

A PostgreSQL site can enable search through the database configuration:

```js title="astro.config.mjs"
import { postgres } from "emdash/db";

export default defineConfig({
  integrations: [
    emdash({
      database: postgres({ connectionString: process.env.DATABASE_URL, search: true }),
    }),
  ],
});
```

Custom adapters can enable search by wrapping the dialect they return:

```ts title="src/db/netlify-postgres.ts"
import { withPostgresSearch } from "emdash/db";

export function createDialect(config) {
  return withPostgresSearch(new PostgresDialect({ pool: new Pool(config) }));
}
```

Once an editor enables search for a collection, the existing API can be used without any additional changes:

```ts
const { items } = await search("(apples OR pears) AND orchard", { collections: ["posts"] });
// Each item has a snippet with matched terms wrapped in <mark> tags.
```

## Goals

- Make built-in search available on PostgreSQL through the existing public API, REST endpoints, and admin controls.
- Keep query syntax and search results as close to SQLite as possible, and document any differences that PostgreSQL can't avoid.
- Leave SQLite, D1, libSQL, and PostgreSQL sites that haven't opted in completely unaffected, including their query counts.
- Keep search consistent when multiple server instances share the same database, such as autoscaled Node.js servers.
- Ensure site imports rebuild the search index on opted-in PostgreSQL sites instead of disabling search.

## Non-goals

- **Hyperdrive.** The Hyperdrive adapter builds its own dialect in `@emdash-cms/cloudflare`. It can adopt `withPostgresSearch()` in a follow-up.
- **The `trigram` tokenizer on PostgreSQL.** This requires the `pg_trgm` extension; see [Open questions](#open-questions).
- **Using the PostgreSQL index for the admin content list's `q` filter.** That filter continues to use its existing `LIKE` fallback.
- **Identical relevance scores across databases.** Search results should rank similarly, but the raw scores aren't comparable between databases.

## Detailed design

### Opting in

Search support will be exposed as a capability on the Kysely dialect adapter, following the same approach D1 uses for `compoundSelectLimit`.

Search is used across several parts of EmDash, including routes, seeds, imports, and the schema registry. These call sites only have access to a Kysely instance, so the dialect adapter is the common place they can all check whether search is supported.

- `PostgresSearchAdapter` (`{ readonly postgresSearch: true }`) and `searchBackend(db): "fts5" | "postgres" | null` will live in `database/dialect-helpers.ts`. SQLite-family databases return `"fts5"`, while PostgreSQL returns `"postgres"` only when its adapter explicitly declares the capability.
- `withPostgresSearch(dialect)` will be exported from `emdash/db`. It won't import `pg`, so adapters using other drivers can use it without introducing a dependency on the PostgreSQL package.
- `PostgresConfig` will gain `search?: boolean`, defaulting to `false`.

Everywhere that currently checks `isSqlite()` to determine search support will use `searchBackend()` instead.

If a database doesn't have a search backend, the behavior remains unchanged: search endpoints return `503 SEARCH_UNAVAILABLE`, with an error message explaining how to enable search.

### Index layout

Enabling search for a collection such as `posts` creates the following objects:

| Object | Purpose |
|---|---|
| Table `_emdash_fts_posts` | Stores `id text PRIMARY KEY`, `locale text`, one `text` column per searchable field, and `_emdash_document tsvector` (generated and stored). |
| Index `_emdash_fts_posts_doc_idx` | GIN index on `_emdash_document`. |
| Function `_emdash_fts_posts()` | A PL/pgSQL trigger function that keeps the index up to date. |
| Triggers on `ec_posts` | `_emdash_fts_insert`, `_emdash_fts_update`, and `_emdash_fts_delete`. |

Some details worth calling out:

- The index table stores extracted text, just like the FTS5 table does. Portable Text is reduced to the strings under `text`, `alt`, `caption`, and `code` keys, so structural JSON isn't indexed.
- Only rows with `deleted_at IS NULL` are indexed. The update trigger runs only when an indexed field, locale, or trash state changes, so saves that only update metadata don't trigger re-indexing.
- `_emdash_document` combines each field's `to_tsvector`, with field weights applied. The name can't conflict with a field slug because slugs can't start with `_`.
- Disabling search drops the function with `CASCADE`, which also removes its triggers, followed by the index table.
- PostgreSQL limits object names to 63 characters. Collections using search can therefore have slugs of up to 43 characters. Longer slugs will produce a clear error when search is enabled.

### Tokenizers

| `tokenize` | PostgreSQL text search configuration |
|---|---|
| `porter unicode61` (default) | `english` |
| `unicode61` | `simple` |
| `trigram` | Not supported; enabling search fails with a clear error |

### Queries

The public query syntax remains FTS5, so existing queries don't need to change.

- **Plain terms** match as prefixes, and all terms are required. For example, `hel wor` becomes `'hel':* & 'wor':*`.
- **Quoted phrases** match as phrases using `phraseto_tsquery`.
- **Operator queries** using uppercase `AND`, `OR`, `NOT`, and `NEAR` are handled by a small parser that follows FTS5's precedence, from tightest to loosest: adjacent terms, `NOT`, `AND`, then `OR`.

  `NOT` is binary, so `a NOT b` becomes `a & !b`. `NEAR(a b, N)` becomes `a & b`, with the distance ignored. A bare `NEAR` is treated as an ordinary word. Words ending in `*` are treated as prefixes.

  Malformed operator queries return no results, matching SQLite's behavior.

All user input is passed to PostgreSQL as a bound parameter inside quoted lexemes, preventing it from injecting tsquery operators.

Ranking uses `ts_rank` against the stored vector. Field weights map to PostgreSQL's four weight labels: up to four distinct weights are preserved relative to the highest weight, while any additional lower weights share label D at their average.

Title tiers, score normalization across collections, cursors, title scope, and locale filtering continue to work as they do on SQLite. Snippets are generated with `ts_headline` and passed through the existing snippet sanitizer.

### Concurrent servers

Search indexes need to remain consistent even when multiple server instances are working against the same database. This is especially important for rebuilds and initial fills, where concurrent operations could otherwise leave the index in an inconsistent state.

- **Rebuilds.** Creating, dropping, rebuilding, and filling an index all happen in a transaction that first acquires a per-collection advisory lock. PostgreSQL DDL is transactional, so a failed rebuild rolls back without affecting the previous index. Concurrent rebuilds of the same collection wait for one another rather than running simultaneously.
- **Fills.** Filling an index takes a `SHARE` lock on the content table for the duration of the transaction. Existing saves finish before the fill begins, while new saves wait until it commits. This prevents an edit or trash operation that happens during a fill from being overwritten by older content.

### Site imports

Imports populate the search index in batches ordered by content ID, using the same approach SQLite uses with rowid batches.

The import plan reports `search_unsupported` only when the target database doesn't have a search backend.

## Compatibility and migration

- **Additive changes only.** No core migrations are required. Index tables are created when an editor enables search and dropped when it's disabled.
- **Existing PostgreSQL sites.** Nothing changes until they opt in. If a collection already has search enabled in its stored configuration (for example, through a schema import), its index is built on the first search request after opting in, using the same repair mechanism SQLite already has.
- **Disabling search.** Search should be disabled on each collection before removing the database opt-in. Once the opt-in is removed, EmDash no longer manages those indexes, so any remaining tables and triggers will continue to run until they're manually removed.
- **Public API additions.** `PostgresConfig.search`, `withPostgresSearch()`, `PostgresSearchAdapter`, and `FTSManager.populateBatch()` are added. Existing signatures remain unchanged.
- **Ranking.** Raw `searchCollection()` scores use BM25 on SQLite and `ts_rank` on PostgreSQL. The documentation will clarify that scores aren't directly comparable across databases.

## Security and privacy

- **Identifiers.** DDL identifiers come from validated collection and field slugs. Text search configurations are selected from a fixed map and never from user input.
- **Query text.** Queries are passed as bound parameters, with terms converted into quoted lexemes. The operator parser only builds tsquery expressions from quoted lexemes and a fixed set of operators.
- **Snippets.** The existing sanitizer HTML-escapes snippet content, except for the `<mark>` tags used to highlight matches.
- **Privileges.** Enabling search creates tables, functions, and triggers at runtime, so the configured database role must have the required privileges. The documented role requirements already call for schema ownership. Trigger functions run with the privileges of the user executing the triggering operation (`SECURITY INVOKER`).
- **Authorization.** Authorization checks for enabling search, rebuilding indexes, and viewing stats remain unchanged.

## Performance

- **No impact on other sites.** SQLite and PostgreSQL sites that haven't opted in won't run any additional queries, including on logged-out requests.
- **Search requests.** Each search runs one statement per collection, as it does on SQLite. The index repair check runs once per server instance, also following the existing SQLite behavior.
- **Writes.** Saves that change indexed fields execute the trigger and update one index row. Metadata-only saves skip the index update.
- **Fills block saves.** Saves to a collection wait while its search index is being enabled or rebuilt. Imports hold the lock one batch at a time.
- **Storage.** Each collection with search enabled gets an additional table containing its extracted text and search vector.

## Failure handling

- A rebuild that fails partway through is rolled back as a whole. The previous index remains intact, or no index is left behind if one didn't exist. The existing repair check can rebuild an index that's missing or empty.
- Malformed queries return no results instead of raising an error.
- Missing privileges or collection slugs that exceed the supported length cause search enablement to fail with a clear error, without leaving partially created objects behind.
- If an import is interrupted during a fill, it can resume from its saved cursor.

## Verification

A working prototype is implemented in a fork ([implementation](https://github.com/hrishikesh-k/emdash/commit/2c5db560dd9831776b8feaefade2b97a5a35a36b), [follow-up](https://github.com/hrishikesh-k/emdash/commit/979b04c17b25b027a5fb50da22f939c5f769c27b)).

- **Integration tests on PostgreSQL 18.7** (`EMDASH_TEST_PG`) cover:
  - Indexing existing content when search is enabled.
  - Trigger synchronization through insert, edit, trash, restore, and delete.
  - Portable Text extraction.
  - Phrases, operators, precedence, `NEAR`, and malformed input.
  - Status and title scope, title-tier ranking, pagination, and weights.
  - Suggestions and disabling search, including verifying that no triggers are left behind.
  - Repairing a missing index, concurrent rebuilds, batched fills, and edits made during a fill.
- **Lock tests are load-bearing.** The concurrent-rebuild and edit-during-fill tests fail without the locks and pass with them.
- **Unit tests** cover weight mapping and the operator parser.
- **Query parity.** All 21 operator queries return the same results through SQLite FTS5 and the PostgreSQL translation.
- **Netlify Database.** Testing against a live Netlify Database (Neon, PostgreSQL 18.7) confirmed that the runtime role could create all the required objects. Without the locks, concurrent rebuilds failed and edits made during a fill could be lost. With the locks in place, both issues were resolved.
- **No regressions.** The existing SQLite search, transfer, and schema suites pass unchanged.

## Rollout and implementation

The implementation will be delivered in a single PR to `emdash`, following the existing prototype. It will include the adapter capability, PostgreSQL search backend, query translation, import batching, documentation updates (database, Node.js deployment, REST and API reference, and site transfer), and a minor changeset.

No additional feature flag is needed beyond the database-level opt-in.

## Alternatives

- **Enable search by default on all PostgreSQL sites.** Rejected because it would create tables and triggers for sites that don't use search. Enabling it also requires DDL privileges, which some database roles may not have.
- **Add the option to the `emdash()` integration instead of the adapter.** Rejected because search is called from several places that only have access to a Kysely instance. The adapter is the common point accessible to all of them.
- **Add a `tsvector` column to each `ec_*` table.** Rejected because this would modify content tables, require a migration, and tie search directly to the content schema.
- **Use `websearch_to_tsquery` for operator queries.** Rejected because it doesn't preserve parentheses or FTS5's `NOT` and `NEAR` semantics. For example, `(a OR b) AND c` could end up matching posts that don't contain `c`.
- **Use `pg_trgm` with `ILIKE`.** Rejected because substring matching doesn't provide stemming or relevance ranking, and it requires an extension.
- **Use external search through a plugin.** This remains an option for sites that need it, but it doesn't solve the need for built-in search on PostgreSQL when SQLite already has it.

## Drawbacks

- EmDash will need to maintain two search backends, and some behavior won't be identical between them: weight precision, `NEAR` distance, raw relevance scores, and tokenizer coverage.
- Enabling search requires runtime DDL privileges on the database role.
- Index fills temporarily block saves to the collection being indexed.
- Removing the database opt-in without first disabling search on the collections leaves triggers behind that EmDash no longer manages.

## Open questions

- **Title fallback parity.** PostgreSQL falls back to a `title` field for title tiers when the configured title field isn't searchable, while SQLite doesn't. Should both backends follow the same behavior?
- **Trigram.** Should `trigram` map to `pg_trgm` when the extension is available, or should it remain unsupported?
- **Hyperdrive.** Should the Hyperdrive adapter expose the same opt-in in a follow-up?
- **Content list filter.** Should the admin content list's `q` filter use the PostgreSQL search index, as it currently uses FTS5 on SQLite?
