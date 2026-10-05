---
rfc: 0003
title: Plugin Jobs — bounded, resumable background work for sandboxed plugins
status: Draft
authors:
  - Christian (@chrmoller)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/3869
created: 2026-10-05
---

# RFC: Plugin Jobs — bounded, resumable background work for sandboxed plugins

# Summary

Sandboxed plugins run under hard per-invocation limits. On Cloudflare, an invocation may make **10 host calls** (storage, KV, settings, `ctx.http`). Some plugin operations do work proportional to their input: importing 500 products, committing stock for a 30-line order, re-indexing a collection. Today those operations cannot complete inside the sandbox, and nothing in EmDash helps a plugin split them up.

This RFC proposes **Plugin Jobs**: a host-owned job runner that executes long-running plugin work as a sequence of bounded, resumable steps. A plugin declares job types in its manifest and implements one step handler per type. It enqueues work with `ctx.jobs.create()`. The host stores job state, schedules each step as a fresh sandbox invocation with a fresh budget, persists the plugin-returned cursor between steps, retries failed steps with backoff, and shows progress in the admin. The plugin keeps all business logic; the host keeps all orchestration.

The design is additive and opt-in. It runs on Cloudflare (Queues-backed, with a cron-driven fallback) and on Node (database-backed), and is available to native plugins with the same API.

# Example

## Before: work proportional to input fails in the sandbox

```ts
// src/plugin.ts — a sandboxed import route
const plugin: SandboxedPlugin = {
	routes: {
		"products/import": {
			methods: ["POST"],
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const rows = parseCsv(routeCtx.input);
				for (const row of rows) {
					// ≥1 host call per row. Row 11 throws:
					// "Too many subrequests by single Worker invocation."
					await ctx.storage.products.put(row.sku, toProduct(row));
				}
				return { ok: true, imported: rows.length };
			},
		},
	},
};
```

## After: the route enqueues a job; the host drives it in bounded steps

```jsonc
// emdash-plugin.jsonc
{
	"jobs": {
		"product-import": { "maxAttempts": 5, "concurrency": 1 },
	},
}
```

```ts
// src/plugin.ts
const plugin: SandboxedPlugin = {
	routes: {
		"products/import": {
			methods: ["POST"],
			permission: "plugins:manage",
			// Plugin storage values are capped at 1 MiB, so one staged upload must fit in one document.
			request: { body: "text", maxBytes: 512 * 1024 },
			handler: async (routeCtx, ctx) => {
				// Stage the upload in plugin storage (one call), then enqueue (one call).
				const uploadId = crypto.randomUUID();
				await ctx.storage.uploads.put(uploadId, { csv: routeCtx.input });
				const job = await ctx.jobs.create("product-import", { uploadId });
				return { ok: true, jobId: job.id };
			},
		},
	},

	jobs: {
		// Called once per step. Each call is a fresh invocation with a fresh budget.
		"product-import": async (step, ctx) => {
			const { uploadId } = step.job.input as { uploadId: string };
			const offset = (step.cursor as number | null) ?? 0;
			const rows = parseCsv((await ctx.storage.uploads.get(uploadId))!.csv); // 1 call

			// One putMany is one host call. Stay under D1's bound-parameter limit.
			const batch = rows.slice(offset, offset + 20);
			await ctx.storage.products.putMany(batch.map((r) => ({ id: r.sku, data: toProduct(r) }))); // 1 call

			const next = offset + batch.length;
			return next >= rows.length
				? { done: true, progress: { processed: next, total: rows.length } }
				: { done: false, cursor: next, progress: { processed: next, total: rows.length } };
		},
	},
};
```

The admin shows the job under **Extensions → Jobs** with its progress (`140 / 500`), state, attempts, and Retry/Cancel actions. The route returns immediately with a `jobId` the plugin's own UI can poll through `ctx.jobs.get()`.

## The case that motivated this: committing stock after payment

```
POST webhooks/stripe        (sandboxed route, ~4 host calls)
  ├─ dedupe the event          (create-only key)
  ├─ mark the order paid       (compare-and-set)
  └─ ctx.jobs.create("stock-commit", { orderId }, { key: orderId })
                 │
                 ▼  host-owned queue
       step 1: lines 1–8    (fresh invocation, ≤10 host calls)
       step 2: lines 9–16   (fresh invocation, ≤10 host calls)
       step 3: lines 17–21  → { done: true }
```

The webhook acknowledges Stripe quickly. Stock bookkeeping stays inside the sandbox, and a 50-line order no longer needs 50 host calls in one invocation.

# Background & Motivation

## The limits are real and small

`@emdash-cms/cloudflare` creates each sandboxed plugin as a Worker Loader dynamic worker with these defaults (`src/sandbox/runner.ts`, `DEFAULT_LIMITS`):

| Limit | Default | Enforcement |
|---|---|---|
| CPU | 50 ms | Worker Loader |
| Subrequests | 10 | Worker Loader, documented in `WorkerLoaderLimits` as "fetch/service-binding calls" |
| Wall time | 30 s | runner `Promise.race` |

The host constructs the runner without passing limits (`createSandboxRunnerOptions` in `emdash-runtime.ts`), so every sandboxed plugin gets these defaults. Each `ctx.storage`, `ctx.kv` and settings call crosses the `PluginBridge` loopback service binding. Cloudflare's Service Bindings documentation states that "each request to a Worker via a Service binding counts toward your subrequest limit", and that "a single request has a maximum of 32 Worker invocations, and each call to a Service binding counts towards this limit."

We measured this on a deployed EmDash 1.1.0 site (Workers Paid, D1, Worker Loader) running a purpose-built probe plugin:

| Measurement | Result |
|---|---|
| Sequential `ctx.storage` calls in one invocation | 10 succeed; the 11th throws `Too many subrequests by single Worker invocation` |
| Sequential `ctx.kv` calls | Identical: 10 succeed, the 11th throws |
| 9 `get` calls plus 1 `getMany` of 50 ids | Completes. A batch call costs one subrequest |
| Largest `getMany` | 95 ids succeed; 99 fail with `D1_ERROR: too many SQL variables` (D1's bound-parameter limit) |
| Pure CPU loop | ~1.26 s of work succeeds; ~2.19 s fails with `Worker exceeded CPU time limit`. In practice the binding constraint is subrequests, not CPU |

Batching helps, but only up to a point. There is no batch form of `compareAndSet` or `updateIf`, so any operation that must change N independent documents atomically per document costs N calls. And a single `putMany` is bounded by the database's parameter limit.

## Real plugins hit this immediately

We are building a sandboxed commerce plugin on EmDash, starting from an existing open-source commerce codebase that already runs in-process on `ctx.storage`. In its sandbox test harness we counted bridge calls per request:

| Request | 1 line | 3 lines | 5 lines | 10 lines |
|---|---|---|---|---|
| Cart: add line | 24–33 | | | |
| Checkout summary | 9 | 15 | 21 | 36 |
| Checkout place (+1 Stripe call) | 24 | 33 | 43 | 68 |
| Stripe settle webhook | 21 | 35 | 49 | 84 |

Much of that can be designed down: batch reads, fewer index documents. But some work is intrinsically proportional to the input, and no storage layout makes it constant:

- committing or releasing one stock hold per order line;
- importing a catalogue or migrating data;
- re-indexing content for search, or rebuilding a feed;
- sending a newsletter to N subscribers through `email:send`;
- reconciling N orders against a payment provider.

None of these is specific to commerce. Any plugin that processes a list hits the same wall.

## What plugins can do today, and why it isn't enough

The only background primitive is cron (`src/plugins/cron.ts`). A plugin can schedule one-shot or recurring tasks with `ctx.cron.schedule()`, and the `CronExecutor` invokes the plugin's `cron` hook. As a substrate for chunked work it has real gaps:

- **Throughput.** On Cloudflare a tick comes from the Worker's `scheduled()` handler, which the starter template runs once a minute. Each tick claims at most 10 due tasks and invokes them sequentially. A plugin chaining one-shot tasks advances each job by one step per minute.
- **Every step spends the plugin's own budget on bookkeeping.** The plugin has to read and write its own cursor and progress in `ctx.storage`, which costs 2 of its 10 calls on every step.
- **Naive retries.** A failed task is reset to idle and retried on the next tick: no attempt count, no backoff, no terminal failure state.
- **No visibility.** Operators cannot see progress, failures or stuck work, and cannot retry or cancel.

The remaining workaround, a plugin calling its own public route over `ctx.http` to get a fresh invocation, needs network authority to its own origin, exposes an internal endpoint publicly, and has no retry or ordering semantics. Plugins should not need it.

# Goals

- A sandboxed plugin can complete work of any size, as long as each step fits the invocation limits.
- Each step runs as a **fresh invocation with the full budget**. Job bookkeeping (state, cursor, attempts, progress) is done by the host and costs the plugin no host calls.
- Steps of one job run **strictly in order**, one at a time. Delivery is **at least once**, and the contract says so.
- Failed steps are **retried with backoff** up to a declared limit, then the job is marked **failed**, visible and retryable.
- Operators can see, retry and cancel jobs in the admin.
- Plugin authors can test jobs locally, including crash-and-replay, with `@emdash-cms/plugin-test`.
- **Runner parity:** the same plugin code and semantics on Cloudflare and Node, sandboxed and native.
- **Additive:** no change for plugins that don't declare jobs.

# Non-Goals

- **Raising or configuring sandbox limits.** That is a separate, complementary discussion. Jobs exist so that plugins can stay within the limits.
- **Multi-document transactions or batch compare-and-set.** These would reduce the number of steps a job needs, but they are a storage RFC.
- **Exactly-once execution.** The design is at-least-once with idempotent steps, which is the honest guarantee every practical queue offers.
- **A general workflow engine:** DAGs, fan-out/fan-in, human approval steps. See Future Possibilities.
- **Replacing cron.** Cron stays the primitive for time-based schedules.
- **Cross-plugin jobs.** A plugin can only create, read and cancel its own jobs.

# Prior Art

- **WooCommerce Action Scheduler** (WordPress). It exists for exactly this problem in the ecosystem EmDash positions itself against: WP-Cron and request time limits made large operations unreliable, so WooCommerce runs imports, subscription renewals and webhook fan-out as batched, logged, retryable "actions" with an admin screen (Tools → Scheduled Actions). This RFC adopts its operator-facing model (a list of jobs with state, attempts and logs) and its batch-per-invocation execution.
- **Laravel queues and job batches; Sidekiq.** These established the at-least-once plus idempotent-handler contract, exponential backoff with a terminal failed state, and per-queue concurrency. We follow the same contract.
- **Shopify bulk operations.** An asynchronous job handle replaces an unbounded synchronous request, and clients poll for completion. This is the same shape as `ctx.jobs.create()` and `ctx.jobs.get()`.
- **Cloudflare Queues and Workflows.** Queues give at-least-once delivery, retries and per-message consumer invocations, which is a natural Cloudflare transport for steps. Workflows give durable steps and are discussed under Alternatives.
- **EmDash cron** (`CronExecutor`, `CronScheduler`). The host already claims due work from the database, invokes plugin hooks and recovers stale locks (`STALE_LOCK_MINUTES`). The Node and fallback executors in this RFC reuse that machinery.

# Detailed Design

## Concepts

- **Job type:** a name declared in the plugin manifest, bound to one step handler.
- **Job:** one unit of work of a given type, with an immutable `input` and a host-owned `cursor`.
- **Step:** one invocation of the step handler. It receives the job and the cursor, does bounded work, and returns the next cursor or `done`.
- **Executor:** the host component that claims due steps, invokes the plugin, records results and schedules the next step.

## Manifest

```jsonc
// emdash-plugin.jsonc
{
	"jobs": {
		"<type>": {
			"maxAttempts": 8,       // per step; default 5, max 25
			"concurrency": 4,       // concurrent jobs of this type; default 1
			"retention": "7d",      // keep terminal jobs this long; default 7d, max 90d
		},
	},
}
```

The manifest schema (`manifest-schema.ts`, `@emdash-cms/plugin-types`) gains an optional `jobs` record. The plugin CLI carries it into the bundle manifest, the registry artifact and the generated descriptor, as it does for `routes`. Job type names follow route-name rules. A job type declared without a matching handler, or a handler without a declaration, fails the build.

## Plugin API

```ts
// emdash/plugin
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JobsAccess {
	/**
	 * Enqueue a job. With `key`, creation is idempotent per (plugin, type, key):
	 * a second call returns the existing job with `created: false`.
	 */
	create(
		type: string,
		input: JsonValue,
		options?: { key?: string; delaySeconds?: number },
	): Promise<{ id: string; created: boolean }>;
	get(id: string): Promise<JobInfo | null>;
	/** Cooperative: no further steps are scheduled. Returns false if already terminal. */
	cancel(id: string): Promise<boolean>;
	list(options?: {
		type?: string;
		state?: JobState;
		limit?: number; // default 50, max 100
		cursor?: string;
	}): Promise<{ items: JobInfo[]; cursor?: string }>;
}

export type JobState = "queued" | "running" | "retrying" | "succeeded" | "failed" | "cancelled";

export interface JobInfo {
	id: string;
	type: string;
	state: JobState;
	key: string | null;
	progress: JobProgress | null;
	step: number; // completed steps
	attempt: number; // attempts of the current step
	lastError: string | null; // redacted message of the last failed attempt
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	result: JsonValue | null; // set when succeeded
}

export interface JobProgress {
	processed: number;
	total?: number;
	message?: string; // ≤ 200 chars, shown in the admin
}

export interface JobStep<TInput = JsonValue, TCursor = JsonValue> {
	job: { id: string; type: string; input: TInput; key: string | null; createdAt: string };
	cursor: TCursor | null; // null on the first step
	step: number; // 0-based index of this step
	attempt: number; // 1-based attempt of this step
}

export type JobStepResult<TCursor = JsonValue> =
	| { done: false; cursor: TCursor; progress?: JobProgress; delaySeconds?: number }
	| { done: true; progress?: JobProgress; result?: JsonValue };

export type JobHandler = (step: JobStep, ctx: PluginContext) => Promise<JobStepResult>;

export interface SandboxedPlugin {
	// ...existing hooks, routes, mcp
	jobs?: Record<string, JobHandler>;
}

export interface PluginContext {
	// ...existing
	jobs: JobsAccess;
}
```

`ctx.jobs` is available in routes, hooks, cron and job steps. Each `ctx.jobs.*` call is one bridge call and counts toward the invocation's budget like any other host call. The job's own bookkeeping between steps does not.

## Step contract

1. The host invokes the handler with the job, the last committed cursor, and the step and attempt numbers.
2. The handler does a bounded amount of work and returns `{ done: false, cursor }` to continue, or `{ done: true }` to finish.
3. **Only a returned result commits.** The host persists the new cursor and progress, then schedules the next step. If the handler throws, exceeds a limit, or the invocation is lost, the cursor is unchanged and the same step is retried.
4. **Steps are at-least-once.** A step can be re-run with the same cursor after it has already done some or all of its work: the invocation may die after the plugin's writes but before the host records the result. Handlers must be idempotent with respect to their cursor. The documentation will show the standard patterns: compare-and-set guards, create-only keys, and deterministic ids derived from the job id and cursor.
5. **Ordering.** At most one step of a given job runs at a time, and steps run in cursor order. Different jobs run concurrently up to the declared `concurrency` and the host caps.
6. `delaySeconds` on a non-final result defers the next step (for example to respect a third-party rate limit). It is capped at 1 hour.

Limits enforced by the host:

| Item | Limit |
|---|---|
| `input` | 256 KiB serialized JSON |
| `cursor` | 64 KiB serialized JSON |
| `result` | 64 KiB serialized JSON |
| Steps per job | 10,000 (a runaway guard). Exceeding it fails the job with `STEP_LIMIT` |
| Non-terminal jobs per plugin | 1,000. `create` rejects with `JOB_QUOTA` beyond this |
| Job lifetime | 7 days from creation to terminal state. Then the job fails with `EXPIRED` |

Large payloads belong in plugin storage, referenced from `input` (as in the import example).

## State machine

```
            create
              │
              ▼
          ┌────────┐  claim   ┌─────────┐  {done:false}  ┌────────┐
          │ queued │─────────▶│ running │───────────────▶│ queued │ (next step)
          └────────┘          └─────────┘                └────────┘
              ▲                │   │   │
              │ backoff        │   │   └──{done:true}──▶ succeeded
              │                │   └─ throw / lost ─▶ retrying ──(attempts left)──┘
              │                │                         │
              │                │                         └─(maxAttempts reached)─▶ failed
              └── admin retry ─┼─────────────────────── failed
                               └── cancel ─▶ cancelled (after the running step returns)
```

- **Claiming** uses a lease: `running` with `lease_until`, the same pattern as the cron executor's stale-lock recovery. An expired lease returns the step to `retrying` and counts as a failed attempt.
- **Backoff:** `min(5s × 2^(attempt-1), 15 min)` with ±20% jitter.
- **Admin retry** of a `failed` job resets the attempt counter and re-runs the failed step with its last committed cursor.
- **Cancel** is cooperative. A running step is not interrupted. Its result is recorded, but no further step is scheduled.

## Host storage

A new host migration adds a jobs table. It is host-owned and never exposed through plugin storage:

```sql
CREATE TABLE _emdash_plugin_jobs (
	id            TEXT PRIMARY KEY,          -- ulid
	plugin_id     TEXT NOT NULL,
	type          TEXT NOT NULL,
	job_key       TEXT,                      -- idempotency key, nullable
	state         TEXT NOT NULL,
	input         TEXT NOT NULL,             -- JSON
	cursor        TEXT,                      -- JSON
	progress      TEXT,                      -- JSON
	result        TEXT,                      -- JSON
	step          INTEGER NOT NULL DEFAULT 0,
	attempt       INTEGER NOT NULL DEFAULT 0,
	last_error    TEXT,
	run_after     TEXT NOT NULL,             -- ISO time; backoff and delay
	lease_until   TEXT,
	created_at    TEXT NOT NULL,
	updated_at    TEXT NOT NULL,
	finished_at   TEXT,
	expires_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX _emdash_plugin_jobs_key ON _emdash_plugin_jobs (plugin_id, type, job_key)
	WHERE job_key IS NOT NULL;
CREATE INDEX _emdash_plugin_jobs_due ON _emdash_plugin_jobs (state, run_after);
CREATE INDEX _emdash_plugin_jobs_plugin ON _emdash_plugin_jobs (plugin_id, state, created_at);
```

The unique index is a host index enforced by the database, unlike plugin `uniqueIndexes`. It is what makes `create({ key })` idempotent. Terminal jobs are pruned after their type's `retention`. All of a plugin's jobs are deleted when the plugin is uninstalled.

## Execution

The executor is platform-neutral (`JobExecutor`, alongside `CronExecutor`). It needs one operation from the platform: "run step S of job J soon". Two drivers implement it.

### Cloudflare: Queues

- The site declares a queue producer and consumer binding, `EMDASH_JOBS`, in `wrangler.jsonc`. `@emdash-cms/cloudflare/worker` exports a `queue()` handler (`createQueueHandler()`), next to the existing `scheduled()` handler.
- A message carries only `{ jobId, step }`. All state lives in the database, so a duplicate or stale message is detected and dropped: the step no longer matches or the lease is held.
- Each message is consumed in its own invocation, which loads the plugin through Worker Loader and runs one step with the runner's normal limits. **The consumer must process one step per consumer invocation** (`max_batch_size: 1`, or an equivalent guard). Cloudflare's 32-invocations-per-request ceiling applies to the consumer invocation, and one plugin step can use 10 bridge calls plus the loader invocation itself.
- On a `{ done: false }` result the executor commits the cursor and sends the next message, delayed by backoff or `delaySeconds` where applicable. Retries are scheduled by the executor, not by Queues' automatic redelivery, so attempts and backoff behave the same on every platform.
- `ctx.jobs.create()` from a request sends the first message immediately, so the first step typically starts within seconds.

### Fallback (no queue binding) and Node

- The executor claims due jobs from `_emdash_plugin_jobs` on each scheduler tick: the existing `NodeCronScheduler` timer on Node, or the `scheduled()` handler on Cloudflare. It runs claimed steps up to the concurrency caps.
- On Node the executor also wakes when a job is created, and keeps draining while due work remains, so throughput is bounded by concurrency rather than tick frequency.
- On Cloudflare without `EMDASH_JOBS`, throughput is bounded by the cron interval. The admin shows a warning that background jobs are running in degraded mode, with a link to the setup docs.

### Concurrency caps

| Scope | Default | Configurable by |
|---|---|---|
| Per job | 1 step at a time | fixed |
| Per job type | `concurrency` from the manifest | plugin (manifest), capped by operator |
| Per plugin | 8 running steps | operator (`emdash({ jobs: { perPlugin } })`) |
| Per site | 32 running steps | operator (`emdash({ jobs: { perSite } })`) |

## Admin

**Extensions → Jobs** lists jobs across plugins. Filters are plugin, type and state. Each row shows progress (`processed / total`, message), step, attempt, last error, age and next run. Actions are Retry (failed), Cancel (non-terminal) and Delete (terminal). A plugin's detail page shows its own jobs. Failed jobs add a count badge to the Extensions nav item.

## Errors

| Code | Raised by | Meaning |
|---|---|---|
| `UNKNOWN_JOB_TYPE` | `create` | Type not declared in the manifest |
| `INPUT_TOO_LARGE` / `CURSOR_TOO_LARGE` / `RESULT_TOO_LARGE` | `create` / step result | Over the size limits |
| `JOB_QUOTA` | `create` | Too many non-terminal jobs for this plugin |
| `STEP_LIMIT` | executor | Job exceeded 10,000 steps |
| `EXPIRED` | executor | Job exceeded its lifetime |
| `INVALID_STEP_RESULT` | executor | Handler returned something that isn't a `JobStepResult`. Counts as a failed attempt |

Errors thrown by a step are recorded in `last_error` after passing through the existing secret redactor (`secret-redactor.ts`).

# Security Model

- **No new authority.** A step runs with exactly the plugin's declared capabilities and allowed hosts, under the same sandbox and limits as a route or hook. Like cron, it has no `routeCtx.user`. Jobs never act as the user who caused them; a plugin that needs attribution records it in `input`.
- **Isolation between plugins.** Every `ctx.jobs` operation is scoped by the bridge to the calling plugin's id. A plugin cannot create, read, cancel or enumerate another plugin's jobs, and the host table is not reachable through `ctx.storage`.
- **Amplification from public routes.** A public route that creates a job lets an anonymous request trigger background work. Mitigations:
  - the per-plugin non-terminal quota (`JOB_QUOTA`);
  - idempotency keys;
  - per-type concurrency;
  - the step limit and lifetime cap;
  - operator caps.

  The documentation will direct authors to key jobs on a verified identity, such as a webhook event id after signature verification, rather than on raw request input.
- **Data at rest.** `input`, `cursor`, `result` and `last_error` may contain personal data. They live in the host database, are pruned by retention, are deleted on uninstall, and are covered by the site's export and erasure tooling the same way plugin storage is. `last_error` is redacted before storage.
- **Install consent.** Declaring `jobs` lets the plugin run code in the background, not only in response to requests. Whether that needs an explicit consent line is an unresolved question below. Cron, which already allows background execution, requires none today.

# Testing Strategy

- **Executor unit tests** (database-backed, SQLite and Postgres): claiming and leases, the state machine, backoff, the attempt limit, ordering within a job, concurrency caps, idempotent `create` with keys under concurrent calls (Postgres), retention pruning, and cleanup on uninstall.
- **Fault injection:** kill the invocation after the plugin's writes but before the host commit; assert the step re-runs with the same cursor and the job converges. Drop, duplicate and reorder queue messages; assert no step runs twice concurrently and no cursor regresses.
- **Runner conformance:** the same plugin fixture runs to completion on the Node runner, on workerd, and on Cloudflare with and without `EMDASH_JOBS`.
- **Budget:** a fixture step that uses exactly 10 host calls succeeds under Worker Loader. It proves the job bookkeeping consumes none of the plugin's budget.
- **`@emdash-cms/plugin-test` support:** `host.jobs.list()`, `host.jobs.step(id)` to run one step deterministically, `host.jobs.runUntilIdle()`, and `host.jobs.crashAfterNextStep()` to inject a lost result. We also suggest, as a separate improvement, an opt-in `limits: { subrequests: 10 }` mode in the test host, so authors see budget failures locally rather than only after deploying.

# Drawbacks

- **New concepts for plugin authors.** At-least-once delivery and idempotent steps are easy to get subtly wrong. Documentation and the test-host fault injection are essential, not optional.
- **Eventual consistency becomes visible.** Work that used to be "done when the request returns" is "done shortly after". Plugins must model and show intermediate states, such as an order that is paid but still committing stock.
- **Operator setup on Cloudflare.** Full throughput needs a Queues binding in `wrangler.jsonc`. Without it, jobs work but slowly. Templates and `create-emdash` absorb this for new sites; existing sites need a documented change.
- **Platform cost.** Every step is a queue message plus a Worker Loader invocation. Bulk jobs consume Queues operations and Worker invocations on the operator's account.
- **Host surface area.** A new table, executor, transport, admin screen and API to maintain.

# Alternatives

## Make sandbox limits configurable

Letting operators raise the subrequest limit helps moderate cases and is worth doing independently. It doesn't solve unbounded work: an invocation can't exceed Cloudflare's 32-invocations-per-request ceiling whatever the runner allows, and a 500-row import or a 100-line order still doesn't fit. Raising limits also weakens the predictability that makes the sandbox safe to install from a registry.

## Batch and transactional storage primitives

A `compareAndSetMany` or all-or-nothing batch would cut steps per job and simplify many plugins. It reduces the per-item cost but not the proportionality: N items still need about N/k calls. It belongs in a storage RFC and composes well with jobs.

## Build jobs on the existing cron API

This is possible today, and is what plugins will do until this lands. Throughput is one step per job per tick (a minute on Cloudflare), at most 10 tasks per tick run sequentially, the plugin pays for its own bookkeeping on every step, and there are no backoff, terminal failure or admin visibility. The executor in this RFC reuses the cron machinery but fixes these gaps.

## Expose Cloudflare Workflows to plugins

Workflows give durable, resumable steps natively. But they are Cloudflare-only, with no Node equivalent. Workflow steps run in a Worker class the host would define rather than in the plugin's isolate, so every step would still be a sandbox invocation. And their state limits and semantics would leak into the plugin API. A host-owned executor with a Queues transport keeps one API across platforms. Workflows could later be one implementation of the transport.

## Plugin self-invocation over HTTP

A plugin calling its own public route through `ctx.http` gets a fresh budget per hop. It requires network authority to its own origin, exposes internal steps as public endpoints, has no retry or ordering semantics, and counts against the caller's budget. It is a workaround, not a primitive.

# Adoption Strategy

- **Purely additive.** Plugins without `jobs` are unaffected. The manifest field is optional. The current manifest schema is not strict, so an older host would silently ignore a `jobs` declaration, and `ctx.jobs` would be undefined. Authors therefore set `peerDependencies.emdash` to the first host version that supports jobs. Registry installs should also check that the host supports every declared feature, which is a small addition to install-time manifest validation.
- **New sites.** `create-emdash` adds the `EMDASH_JOBS` queue binding whenever sandboxed plugins are enabled. The Cloudflare template's worker exports `queue: createQueueHandler()`.
- **Existing Cloudflare sites.** These work in fallback mode immediately. The admin's degraded-mode warning links to a short guide covering the `wrangler.jsonc` addition and the worker export.
- **Native plugins** get the same `jobs` declaration and `ctx.jobs`. Their steps run in-process with the same contract, so code moves between formats unchanged.

# Implementation Plan

1. **Core (Node and fallback).** The `_emdash_plugin_jobs` migration, `JobExecutor` on the existing scheduler, the `ctx.jobs` bridge methods on both runners, the manifest schema in `@emdash-cms/plugin-types`, and CLI carry-through into bundle, artifact and descriptor. `@emdash-cms/plugin-test` job helpers.
2. **Cloudflare Queues transport.** `createQueueHandler()`, `EMDASH_JOBS` wiring, one step per consumer invocation, template and `create-emdash` updates, and the degraded-mode detection.
3. **Admin.** The Jobs screen, actions and nav badge.
4. **Documentation.** A new "Background jobs" reference in the creating-plugins skill and docs site, with idempotency patterns and worked examples (import, order fan-out, rate-limited sync).

Phase 1 alone unblocks plugin authors. Phases 2 and 3 can ship independently.

# Unresolved Questions

- **Consent.** Should declaring `jobs` add an install-consent line ("runs background jobs"), or is it covered like cron? We lean towards no new capability, because jobs grant no authority beyond the plugin's existing declarations, but a line in the consent summary costs little.
- **Naming.** `jobs` or `tasks`? Cron already uses "task" for scheduled entries, so we propose `jobs` to avoid overloading it.
- **Budget hints.** Should a step receive `budget: { hostCalls }` so plugins can size batches without hard-coding today's limit of 10? This is useful if limits become configurable, and harmless otherwise.
- **Queue delivery versus executor retries.** Should the executor rely on Queues' native retry and delay where possible, or always schedule retries itself for platform parity? This draft chooses parity.
- **Completion signals.** Is polling `ctx.jobs.get()` enough, or should the host emit a `job:completed` / `job:failed` hook to the owning plugin? A hook would let a plugin react (send an email, flag an order) without a polling cron.
- **Defaults.** The step limit, lifetime, quota and caps above are first guesses and should be validated against real plugins.

# Future Possibilities

- **Fan-out and join:** a job that creates child jobs and resumes when they finish, for example committing stock per warehouse in parallel.
- **Partition keys:** serialize jobs that share a key across job ids (all jobs touching one SKU), not only steps within a job.
- **Rate-limited types:** declare `rateLimit: "10/min"` on a job type that calls a third-party API.
- **MCP and CLI access:** list and retry jobs from `emdash` CLI or MCP tools for operators.
- **Cron convergence:** recurring jobs could eventually express what plugins use cron for today, with one executor and one admin screen for all background work.
