/**
 * EmDash plugin registry aggregator: Worker entrypoint.
 *
 * Slice 1 ships ingest + read API. Subsequent slices add the labeller (Slice 2),
 * the artifact mirror + web directory (Slice 3), and NSID stabilisation (Slice 4).
 *
 * Reading order for someone learning this code:
 *   1. `env.ts` — the dependency-injection seam. Every external service the
 *      aggregator talks to is bound here.
 *   2. `records-do.ts` — Jetstream connection (PR 2 of Slice 1).
 *   3. `records-consumer.ts` — PDS-verified ingest (PR 3 of Slice 1).
 *   4. `routes/*.ts` — XRPC read endpoints (PR 5 of Slice 1).
 *
 * The fetch/queue/scheduled handlers below are wired but no-op at PR 1.
 * Tests against an empty database round-trip cleanly through them; the smoke
 * test in `test/smoke.test.ts` proves migrations apply and the Worker boots.
 */

import type { RecordsJob } from "./env.js";

export { RecordsJetstreamDO } from "./records-do.js";

export default {
	async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
		// Slice 1 PR 5 wires the XRPC routes here. Until then the only
		// callable surface is the smoke test's database probes.
		return new Response("emdash-aggregator: not yet implemented", {
			status: 503,
			headers: { "content-type": "text/plain" },
		});
	},

	async queue(_batch: MessageBatch<RecordsJob>, _env: Env, _ctx: ExecutionContext): Promise<void> {
		// Slice 1 PR 3 implements PDS-verified ingest here.
	},

	async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
		// Slice 1 PR 4 implements the 6h reconciliation pass here.
	},
};
