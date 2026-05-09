/**
 * Records Jetstream DO: holds a long-lived outbound WebSocket to Jetstream,
 * filters our experimental package collections, and enqueues verification
 * jobs onto the Records Queue.
 *
 * Slice 1 PR 1 (this commit) ships the DO class skeleton only — no WebSocket
 * connection, no event handling. The wrangler.jsonc binding refers to this
 * class; PR 2 fills in the connection + cursor persistence + reconnect
 * backoff logic.
 *
 * Why a DO at all: outbound WebSockets stay open across requests, but a Worker
 * isolate doesn't. A single DO instance keeps the Jetstream connection alive
 * continuously. The Hibernation API doesn't apply here — it's server-side
 * only, and our connection is outbound.
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.js";

export class RecordsJetstreamDO extends DurableObject<Env> {
	override async fetch(_request: Request): Promise<Response> {
		// PR 2: handle internal admin/debug requests (e.g. status, force-reconnect).
		// For now the DO has no surface — instantiation alone is enough to keep
		// the Jetstream connection alive (PR 2 starts it from `ctx.blockConcurrencyWhile`).
		return new Response("not implemented", { status: 501 });
	}
}
