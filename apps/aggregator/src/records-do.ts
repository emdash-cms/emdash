/**
 * Records Jetstream DO: holds a long-lived outbound WebSocket to Jetstream,
 * filters our experimental package collections, and enqueues verification
 * jobs onto the Records Queue.
 *
 * Why a DO at all: outbound WebSockets stay open across requests, but a
 * Worker isolate doesn't. A single DO instance keeps the connection alive
 * continuously. The Hibernation API doesn't apply here — it's server-side
 * only, and our connection is outbound.
 *
 * The DO is thin by design — all the loop / cursor / backoff logic lives in
 * `JetstreamIngestor`. The DO just wires real bindings into the ingestor;
 * its `fetch` handler returns the current ingestor status for the
 * `/_admin/start` bootstrap path and any later admin/status surface.
 */

import { DurableObject } from "cloudflare:workers";

import { RealJetstreamClient } from "./jetstream-client.js";
import { JetstreamIngestor, type IngestorStorage } from "./jetstream-ingestor.js";

/** Singleton DO ID. There's exactly one ingestor per deployment. */
export const RECORDS_DO_NAME = "main";

export class RecordsJetstreamDO extends DurableObject {
	private readonly ingestor: JetstreamIngestor;
	/** Held so the run loop isn't garbage-collected. */
	private readonly runPromise: Promise<void>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.ingestor = new JetstreamIngestor({
			client: new RealJetstreamClient(env.JETSTREAM_URL),
			queue: env.RECORDS_QUEUE,
			storage: wrapDoStorage(state.storage),
		});
		// Fire-and-forget. The run loop absorbs every error path internally
		// today (transient queue failures, connection drops, parse errors
		// all retry with backoff). The catch is here defensively — if a
		// future change introduces a non-recoverable rejection, we want it
		// in the logs rather than as an unhandled promise.
		this.runPromise = this.ingestor.run().catch((err) => {
			console.error("[aggregator] jetstream ingestor crashed", err);
		});
	}

	/**
	 * Status surface for the `/_admin/start` bootstrap and the 5-minute cron
	 * liveness pump. Idempotent — calling it on an already-running DO just
	 * reports the current cursor and consecutive-failure count. `0` means
	 * the most recent connection attempt produced at least one event; a
	 * non-zero value indicates the latest reconnect cycle hasn't yet
	 * delivered an event (Jetstream unreachable, wantedCollections
	 * mismatch, or queue backpressure).
	 *
	 * The bootstrap route in the worker doesn't proxy this body — it
	 * fires-and-forgets the DO fetch and returns 204 — so this surface is
	 * effectively internal to the DO + cron pump.
	 */
	override async fetch(_request: Request): Promise<Response> {
		return Response.json({
			cursor: this.ingestor.currentCursor,
			consecutiveFailures: this.ingestor.consecutiveFailures,
		});
	}
}

/**
 * Adapt the workerd `DurableObjectStorage` (Promise-based key/value with
 * unknown values) to the narrow `IngestorStorage` shape (string→number).
 * Keeping the adaptation here means the ingestor stays free of workerd
 * imports and the DO is the only place that needs to know about storage's
 * type-erasure.
 */
function wrapDoStorage(storage: DurableObjectStorage): IngestorStorage {
	return {
		async get(key: string): Promise<number | undefined> {
			const value = await storage.get<number>(key);
			return typeof value === "number" ? value : undefined;
		},
		async put(key: string, value: number): Promise<void> {
			await storage.put(key, value);
		},
	};
}
