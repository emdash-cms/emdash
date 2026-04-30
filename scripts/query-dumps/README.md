# Query dumps for the perf fixture

Tooling for slicing the per-route × phase query dumps captured by `scripts/query-counts-dump.mjs`. Useful when investigating where queries are coming from on a specific route — the catalogue this produced drove the perf reductions in PRs #838, #839, #840.

## Layout

- `sqlite/`, `d1/` — generated dump JSON, one file per route × phase. Gitignored. Regenerate with `scripts/query-counts-dump.mjs --target {sqlite|d1}`.
- `classification.{sqlite,d1}.md` — generated reports from `classify.mjs`. Gitignored — point-in-time snapshots that go stale on every code change.
- `classify.mjs <target>` — produces the classification table from the dumps.
- `cold-only.mjs` — diffs cold vs warm in the d1 dumps to surface the cold-isolate startup tax.
- `inspect-other.mjs <target> <class>` — prints distinct SQL for a class.

Each dump `*.json` is an array of `{ sql, params, durationMs, route, method, phase }`. `_all.json` is the un-grouped feed.

## Workflow

```
node scripts/query-counts.mjs --target sqlite           # build + seed + run main harness
node scripts/query-counts-dump.mjs --target sqlite      # capture per-query dumps
node scripts/query-dumps/classify.mjs sqlite            # write classification.sqlite.md
```
