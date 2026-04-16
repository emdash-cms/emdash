# Emdash Perf Monitor

Tracks cold start / TTFB of the emdash demo site (`blog-demo.emdashcms.com`) over time from multiple regions.

## Architecture

- **Coordinator Worker** (`emdash-perf-coordinator`) owns the D1 database, cron trigger, queue consumer, HTTP API, and frontend dashboard. Served at `https://perf.emdashcms.com`.
- **4 Probe Workers** (`emdash-perf-probe-{use,euw,ape,aps}`) are placed near AWS regions via `placement.region`. They receive measurement requests from the coordinator via service bindings and run `fetch()` timing from their placed location.
- **D1 database** (`emdash_perf`) stores all measurements, tagged by `source`: `deploy` (queue-triggered, has SHA + PR) or `cron` (ambient baseline, untagged).
- **Cloudflare Queue** (`emdash-perf-deploy-events`) subscribes to `cf.workersBuilds.worker.build.succeeded` events. The coordinator consumes these, filters for the demo Worker, resolves the PR via the GitHub API, and runs a measurement. This is the primary attribution path.

All five Workers are built from this directory by the Cloudflare Vite plugin -- the coordinator entry is `src/index.ts` and the four probes are defined as `auxiliaryWorkers` in `vite.config.ts`.

## Measurement triggers

| Trigger               | When                               | `source` | SHA        | PR       |
| --------------------- | ---------------------------------- | -------- | ---------- | -------- |
| Queue event           | Every successful `blog-demo` build | `deploy` | from event | resolved |
| Cron (`*/30 * * * *`) | Every 30 min                       | `cron`   | null       | null     |

The queue is the deploy-attribution path. The cron is a safety net that fills gaps between deploys and catches regressions the queue might miss. There is no manual trigger -- testing the measurement path requires enqueuing a synthetic event or relying on the next cron tick.

## First-time setup

```bash
# 1. Create the D1 database and apply schema
pnpm db:create
# copy the database_id into wrangler.jsonc

pnpm db:migrate:remote

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

## Endpoints

| Endpoint       | Method | Auth | Purpose                                          |
| -------------- | ------ | ---- | ------------------------------------------------ |
| `/`            | GET    | none | Dashboard                                        |
| `/api/config`  | GET    | none | Target URL, available routes and regions         |
| `/api/summary` | GET    | none | Latest result per route/region + rolling medians |
| `/api/results` | GET    | none | Filtered historical results                      |
| `/api/chart`   | GET    | none | Time series for charting (with PR markers)       |

All endpoints are read-only. Measurements are driven by the queue consumer and cron, not HTTP.

## Schema changes

Edit `schema.sql`, then `pnpm db:migrate:remote`. Migrations are idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

## Types

Binding types come from `wrangler types`, which reads `wrangler.jsonc` and writes `worker-configuration.d.ts`. The generated file is committed so `tsc` doesn't need wrangler to run first.

Re-run after any binding change:

```bash
pnpm cf-typegen
```

## Operational notes

- **Filter worker name**: `DEMO_WORKER_NAME` in `src/routes.ts` must match the Worker name that serves blog-demo.emdashcms.com. Events for other Workers on the account are received and discarded. If blog-demo is ever renamed, update this constant.
- **PR lookup**: hits the public GitHub API unauthenticated (60 req/hr per IP). One call per deploy, so rate limits are a non-issue. If deploy rate ever gets anywhere near that, add a fine-grained PAT via `wrangler secret put GITHUB_TOKEN` and pass it in `src/github.ts`.
- **DLQ**: failed messages retry 3x, then go to `emdash-perf-deploy-events-dlq`. Check this periodically if deploy-attributed results stop appearing.
