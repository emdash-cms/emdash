# Blocks field release evidence

This record captures the acceptance evidence for the first release of the `blocks` field. The supported array ceiling remains 100 blocks.

## Rendering and query cost

The realistic homepage fixture is `packages/core/tests/repro/blocks-homepage.render.test.ts`. Its block values contain the page copy, links, Portable Text, image reference, repeated feature items, optional attribution, and order. The Astro components contain markup only.

The fixture renders 0, 1, 20, and 100 static blocks while a rejecting `fetch` spy remains unused. The 100-block case completes successfully.

Local Astro-container server-render measurements on 23 September 2026 used one initial render followed by 20 serial renders per case:

| Composition         | Initial render | Mean of 20 following renders |
| ------------------- | -------------: | ---------------------------: |
| Empty               |        0.22 ms |                      0.12 ms |
| Typical, 3 blocks   |        0.32 ms |                      0.18 ms |
| Maximum, 100 blocks |        0.50 ms |                      0.35 ms |

These measurements isolate component dispatch and rendering. They are regression evidence, not production latency estimates.

`pnpm query-counts` and `pnpm query-counts --target d1` both match the committed query-count and query-text snapshots. The SQLite homepage remains at six queries for cold and warm requests. The D1 homepage remains at 22 queries on a fresh isolate and 10 on the following request. Block count does not add a database query because `<Blocks>` receives its complete value and component map as props.

## Stored-data lifecycle

The integrated tests cover these boundaries:

- Content create, update, defaults, limits, retired types, stale revisions, explicit replacement, explicit version migration, duplication, and translation: `packages/core/tests/integration/content/blocks-content.test.ts`.
- Draft publish and revision restore with `_type`, `_version`, and `_key` preserved: `packages/core/tests/integration/content/blocks-content.test.ts`.
- Exact seed export and reapply, including retained versions and `currentVersion`: `packages/core/tests/unit/seed/blocks.test.ts` and `packages/core/tests/workerd/blocks-seed-d1.test.ts`.
- Backup snapshots containing the active pointer and every retained version: `packages/core/tests/integration/snapshot/snapshot.test.ts`.
- SQLite and D1 registry/content behavior, including inactive version activation and MIME batching: the block registry, block content, and workerd suites.
- Nested media normalization, MIME validation, occurrence identity, live/draft protection, repair fencing, and D1 limits: the media usage suites.

## Admin acceptance

The admin browser suite covers field configuration, block add/edit/duplicate/delete/collapse, pointer and keyboard reorder, inactive and retired badges, unsupported definitions, stable nested paths, Arabic right-to-left layout, and stale autosave completion after a nested edit and reorder.

Rendered verification used the Simple demo at a 1280 by 800 viewport in light theme. The fixture had Hero and Quote definitions, a Pages `layout` field, and a draft entry with both blocks. English and Arabic (`lang="ar"`, `dir="rtl"`) captures showed the same content and actions in the correct logical order.

## Upgrade boundary

The unknown-field protection shipped in EmDash 0.39. Sites upgrading from an older release must deploy 0.39 to every runtime before creating a `blocks` field. During a mixed deployment, a runtime that does not recognize a field type keeps reads available and refuses writes instead of coercing the stored value.

## Integrated suite

The final stack passes 7,403 core tests with 10 skipped, 107 workerd tests, and 2,476 admin browser tests. The workspace build, typecheck, type-aware lint, documentation build, SQLite query-count harness, and D1 query-count harness also pass.
