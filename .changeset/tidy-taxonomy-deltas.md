---
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
"emdash": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds the `taxonomies:write` sandboxed-plugin capability for creating taxonomy terms and adding or removing term assignments through `ctx.taxonomies`.

Assignment methods accept term row IDs or translation-group IDs and apply idempotent deltas, so they do not replace existing assignments and concurrent additions are preserved. EmDash validates collection attachment, entry existence, term ownership, configured locales, translation identity, and hierarchy before changing taxonomy state. Sandboxed `createTerm()` rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. The capability implies `taxonomies:read` and requires renewed consent when an installed plugin first declares it.

Existing REST and MCP term mutations also reject creating or updating a term with a parent in a non-hierarchical taxonomy. Callers that assign parents must mark the taxonomy as hierarchical before creating or reparenting terms.

This release includes migration `082_taxonomy_translation_locale_unique`, which enforces one term per translation group and locale. If an existing database contains duplicate rows, the migration preserves them as independent term groups and copies their assignments before adding the unique index. It can restart safely after any completed statement.

`@emdash-cms/plugin-test` adds taxonomy fixtures and an assignment inspector for production-boundary tests. Taxonomy definition management, assignment replacement, term updates, and term deletion remain unavailable to sandboxed plugins.
