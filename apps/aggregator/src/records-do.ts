/**
 * Records Jetstream DO: holds a long-lived outbound WebSocket to Jetstream,
 * filters our experimental package collections, and enqueues verification
 * jobs onto the Records Queue.
 *
 * Why a DO at all: outbound WebSockets stay open across requests, but a Worker
 * isolate doesn't. A single DO instance keeps the Jetstream connection alive
 * continuously. The Hibernation API doesn't apply here — it's server-side
 * only, and our connection is outbound.
 *
 * The class skeleton lands first so the wrangler.jsonc binding resolves; the
 * connection + cursor persistence + reconnect backoff logic fills in next.
 */

import { DurableObject } from "cloudflare:workers";

export class RecordsJetstreamDO extends DurableObject<Env> {
	override async fetch(_request: Request): Promise<Response> {
		// Internal admin/debug surface (status, force-reconnect) will land here.
		// For now the DO has no surface — instantiation alone is enough to keep
		// the Jetstream connection alive once the connection logic is in place.
		return new Response("not implemented", { status: 501 });
	}
}
