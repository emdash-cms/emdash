# Emdash Perf Monitor

Tracks cold start / TTFB of the emdash demo sites over time from multiple regions. Two sites are measured in parallel so the effect of Astro's experimental cache provider can be compared head-to-head:

- `blog` -- `blog-demo.emdashcms.com` (baseline, catalog Astro)
- `cache` -- `cache-demo.emdashcms.com` (prerelease Astro with `cacheCloudflare()` enabled)

Each measurement row is tagged with a `site` column matching one of those ids.

## Architecture

- **Coordinator Worker** (`emdash-perf-coordinator`) owns the D1 database, cron trigger, queue consumer, HTTP API, and frontend dashboard. Served at `https://perf.emdashcms.com`.
- **4 Probe Workers** (`emdash-perf-probe-{use,euw,ape,aps}`) are placed near AWS regions via `placement.region`. They receive measurement requests from the coordinator via service bindings and run `fetch()` timing from their placed location.
- **D1 database** (`emdash_perf`) stores all measurements, tagged by `source`: `deploy` (queue-triggered, has SHA + PR) or `cron` (ambient baseline, untagged).
- **Cloudflare Queue** (`emdash-perf-deploy-events`) subscribes to `cf.workersBuilds.worker.build.succeeded` events. The coordinator consumes these, filters for the baseline demo Worker, resolves the PR via the GitHub API, and runs a measurement against every registered site. This is the primary attribution path; see `src/routes.ts` for the site registry.

All five Workers are built from this directory by the Cloudflare Vite plugin -- the coordinator entry is `src/index.ts` and the four probes are defined as `auxiliaryWorkers` in `vite.config.ts`.

## Measurement triggers

| Trigger                | When                               | `source` | Sites        | SHA        | PR       | On graph? | Persisted? |
| ---------------------- | ---------------------------------- | -------- | ------------ | ---------- | -------- | --------- | ---------- |
| Queue event            | Every successful `blog-demo` build | `deploy` | all          | from event | resolved | yes       | yes        |
| Cron (`*/30 * * * *`)  | Every 30 min                       | `cron`   | all          | null       | null     | yes       | yes        |
| `pnpm trigger`         | Private/quiet check (default)      | n/a      | all (or one) | n/a        | n/a      | no        | **no**     |
| `pnpm trigger --store` | Manual, persisted                  | `manual` | all (or one) | optional   | optional | **no**    | yes        |

The queue is the deploy-attribution path. The cron is a safety net that fills gaps between deploys and catches regressions the queue might miss.

`pnpm trigger` defaults to ephemeral: the probes run for real, but the coordinator skips the database insert and just returns the results to stdout. Use this for private/local checks you don't want on the dashboard.

Passing `--store` persists the run as `source=manual`. Stored manual runs land in the results table with a yellow `manual` badge but are excluded from the line chart, the summary cards, and the 7-day rolling medians so they don't skew the baseline.

## Manual triggers

```bash
# Default: run the probes, print results, record nothing.
# First invocation opens a browser for Cloudflare Access login; subsequent
# invocations reuse the token until the Access session expires.
pnpm trigger

# Persist the run as source=manual (appears in the results table)
pnpm trigger -- --store --note "pre-cold-start-fix baseline"

# Attach a SHA and/or PR number to a persisted run
pnpm trigger -- --store --sha 1a2b3c4 --pr 532 --note "PR #532 preview"
```

Auth is handled by a Cloudflare Access policy on `POST /api/trigger`

## First-time setup

```bash
# 1. Create the D1 database and apply the initial schema
wrangler d1 create emdash_perf
# copy the database_id into wrangler.jsonc

wrangler d1 execute emdash_perf --remote --file=schema.sql
pnpm db:migrations:apply  # any incremental migrations on top

# 2. Create the deploy events queue and DLQ
wrangler queues create emdash-perf-deploy-events
wrangler queues create emdash-perf-deploy-events-dlq

# 3. Build and deploy all 5 Workers
pnpm deploy

# 4. Subscribe the queue to Workers Builds events.
# (No wrangler command for this yet -- use the CF dashboard or API:
# https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/)
# Source: Workers Builds
# Events: build.succeeded (at minimum)
# Queue: emdash-perf-deploy-events

# 5. (Optional, to enable manual triggers) Add a Cloudflare Access policy
# on POST /api/trigger. See "Access setup" above.
```

No secrets required. PR lookup hits the public GitHub API unauthenticated
(60 req/hr limit, plenty for one lookup per deploy).

## Deploy order

The coordinator's service bindings require the probes to exist first. `pnpm deploy` handles this: it builds, deploys all 4 probes, then deploys the coordinator.

## Dev

```bash
pnpm dev  # Vite dev server, all 5 Workers via Miniflare
```

Open `http://localhost:5173` for the dashboard. API is at `/api/*`. Queue events can't be exercised locally without manual message publishing -- rely on the live environment or the next cron tick to verify the measurement path.

Local manual trigger (no Access locally):

```bash
curl -sS -X POST http://localhost:5173/api/trigger \
  -H 'content-type: application/json' \
  -d '{"note":"local test"}'
```

## Endpoints

| Endpoint       | Method | Auth      | Purpose                                           |
| -------------- | ------ | --------- | ------------------------------------------------- |
| `/`            | GET    | none      | Dashboard                                         |
| `/api/config`  | GET    | none      | Target URL, available routes and regions          |
| `/api/summary` | GET    | none      | Latest result per route/region + rolling medians  |
| `/api/results` | GET    | none      | Filtered historical results                       |
| `/api/chart`   | GET    | none      | Time series for charting (with PR markers)        |
| `/api/trigger` | POST   | CF Access | Run an ad-hoc measurement, tagged `source=manual` |

All GET endpoints are read-only. `POST /api/trigger` is the only state-changing endpoint and is expected to be protected by a Cloudflare Access policy at the edge.

## Schema changes

D1's native migrations are wired up (`migrations_dir` in `wrangler.jsonc`).

```bash
pnpm db:migrations:list    # show pending migrations
pnpm db:migrations:apply   # apply pending migrations
pnpm db:migrations:create  # scaffold a new migration file
```

`schema.sql` is the desired end state for fresh installs only. For incremental changes on an existing database, add a file under `migrations/` and apply it -- don't rely on editing `schema.sql` to take effect.

## Types

Binding types come from `wrangler types`, which reads `wrangler.jsonc` and writes `worker-configuration.d.ts`. The generated file is committed so `tsc` doesn't need wrangler to run first.

Re-run after any binding change:

```bash
pnpm cf-typegen
```

## Operational notes

- **Trigger worker name**: `TRIGGER_WORKER_NAME` in `src/routes.ts` is the Worker whose `build.succeeded` event drives deploy-attributed runs. Events for any other Worker are discarded (the cron job still measures every site on its own schedule). Since every registered site rebuilds from the same main-branch commit, one event triggers a measurement for all of them. If the baseline demo is ever renamed, update this constant.
- **Adding a site**: add an entry to `SITES` in `src/routes.ts` with a stable `id` (stored in `perf_results.site`), `targetUrl`, and Worker name. Existing rows continue to use their recorded site id.
- **PR lookup**: hits the public GitHub API unauthenticated (60 req/hr per IP). One call per deploy, so rate limits are a non-issue. If deploy rate ever gets anywhere near that, add a fine-grained PAT via `wrangler secret put GITHUB_TOKEN` and pass it in `src/github.ts`.
- **DLQ**: failed messages retry 3x, then go to `emdash-perf-deploy-events-dlq`. Check this periodically if deploy-attributed results stop appearing.
