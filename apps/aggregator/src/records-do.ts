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

export class RecordsJetstreamDO extends DurableObject<Env> {
	private readonly ingestor: JetstreamIngestor;
	/** Held so the run loop isn't garbage-collected. We never await it
	 * outside `stop()` — `run()` only resolves when `stop()` is called. */
	private readonly runPromise: Promise<void>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.ingestor = new JetstreamIngestor({
			client: new RealJetstreamClient(env.JETSTREAM_URL),
			queue: env.RECORDS_QUEUE,
			storage: wrapDoStorage(state.storage),
		});
		// Fire-and-forget. Run loop is meant to live for the DO's lifetime;
		// errors that escape it indicate a non-recoverable bug we want to
		// see in logs.
		this.runPromise = this.ingestor.run().catch((err) => {
			console.error("[aggregator] jetstream ingestor crashed", err);
		});
	}

	/**
	 * Cron-driven liveness ping. The DO instance is created on first call
	 * (which kicks off the constructor and the run loop) and stays warm as
	 * long as the WebSocket is open. Subsequent pings are no-ops aside from
	 * exercising the ingestor's current cursor as health output.
	 */
	override async fetch(_request: Request): Promise<Response> {
		return Response.json({
			status: "running",
			cursor: this.ingestor.currentCursor,
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
